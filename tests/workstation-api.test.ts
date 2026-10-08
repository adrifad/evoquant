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

const symbol = "BTC-USDT-SWAP";
const json = <T>(response: Response): Promise<T> => response.json() as Promise<T>;
type RiskResponse = ReturnType<RuntimeRiskService["snapshot"]> & { audit: Array<{ payload: string }> };
async function fixture(t: test.TestContext) {
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
    evolution: { enabled: true, reviewEvery: true, signalInterval: 8, strategyInterval: 15, minSample: 20, maxWeightChangePct: 5, maxParamChanges: 1 } });
  t.after(() => { server.close(); store.close(); rmSync(root, { recursive: true, force: true }); });
  await new Promise<void>(resolve => setImmediate(resolve));
  const base = `http://127.0.0.1:${server.address()!.port}`;
  const request = (route: string, init?: RequestInit) => fetch(base + route, init);
  return { store, risk, request, base, exchangeRequests: () => exchangeRequests };
}

test("risk API rejects ceilings, cross-origin writes and stale revisions; commits audited hot settings", async t => {
  const f = await fixture(t);
  const initial = await json<RiskResponse>(await f.request("/api/risk"));
  const put = (body: unknown, origin?: string) => f.request("/api/risk", { method: "PUT",
    headers: { "content-type": "application/json", ...(origin ? { origin } : {}) }, body: JSON.stringify(body) });
  const invalid = await put({ revision: initial.revision, limits: { ...initial.limits, max_leverage: 25 }, confirmRiskIncrease: true });
  assert.equal(invalid.status, 400);
  assert.equal((await json<{ error: string }>(invalid)).error, "Maximum allowed leverage is 10x.");
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
