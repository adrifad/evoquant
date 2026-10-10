import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { startDashboard } from "../src/core/dashboard.ts";
import { loadRiskConfig, loadTradingConfig } from "../src/core/config.ts";
import { RuntimeRiskService } from "../src/core/runtime-risk.ts";
import { openStore, logSystemEvent } from "../src/memory/db.ts";
import { persistCandles } from "../src/execution/executor.ts";
import { ensureV2Registry, createV2Challenger, listV2Versions, transitionV2Version } from "../src/strategy/v2-registry.ts";
import { DEFAULT_V2_PARAMS } from "../src/strategy/core-v2.ts";
import { scannerProjection, type evolutionFamilies } from "../src/core/workstation.ts";
import type { ScanRow } from "../src/strategy/scanner.ts";
import type { ExecutorDeps } from "../src/execution/executor.ts";
import type { WatchlistProjection } from "../src/market/dynamic-watchlist.ts";

const symbol = "BTC-USDT-SWAP";
const json = <T>(response: Response): Promise<T> => response.json() as Promise<T>;
type RiskResponse = ReturnType<RuntimeRiskService["snapshot"]> & { audit: Array<{ payload: string }> };
async function fixture(t: test.TestContext, dynamicWatchlist?: { projection(): WatchlistProjection; refreshManual(): Promise<WatchlistProjection> }) {
  const root = mkdtempSync(path.join(os.tmpdir(), "evoq-workstation-api-"));
  const store = openStore(root), risk = loadRiskConfig(), trading = loadTradingConfig();
  ensureV2Registry(store);
  let exchangeRequests = 0;
  const deps = { store, risk, trading, instruments: {}, watchlist: [symbol], client: {
    get: async () => { exchangeRequests++; throw new Error("offline fixture"); },
    post: async () => { throw new Error("No orders permitted in API fixture"); },
  } } as unknown as ExecutorDeps;
  const server = startDashboard({ port: 0, trading, risk, runtimeRisk: new RuntimeRiskService({ store, risk }),
    deps: () => deps, strategyCoreVersion: 2, getLastTick: () => null, getScan: () => [], getKillReason: () => null,
    evolution: { enabled: true, reviewEvery: true, signalInterval: 8, strategyInterval: 15, minSample: 20, maxWeightChangePct: 5, maxParamChanges: 1 }, ...(dynamicWatchlist ? { dynamicWatchlist } : {}) });
  t.after(() => { server.close(); store.close(); rmSync(root, { recursive: true, force: true }); });
  await new Promise<void>(resolve => setImmediate(resolve));
  const base = `http://127.0.0.1:${server.address()!.port}`;
  const request = (route: string, init?: RequestInit) => fetch(base + route, init);
  return { store, risk, request, base, exchangeRequests: () => exchangeRequests };
}

test("watchlist API reports a persisted projection and manual refresh remains same-origin", async t => {
  let manual = 0;
  const projection = (): WatchlistProjection => ({ generated_at: "2026-10-10T00:15:00.000Z", stale: false, stale_age_ms: 0, next_refresh: "2026-10-11T00:15:00.000Z",
    status: "CURRENT", core: [{ symbol, kind: "CORE" }], dynamic: [{ rank: 1, symbol: "SUI-USDT-SWAP", score: 81.2, trend_direction: "BULLISH", metrics: { momentum1hPct: 1, momentum4hPct: 3, adx14: 30, emaSeparationPct: 1, relativeVolume: 1.2, spreadPct: 0.1, liquidityUsdt: 2_000_000 }, status: "DYNAMIC" }], active: [symbol, "SUI-USDT-SWAP"], statistics: { discovered: 9, basic: 2, analyzed: 2, qualifying: 1, selected: 1, requestCount: 4, durationMs: 10 } });
  const f = await fixture(t, { projection, refreshManual: async () => { manual++; return projection(); } });
  const get = await json<{ dynamic: Array<{ symbol: string }> }>(await f.request("/api/watchlist"));
  assert.equal(get.dynamic[0]!.symbol, "SUI-USDT-SWAP");
  assert.equal((await f.request("/api/watchlist", { method: "POST", headers: { origin: "https://external.invalid" } })).status, 403);
  assert.equal((await f.request("/api/watchlist", { method: "POST" })).status, 200);
  assert.equal(manual, 1);
});

