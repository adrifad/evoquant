import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ABSOLUTE_MAX, loadRiskConfig, loadTradingConfig } from "../src/core/config.ts";
import { RuntimeTradingService, RUNTIME_TRADING_KEY, RuntimeTradingError } from "../src/core/runtime-trading.ts";
import { RuntimeRiskService, unresolvedEntry } from "../src/core/runtime-risk.ts";
import { openStore, kvGet, kvSet } from "../src/memory/db.ts";
import { startDashboard } from "../src/core/dashboard.ts";
import { runTick, type TickContext, type ExecutorDeps } from "../src/execution/executor.ts";
import { ScalpRunner } from "../src/scalp/runner.ts";
import { SCALP_DEFAULTS, type ScalpSignal } from "../src/scalp/signals.ts";
import { setBotState, setEmergencyHalted } from "../src/core/state.ts";
import type { InstrumentInfo } from "../src/exchange/okx/types.ts";
import type { OkxClient } from "../src/exchange/okx/client.ts";
import type { FeatureSnapshot } from "../src/market/features.ts";
import type { RoleLlmService } from "../src/core/llm-role-service.ts";

const symbol = "BTC-USDT-SWAP", second = "ETH-USDT-SWAP";
function fixture(t: test.TestContext) {
  const root = mkdtempSync(path.join(os.tmpdir(), "evoq-runtime-trading-"));
  const store = openStore(root), trading = loadTradingConfig(), risk = loadRiskConfig();
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  trading.instrument.id = symbol;
  Object.assign(trading.leverage, { default: 5, hard_max: 5 });
  Object.assign(trading.sizing, { mode: "percent_of_equity", position_pct: 20 });
  risk.hard_limits.allowed_symbols = [symbol, second];
  risk.hard_limits.max_leverage = 5;
  const service = new RuntimeTradingService({ store, trading, risk, instruments: [symbol, second, "UNALLOWED"] });
  return { root, store, trading, risk, service };
}

test("trading strictly validates complete finite settings within the absolute ceilings", t => {
  const { service, store } = fixture(t);
  const initial = service.snapshot();
  const invalid = [
    { ...initial.settings, unknown: 1 }, { instrument_id: symbol },
    { ...initial.settings, leverage_default: "3" }, { ...initial.settings, leverage_default: 1.5 },
    { ...initial.settings, leverage_default: NaN }, { ...initial.settings, leverage_cap: Infinity },
    { ...initial.settings, leverage_cap: ABSOLUTE_MAX.leverage + 1 },
    { ...initial.settings, leverage_default: 0 }, { ...initial.settings, leverage_cap: 0 },
    { ...initial.settings, leverage_default: 6 },
    { ...initial.settings, position_pct: NaN }, { ...initial.settings, position_pct: Infinity },
    { ...initial.settings, position_pct: 0.09 }, { ...initial.settings, position_pct: 100.01 },
    { ...initial.settings, sizing_mode: "fixed" }, { ...initial.settings, instrument_id: "UNALLOWED" },
    { ...initial.settings, instrument_id: "NO_METADATA" },
    { ...initial.settings, environment: "live" }, { ...initial.settings, timeframe: "1m" },
  ];
  for (const settings of invalid) assert.throws(() => service.update({ revision: 0, settings, confirmIncrease: true }));
  assert.throws(() => service.update({ revision: 0, settings: initial.settings, source: "agent" }));
  assert.deepEqual(service.snapshot(), initial);
  assert.equal(kvGet(store, RUNTIME_TRADING_KEY), null);
});

test("absolute trading leverage ceiling and allocation endpoints remain bounded by effective risk leverage", t => {
  const { service } = fixture(t);
  const high = service.update({ revision: 0, confirmIncrease: true, settings: {
    ...service.snapshot().settings, leverage_default: ABSOLUTE_MAX.leverage,
    leverage_cap: ABSOLUTE_MAX.leverage, position_pct: 100,
  } });
  assert.equal(high.effective_leverage, 5);
  const low = service.update({ revision: 1, settings: {
    ...high.settings, leverage_default: 1, leverage_cap: 1, position_pct: 0.1,
  } });
  assert.equal(low.effective_leverage, 1);
  assert.equal(low.settings.position_pct, 0.1);
});