test("risk API rejects ceilings, cross-origin writes and stale revisions; commits audited hot settings", async t => {
  const f = await fixture(t);
  const initial = await json<RiskResponse>(await f.request("/api/risk"));
  const put = (body: unknown, origin?: string) => f.request("/api/risk", { method: "PUT",
    headers: { "content-type": "application/json", ...(origin ? { origin } : {}) }, body: JSON.stringify(body) });
  const invalid = await put({ revision: initial.revision, limits: { ...initial.limits, max_leverage: 25 }, confirmRiskIncrease: true });
  assert.equal(invalid.status, 400);
  assert.equal((await json<{ error: string }>(invalid)).error, "Maximum allowed leverage is 5x.");
  const limits = { ...initial.limits, max_leverage: 2, max_concurrent_positions: 1 };
  assert.equal((await put({ revision: 0, limits }, "https://external.invalid")).status, 403);
  assert.equal((await put({ revision: 0, limits }, f.base)).status, 200);
  assert.equal(f.risk.hard_limits.max_leverage, 2);
  assert.equal((await put({ revision: 0, limits })).status, 409);
  const saved = await json<RiskResponse>(await f.request("/api/risk"));
  assert.equal(saved.revision, 1);
  assert.equal(saved.audit.length, 2);
  assert.ok(saved.audit.every((row: { payload: string }) => JSON.parse(row.payload).source === "dashboard"));
  assert.equal((await put({ revision: 1, limits: initial.limits })).status, 400, "risk increases require confirmation");
  assert.equal(f.exchangeRequests(), 0, "risk changes must not resize positions or call exchange");
});

test("risk API enforces 2 percent trade and 5 percent portfolio ceilings", async t => {
  const f = await fixture(t);
  const initial = await json<RiskResponse>(await f.request("/api/risk"));
  assert.equal(initial.ceilings.risk_per_trade_pct, 2);
  assert.equal(initial.ceilings.max_portfolio_open_risk_pct, 5);
  assert.equal(initial.limits.risk_per_trade_pct, 2, "raising the ceiling never raises active risk automatically");
  const put = (limits: Record<string, unknown>, confirmRiskIncrease = false, revision = 0) => f.request("/api/risk", {
    method: "PUT", headers: { "content-type": "application/json" },
    body: JSON.stringify({ revision, limits, confirmRiskIncrease }),
  });
  const overTrade = await put({ ...initial.limits, risk_per_trade_pct: 2.01 }, true);
  assert.equal(overTrade.status, 400);
  assert.equal((await json<{ error: string }>(overTrade)).error, "Maximum allowed risk per trade is 2%.");
  const atPortfolioCeiling = { ...initial.limits, max_portfolio_open_risk_pct: 5 };
  assert.equal((await put(atPortfolioCeiling)).status, 400, "loosening portfolio risk requires confirmation");
  assert.equal((await put(atPortfolioCeiling, true)).status, 200);
  const overPortfolio = await put({ ...atPortfolioCeiling, max_portfolio_open_risk_pct: 5.01 }, true, 1);
  assert.equal(overPortfolio.status, 400);
  assert.equal((await json<{ error: string }>(overPortfolio)).error, "Maximum allowed portfolio open risk is 5%.");
  assert.equal(f.risk.hard_limits.risk_per_trade_pct, 2);
  assert.equal(f.risk.hard_limits.max_portfolio_open_risk_pct, 5);
  assert.equal(f.exchangeRequests(), 0);
});

test("offline account stays unavailable and shared snapshots bound exchange requests", async t => {
  const f = await fixture(t);
  const [a, b] = await Promise.all([f.request("/api/status"), f.request("/api/trades")]);
  const status = await json<{ equity: null; capital: { margin_used: null }; exchangeState: string }>(a); await b.json();
  assert.equal(status.equity, null);
  assert.equal(status.capital.margin_used, null);
  assert.equal(status.exchangeState, "UNAVAILABLE");
  assert.equal(f.exchangeRequests(), 2, "balance and positions are fetched once for concurrent views");
  await f.request("/api/status");
  assert.equal(f.exchangeRequests(), 2);
});