test("all leverage and allocation increases plus any sizing mode change require boolean confirmation", t => {
  const { service } = fixture(t);
  const settings = service.snapshot().settings;
  for (const change of [{ leverage_default: 6, leverage_cap: 6 }, { leverage_cap: 6 },
    { position_pct: 21 }, { sizing_mode: "risk_based" }]) {
    for (const confirmIncrease of [undefined, false, "true", 1]) {
      assert.throws(() => service.update({ revision: 0, settings: { ...settings, ...change }, confirmIncrease }));
    }
  }
  service.update({ revision: 0, settings: { ...settings, sizing_mode: "risk_based" }, confirmIncrease: true });
  assert.throws(() => service.update({ revision: 1, settings }), /confirmIncrease/);
  const saved = service.update({ revision: 1, settings, confirmIncrease: true });
  assert.equal(saved.revision, 2);
});

test("updates preserve nested identities, audit each field, compare revisions and skip no-op writes", t => {
  const f = fixture(t);
  const { trading, risk, store, service } = f;
  const instrument = trading.instrument, leverage = trading.leverage, sizing = trading.sizing;
  const other = new RuntimeTradingService({ store, trading: structuredClone(trading), risk, instruments: [symbol, second] });
  const settings = { ...service.snapshot().settings, instrument_id: second, leverage_default: 3, position_pct: 10 };
  const saved = service.update({ revision: 0, settings });
  assert.equal(trading.instrument, instrument); assert.equal(trading.leverage, leverage); assert.equal(trading.sizing, sizing);
  assert.equal(saved.revision, 1); assert.equal(saved.effective_leverage, 3);
  assert.equal(saved.audit.length, 3);
  const rows = saved.audit as Array<{ ts: string; payload: string }>;
  for (const row of rows) {
    const event = JSON.parse(row.payload);
    assert.equal(event.source, "dashboard"); assert.equal(event.revision, 1); assert.equal(event.timestamp, row.ts);
    assert.equal(event.newValue, settings[event.field as keyof typeof settings]);
    assert.equal(event.oldValue, { instrument_id: symbol, leverage_default: 5, position_pct: 20 }[event.field as "instrument_id" | "leverage_default" | "position_pct"]);
  }
  assert.throws(() => other.update({ revision: 0, settings }), /reload before saving/);
  assert.throws(() => service.update({ revision: 0, settings }), /reload before saving/);
  assert.deepEqual(service.update({ revision: 1, settings }), saved);
  const tightenedRisk = new RuntimeRiskService({ store, risk });
  tightenedRisk.update({ revision: 0, limits: { ...tightenedRisk.snapshot().limits, max_leverage: 2 } });
  assert.equal(service.snapshot().effective_leverage, 2);
  assert.deepEqual(service.snapshot().constraints.instruments, [symbol, second]);
  assert.equal(service.snapshot().timeframe, trading.timeframe);
  assert.equal(service.snapshot().margin_mode, "isolated");
  assert.equal(service.snapshot().position_mode, "long_short_mode");
  assert.equal(trading.environment, "demo");
});

test("audit failure rolls back persistence, revision and every live setting", t => {
  const { service, store, trading } = fixture(t);
  const original = service.snapshot(), identity = trading.sizing;
  store.db.exec(`CREATE TRIGGER reject_trading_audit BEFORE INSERT ON system_events
    WHEN NEW.kind='TRADING_SETTING_CHANGED' AND json_extract(NEW.payload,'$.field')='position_pct'
    BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END;`);
  assert.throws(() => service.update({ revision: 0,
    settings: { ...original.settings, leverage_default: 3, position_pct: 10 } }), /audit unavailable/);
  assert.deepEqual(service.snapshot(), original);
  assert.equal(trading.sizing, identity);
  assert.equal(kvGet(store, RUNTIME_TRADING_KEY), null);
});