test("normal settings reads never discover provider models and explicit refresh is cached", async t => {
  const previousUrl = process.env.LLM_BASE_URL;
  const previousKey = process.env.LLM_API_KEY;
  const originalFetch = globalThis.fetch;
  let modelRequests = 0;
  process.env.LLM_BASE_URL = "https://models.fixture.invalid/v1";
  process.env.LLM_API_KEY = "fixture-key";
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    if (String(input) === "https://models.fixture.invalid/v1/models") {
      modelRequests += 1;
      assert.equal(init?.headers instanceof Headers ? init.headers.get("authorization") : (init?.headers as Record<string, string>)?.Authorization, "Bearer fixture-key");
      return new Response(JSON.stringify({ data: [{ id: "fixture-model" }] }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return originalFetch(input, init);
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
    if (previousUrl === undefined) delete process.env.LLM_BASE_URL; else process.env.LLM_BASE_URL = previousUrl;
    if (previousKey === undefined) delete process.env.LLM_API_KEY; else process.env.LLM_API_KEY = previousKey;
  });
  const f = await fixture(t);
  await Promise.all([f.request("/api/settings"), f.request("/api/settings"), f.request("/api/settings")]);
  assert.equal(modelRequests, 0, "dashboard polling must not hit provider /models");
  const first = await f.request("/api/settings/models/refresh", { method: "POST" });
  assert.equal(first.status, 200);
  assert.equal(modelRequests, 1);
  assert.deepEqual((await json<{ models: string[]; cached: boolean }>(first)).models, ["fixture-model"]);
  const second = await f.request("/api/settings/models/refresh", { method: "POST" });
  assert.equal(second.status, 200);
  assert.equal((await json<{ cached: boolean }>(second)).cached, true);
  assert.equal(modelRequests, 1, "second explicit refresh uses the thirty-minute cache");
});

test("candles remain isolated by instrument and timeframe, bounded and explicit when unavailable", async t => {
  const f = await fixture(t);
  const ts = Date.now();
  for (const [bar, price] of [["1m", 100], ["5m", 200]] as const) persistCandles(f.store, symbol, bar,
    [0, 1].map(i => ({ ts: ts - i * 60_000, o: price, h: price + 1, l: price - 1, c: price, vol: 10, volCcy: 10, confirm: "1" as const })));
  const minute = await json<Array<{ c: number }>>(await f.request(`/api/candles?instId=${symbol}&bar=1m`));
  assert.ok(minute.every((c: { c: number }) => c.c === 100));
  assert.equal((await f.request(`/api/candles?instId=${symbol}&bar=5m`)).status, 200);
  assert.equal((await f.request(`/api/candles?instId=${symbol}&bar=1H`)).status, 503);
  f.store.db.prepare(`INSERT INTO trades(trade_id,status,instrument,timeframe,side,strategy,strategy_version,regime,contracts,entry_ts,exit_ts)
    VALUES('REPLAY','CLOSED',?,'1m','LONG','TREND_FOLLOWING',2,'SIDEWAYS','1',?,?)`)
    .run(symbol, new Date(ts - 60_000).toISOString(), new Date(ts).toISOString());
  const replay = await json<Array<{ c: number }>>(await f.request(`/api/candles?tradeId=REPLAY&instId=${symbol}&bar=1m`));
  assert.equal(replay.length, 2);
  assert.ok(replay.every((c: { c: number }) => c.c === 100));
  assert.deepEqual(await (await f.request(`/api/candles?tradeId=REPLAY&instId=${symbol}&bar=1H`)).json(), [], "missing historical timeframe must not substitute current candles");
  assert.equal((await f.request(`/api/candles?tradeId=MISSING&instId=${symbol}&bar=1m`)).status, 404);
  for (const query of ["bar=2m", "limit=401", "limit=1", "limit=NaN", "instId=UNKNOWN-USDT-SWAP"]) {
    assert.equal((await f.request(`/api/candles?${query}`)).status, 400);
  }
});

test("proposal context survives shadow and atomic promotion, and family API retains provenance", async t => {
  const f = await fixture(t);
  const proposal = { evidenceCutoffTs: "2026-01-01T00:00:00.000Z", sample: 31, criticVerdict: "ACCEPT", criticModel: "fixture-critic", evolutionModel: "fixture-evolution" };
  const strategy = "TREND_FOLLOWING_V2";
  const version = createV2Challenger(f.store, { strategy, parentVersion: 2,
    params: { ...DEFAULT_V2_PARAMS.TREND_FOLLOWING_V2, max_extension_atr: 1.1 },
    changedParameter: "max_extension_atr", oldValue: 1.2, newValue: 1.1, hypothesis: "Retain evidence across validation", evidence: proposal });
  transitionV2Version(f.store, strategy, version, "SHADOW", "historical passed", { state: "SHADOW" });
  const evolution = await json<{ families: ReturnType<typeof evolutionFamilies> }>(await f.request("/api/evolution"));
  assert.equal(evolution.families.length, 3);
  const family = evolution.families.find(row => row.family === "TREND_FOLLOWING")!;
  assert.equal(family.challenger!.status, "SHADOW");
  assert.deepEqual(JSON.parse(family.challenger!.evidence!), { ...proposal, validation: { state: "SHADOW" } });
  assert.ok(evolution.families.filter((row: { family: string }) => row.family !== "TREND_FOLLOWING").every((row: { challenger: unknown }) => row.challenger === null));
  transitionV2Version(f.store, strategy, version, "PROMOTED", "matched evidence passed", { state: "PROMOTED", reasons: ["net expectancy improved"] });
  const champion = listV2Versions(f.store, strategy).find(row => row.status === "CHAMPION")!;
  assert.equal(champion.version, version);
  const evidence = JSON.parse(champion.evidence!);
  assert.equal(evidence.evidenceCutoffTs, proposal.evidenceCutoffTs);
  assert.equal(evidence.criticModel, proposal.criticModel);
  assert.equal(evidence.validation.state, "PROMOTED");
});

test("scanner separates deterministic setups, Gate denial and unevaluated candidates", async t => {
  const f = await fixture(t);
  const since = new Date(Date.now() - 1000).toISOString();
  const row = { instrument: symbol, regime: "SIDEWAYS", price: 100, score: 0.8, strategy: "TREND_FOLLOWING_V2", tradable: true } as ScanRow;
  assert.equal(scannerProjection(f.store, [row], since)[0]!.state, "CANDIDATE");
  logSystemEvent(f.store, "LLM_GATE_DENY", { instrument: symbol, reasoning: ["Late extension"] });
  const denied = scannerProjection(f.store, [row], since)[0]!;
  assert.equal(denied.state, "GATE_DENIED");
  assert.equal(denied.risk, "NOT_EVALUATED");
  assert.deepEqual(denied.reason, ["Late extension"]);
  assert.equal(scannerProjection(f.store, [{ ...row, tradable: false }], since)[0]!.state, "NO_SETUP");
  assert.equal(scannerProjection(f.store, [row], new Date(Date.now() + 1000).toISOString())[0]!.gate, "NOT_EVALUATED", "old Gate decisions cannot label a new cycle");
  logSystemEvent(f.store, "LLM_GATE_ALLOW", { instrument: symbol });
  f.store.db.prepare("INSERT INTO decisions(decision_id,ts,instrument,decision,risk_verdict) VALUES('INITIAL',?,?,'LONG',?)")
    .run(new Date().toISOString(), symbol, JSON.stringify({ approved: true }));
  logSystemEvent(f.store, "RISK_EVENT", { instId: symbol, race_guard: "entry skipped after refreshed global risk check", reason: "RISK_SETTINGS_CHANGED" });
  const final = scannerProjection(f.store, [row], since)[0]!;
  assert.equal(final.state, "RISK_REJECTED");
  assert.equal(final.risk, "REJECTED");
  assert.deepEqual(final.reason, ["RISK_SETTINGS_CHANGED"]);
});