test("restart restores trading settings and invalid persisted settings fail closed", t => {
  const { service, store, risk, root } = fixture(t);
  const saved = service.update({ revision: 0, settings: { ...service.snapshot().settings,
    instrument_id: second, leverage_default: 2, position_pct: 0.1 } });
  const restartedStore = openStore(root);
  try {
    const restarted = new RuntimeTradingService({ store: restartedStore, trading: loadTradingConfig(), risk, instruments: [symbol, second] });
    assert.deepEqual(restarted.snapshot(), saved);
  } finally { restartedStore.close(); }
  for (const settings of [{ ...saved.settings, leverage_default: 11 },
    { ...saved.settings, instrument_id: "NO_METADATA" }, { ...saved.settings, position_pct: Infinity }]) {
    kvSet(store, RUNTIME_TRADING_KEY, JSON.stringify({ revision: 1, settings }));
    assert.throws(() => new RuntimeTradingService({ store, trading: loadTradingConfig(), risk, instruments: [symbol, second] }));
  }
  kvSet(store, RUNTIME_TRADING_KEY, "not json");
  assert.throws(() => new RuntimeTradingService({ store, trading: loadTradingConfig(), risk, instruments: [symbol, second] }));
});

test("trading API supplies audited settings and rejects cross-origin, invalid and stale writes without exchange requests", async t => {
  const f = fixture(t);
  let exchangeRequests = 0;
  const deps = { ...f, instruments: {}, watchlist: [symbol, second], client: {
    get: async () => { exchangeRequests++; throw new Error("No exchange requests permitted"); },
    post: async () => { exchangeRequests++; throw new Error("No exchange writes permitted"); },
  } } as unknown as ExecutorDeps;
  const server = startDashboard({ port: 0, trading: f.trading, risk: f.risk, runtimeTrading: f.service,
    deps: () => deps, getLastTick: () => null, getKillReason: () => null, getScan: () => [],
    evolution: { reviewEvery: true, signalInterval: 20, strategyInterval: 50, minSample: 30, maxWeightChangePct: 10, maxParamChanges: 2 } });
  t.after(() => server.close());
  await new Promise<void>(resolve => setImmediate(resolve));
  const url = `http://127.0.0.1:${server.address()!.port}/api/trading`;
  const initial = await (await fetch(url)).json();
  assert.deepEqual(initial, f.service.snapshot());
  const put = (body: unknown, headers?: Record<string, string>) => fetch(url, { method: "PUT",
    headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  const body = { revision: 0, settings: { ...initial.settings, leverage_default: 2 } };
  assert.equal((await put(body, { origin: "https://external.invalid" })).status, 403);
  assert.equal((await put(body, { "sec-fetch-site": "cross-site" })).status, 403);
  assert.equal((await put({ revision: 0, settings: { ...body.settings, leverage_cap: 11 } })).status, 400);
  assert.equal((await put(body, { origin: new URL(url).origin })).status, 200);
  const conflict = await put(body);
  assert.equal(conflict.status, 409);
  assert.equal((await conflict.json() as { code: string }).code, "TRADING_REVISION_CONFLICT");
  const saved = await (await fetch(url)).json() as { revision: number; audit: unknown[] };
  assert.equal(saved.revision, 1); assert.equal(saved.audit.length, 1);
  assert.equal((await fetch(url, { method: "POST" })).status, 405);
  assert.equal(exchangeRequests, 0);
});

const meta: InstrumentInfo = { instId: symbol, tickSz: "0.01", lotSz: "1", minSz: "1", ctVal: "0.001", ctValCcy: "BTC" };
const features = { ts: 0, instrument: symbol, price: 100, atr14: 1, atrPct: 1, ema20: 101, ema50: 100,
  emaSpreadPct: 1, rsi14: 60, adx14: 30, volume: 100, volumeSma20: 100, volumeRatio: 1.2, sufficientData: true } satisfies FeatureSnapshot;
const signal: ScalpSignal = { instrument: symbol, direction: 1, score: 0.9, price: 100,
  stopPx: 98, tpPx: 104, atr: 1, reason: "fixture", regime: "TRENDING_BULLISH", ts: 0 };

function executionFixture(t: test.TestContext, onLeverage?: () => void) {
  const f = fixture(t);
  f.risk.hard_limits.max_concurrent_positions = 1;
  const positions: Array<Record<string, string>> = [], writes: Array<{ url: string; body: Record<string, string> }> = [];
  const client = {
    get: async (url: string) => {
      if (url.endsWith("/balance")) return [{ totalEq: "100", details: [{ ccy: "USDT", eq: "100", availEq: "100" }] }];
      if (url.endsWith("/positions")) return structuredClone(positions);
      if (url.endsWith("/time")) return [{ ts: String(Date.now()) }];
      if (url.endsWith("/orders-pending") || url.endsWith("/fills")) return [];
      if (url.endsWith("/order")) return [{ ordId: "O1", instId: symbol, state: "filled", avgPx: "100", lever: "3", accFillSz: "200", sz: "200" }];
      throw new Error(`unexpected fake GET ${url}`);
    },
    post: async (url: string, body: Record<string, string>) => {
      writes.push({ url, body });
      if (url.endsWith("/set-leverage")) { onLeverage?.(); return [body]; }
      if (url.endsWith("/order")) {
        assert.equal(unresolvedEntry(f.store)?.clOrdId, body.clOrdId);
        positions.push({ instId: body.instId!, posSide: body.posSide!, pos: body.sz!, avgPx: "100", markPx: "100", lever: "4", margin: "5", mgnMode: "isolated" });
        return [{ ordId: "O1", sCode: "0" }];
      }
      if (url.endsWith("/order-algo")) return [{ algoId: "A1", sCode: "0" }];
      throw new Error(`unexpected fake POST ${url}`);
    },
  } as unknown as OkxClient;
  const deps = { ...f, client, instruments: { [symbol]: meta, [second]: { ...meta, instId: second } }, watchlist: [symbol, second] };
  setBotState(f.store, "RUNNING"); setEmergencyHalted(f.store, false);
  const runner = new ScalpRunner({ ...deps, cfg: { ...SCALP_DEFAULTS, position_pct: 20 }, llm: {} as RoleLlmService });
  const ctx: TickContext = { features, regime: "TRENDING_BULLISH",
    strategies: [{ name: "TREND_FOLLOWING", version: 1 } as TickContext["strategies"][number]],
    decideFn: async () => ({ decision: "LONG", strategy: "TREND_FOLLOWING_V1", confidence: 1,
      suggested_stop_atr: 2, suggested_take_profit_atr: 4, thesis: ["fixture"], invalidations: [] }) };
  return { ...deps, writes,
    openSwing: () => runTick(deps, ctx, { instId: symbol, meta }),
    openScalp: () => (runner as unknown as { openScalp(s: ScalpSignal, f: FeatureSnapshot): Promise<void> }).openScalp(signal, features),
  };
}

for (const engine of ["openSwing", "openScalp"] as const) {
  for (const change of [{ leverage_default: 2 }, { position_pct: 10 }, { sizing_mode: "risk_based" as const }]) {
    test(`${engine} aborts entry if ${Object.keys(change)[0]} changes during leverage synchronization`, async t => {
      let changed = false;
      const f = executionFixture(t, () => {
        if (changed) return;
        changed = true;
        f.service.update({ revision: 0, settings: { ...f.service.snapshot().settings, ...change }, confirmIncrease: true });
      });
      await f[engine]();
      assert.equal(changed, true);
      assert.equal(f.writes.filter(w => w.url.endsWith("/order")).length, 0);
    });
  }
  test(`${engine} uses selected new-entry leverage and persists actual filled position leverage`, async t => {
    const f = executionFixture(t);
    f.service.update({ revision: 0, settings: { ...f.service.snapshot().settings, leverage_default: 2 } });
    await f[engine]();
    assert.equal(f.writes.filter(w => w.url.endsWith("/order")).length, 1);
    assert.deepEqual(f.writes.filter(w => w.url.endsWith("/set-leverage")).map(w => w.body.lever), ["2", "2"]);
    const trade = f.store.db.prepare("SELECT leverage FROM trades WHERE status='OPEN'").get() as { leverage: number };
    assert.equal(trade.leverage, 4);
    const before = f.store.db.prepare("SELECT * FROM trades WHERE status='OPEN'").all();
    const writesBefore = f.writes.length;
    f.service.update({ revision: 1, settings: { ...f.service.snapshot().settings, leverage_default: 1, position_pct: 10 } });
    assert.deepEqual(f.store.db.prepare("SELECT * FROM trades WHERE status='OPEN'").all(), before);
    assert.equal(f.writes.length, writesBefore, "runtime changes must not resize existing positions");
  });
}
