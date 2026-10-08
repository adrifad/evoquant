import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadRiskConfig, loadTradingConfig } from "../src/core/config.ts";
import { RuntimeRiskService, RISK_CEILINGS, RUNTIME_RISK_KEY, selectedEntryLeverage, serializeRiskEntry,
  reserveEntry, releaseEntry, unresolvedEntry, ENTRY_RESERVATION_KEY } from "../src/core/runtime-risk.ts";
import { openStore, kvGet, kvSet } from "../src/memory/db.ts";
import { setBotState, setEmergencyHalted } from "../src/core/state.ts";
import { sizePosition } from "../src/risk/position-sizing.ts";
import { evaluateGlobalEntryGate } from "../src/risk/global-entry-gate.ts";
import { runTick, startupSafetySequence, synchronizeEntryLeverage, reconcileEntryReservation, type TickContext } from "../src/execution/executor.ts";
import { prepareCapitalStore } from "../src/core/capital.ts";
import { ScalpRunner } from "../src/scalp/runner.ts";
import { SCALP_DEFAULTS, type ScalpSignal } from "../src/scalp/signals.ts";
import { OkxApiError, type OkxClient } from "../src/exchange/okx/client.ts";
import { OrderRejectedError } from "../src/exchange/okx/orders.ts";
import type { InstrumentInfo } from "../src/exchange/okx/types.ts";
import type { FeatureSnapshot } from "../src/market/features.ts";
import type { RoleLlmService } from "../src/core/llm-role-service.ts";

function fixture(t: { after(fn: () => void): void }, baselineMode = false) {
  const root = mkdtempSync(path.join(os.tmpdir(), "evoq-runtime-risk-"));
  const store = openStore(root);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const risk = loadRiskConfig();
  Object.assign(risk.hard_limits, { risk_per_trade_pct: 1, max_daily_loss_pct: 3,
    max_drawdown_pct: 10, max_leverage: 5, max_concurrent_positions: 2 });
  const service = new RuntimeRiskService({ store, risk, baselineMode });
  return { root, store, risk, service };
}

test("runtime risk rejects unknown, missing, nonnumeric, nonfinite and ceiling violations without writes", (t) => {
  const { service, store } = fixture(t);
  const original = service.snapshot();
  const bad = [
    { ...original.limits, unknown: 1 }, { ...original.limits, max_leverage: "3" },
    { ...original.limits, risk_per_trade_pct: NaN }, { ...original.limits, max_drawdown_pct: Infinity },
    { ...original.limits, max_concurrent_positions: 1.5 }, { ...original.limits, max_daily_loss_pct: 0 },
    { max_leverage: 3 },
    ...Object.entries(RISK_CEILINGS).map(([key, value]) => ({ ...original.limits, [key]: value + 1 })),
  ];
  for (const limits of bad) assert.throws(() => service.update({ revision: 0, limits, confirmRiskIncrease: true }));
  assert.throws(() => service.update({ revision: 0, limits: original.limits, source: "agent" }));
  assert.deepEqual(service.snapshot(), original);
  assert.equal(kvGet(store, RUNTIME_RISK_KEY), null);
  assert.equal((store.db.prepare("SELECT count(*) n FROM system_events").get() as { n: number }).n, 0);
});

test("all loosenings require explicit boolean confirmation and stale writers conflict", (t) => {
  const { service, store, risk } = fixture(t);
  const other = new RuntimeRiskService({ store, risk: structuredClone(risk) });
  for (const field of Object.keys(RISK_CEILINGS) as Array<keyof typeof RISK_CEILINGS>) {
    assert.throws(() => service.update({ revision: 0,
      limits: { ...service.snapshot().limits, [field]: RISK_CEILINGS[field] } }), /confirmRiskIncrease/);
  }
  const limits = { ...service.snapshot().limits, risk_per_trade_pct: 1.5 };
  for (const confirmRiskIncrease of [undefined, false, "true", 1]) {
    assert.throws(() => service.update({ revision: 0, limits, confirmRiskIncrease }));
  }
  const saved = service.update({ revision: 0, limits, confirmRiskIncrease: true });
  assert.equal(saved.revision, 1);
  assert.throws(() => other.update({ revision: 0, limits }), /reload before saving/);
  assert.throws(() => service.update({ revision: 0, limits }), /reload before saving/);
  const events = store.db.prepare("SELECT ts,payload FROM system_events WHERE kind='RISK_LIMIT_CHANGED'").all() as Array<{ ts: string; payload: string }>;
  assert.equal(events.length, 1);
  assert.deepEqual(JSON.parse(events[0]!.payload), { field: "risk_per_trade_pct", oldValue: 1, newValue: 1.5,
    source: "dashboard", timestamp: events[0]!.ts, revision: 1 });
});

test("audit failure rolls back every changed field, revision and live object", (t) => {
  const { service, store, risk } = fixture(t);
  const before = service.snapshot();
  const identity = risk.hard_limits;
  store.db.exec(`CREATE TRIGGER reject_second_risk_audit BEFORE INSERT ON system_events
    WHEN NEW.kind='RISK_LIMIT_CHANGED' AND json_extract(NEW.payload,'$.field')='max_daily_loss_pct'
    BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END;`);
  assert.throws(() => service.update({ revision: 0, limits: { ...before.limits,
    risk_per_trade_pct: 0.5, max_daily_loss_pct: 2 } }), /audit unavailable/);
  assert.deepEqual(service.snapshot(), before);
  assert.equal(risk.hard_limits, identity);
  assert.equal(kvGet(store, RUNTIME_RISK_KEY), null);
  assert.equal((store.db.prepare("SELECT count(*) n FROM system_events").get() as { n: number }).n, 0);
});

test("restart restores persisted limits; baseline enforces one position and corrupted storage aborts", (t) => {
  const { service, store, root } = fixture(t);
  const saved = service.update({ revision: 0, limits: { ...service.snapshot().limits, max_leverage: 2 } });
  const restartedStore = openStore(root);
  try {
    const restarted = new RuntimeRiskService({ store: restartedStore, risk: loadRiskConfig() });
    assert.deepEqual(restarted.snapshot(), saved);
    const baseline = new RuntimeRiskService({ store: restartedStore, risk: loadRiskConfig(), baselineMode: true });
    assert.equal(baseline.snapshot().limits.max_concurrent_positions, 1);
    assert.equal(baseline.snapshot().ceilings.max_concurrent_positions, 1);
    assert.throws(() => baseline.update({ revision: 1, limits: saved.limits, confirmRiskIncrease: true }), /Baseline/);
  } finally { restartedStore.close(); }
  kvSet(store, RUNTIME_RISK_KEY, JSON.stringify({ revision: 2, limits: { ...saved.limits, max_leverage: 100 } }));
  assert.throws(() => new RuntimeRiskService({ store, risk: loadRiskConfig() }));
});

const meta: InstrumentInfo = { instId: "BTC-USDT-SWAP", tickSz: "0.01", lotSz: "1", minSz: "1",
  ctVal: "0.001", ctValCcy: "BTC" };

test("hot updates retain shared object identity and tighten sizing, slots and selected leverage", (t) => {
  const { service, risk } = fixture(t);
  const swing = risk, scalp = risk;
  const h = risk.hard_limits;
  const trading = loadTradingConfig();
  trading.leverage = { default: 5, hard_max: 4 };
  assert.equal(selectedEntryLeverage(trading, risk), 4);
  const before = sizePosition({ equity: 100, entryPrice: 100, stopPrice: 98, leverage: 4, instrument: meta }, swing);
  service.update({ revision: 0, limits: { ...service.snapshot().limits,
    risk_per_trade_pct: 0.25, max_concurrent_positions: 1, max_leverage: 2 } });
  assert.equal(risk.hard_limits, h);
  assert.equal(selectedEntryLeverage(trading, scalp), 2);
  const after = sizePosition({ equity: 100, entryPrice: 100, stopPrice: 98, leverage: 2, instrument: meta }, scalp);
  assert.ok(Number(after.contracts) < Number(before.contracts));
  assert.equal(evaluateGlobalEntryGate({ killSwitchActive: null, botState: "RUNNING", openPositions: 1,
    instrument: meta.instId, instrumentOccupied: false }, swing).allowed, false);
});

test("shared entry queue serializes callers and recovers after a rejected operation", async (t) => {
  const { store } = fixture(t);
  const sequence: string[] = [];
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  const first = serializeRiskEntry(store, async () => { sequence.push("swing"); await barrier; throw new Error("failed"); });
  const second = serializeRiskEntry({ db: store.db, close: () => {} }, async () => { sequence.push("scalp"); });
  await Promise.resolve(); await Promise.resolve();
  assert.deepEqual(sequence, ["swing"]);
  release();
  await assert.rejects(first, /failed/);
  await second;
  assert.deepEqual(sequence, ["swing", "scalp"]);
});

const features = { ts: 0, instrument: meta.instId, price: 100, atr14: 1, atrPct: 1,
  ema20: 101, ema50: 100, emaSpreadPct: 1, rsi14: 60, adx14: 30, volume: 100,
  volumeSma20: 100, volumeRatio: 1.2, sufficientData: true } satisfies FeatureSnapshot;
const signal: ScalpSignal = { instrument: meta.instId, direction: 1, score: 0.9, price: 100,
  stopPx: 98, tpPx: 104, atr: 1, reason: "fixture", regime: "TRENDING_BULLISH", ts: 0 };

function executionFixture(t: { after(fn: () => void): void }, onLeverage?: () => void) {
  const base = fixture(t);
  base.risk.hard_limits.max_concurrent_positions = 1;
  const trading = loadTradingConfig();
  trading.leverage = { default: 5, hard_max: 5 };
  trading.sizing = { mode: "percent_of_equity", position_pct: 20 };
  const positions: Array<Record<string, string>> = [];
  const writes: Array<{ url: string; body: Record<string, string> }> = [];
  const behavior = { entryFailure: null as "post" | "wait" | "wait-reject" | "reject" | "envelope-reject" | "duplicate" | "malformed" | null,
    resolution: null as Record<string, string> | null, reservationQueries: 0 };
  const client = {
    get: async (url: string, query?: Record<string, string>) => {
      if (url.endsWith("/balance")) return [{ totalEq: "100", details: [{ ccy: "USDT", eq: "100", availEq: "100" }] }];
      if (url.endsWith("/positions")) return structuredClone(positions);
      if (url.endsWith("/time")) return [{ ts: String(Date.now()) }];
      if (url.endsWith("/orders-pending") || url.endsWith("/fills")) return [];
      if (url.endsWith("/config")) return [{ posMode: "long_short_mode" }];
      if (url.endsWith("/order")) {
        if (query?.clOrdId) { behavior.reservationQueries++; return behavior.resolution ? [behavior.resolution] : []; }
        if (behavior.entryFailure === "wait") throw new Error("order status request timed out");
        if (behavior.entryFailure === "wait-reject") throw new OrderRejectedError("51000", "status query rejected", true);
        return [{ ordId: "O1", instId: meta.instId, state: "filled", avgPx: "100", lever: "3", accFillSz: "200", sz: "200" }];
      }
      throw new Error(`unexpected fake GET ${url}`);
    },
    post: async (url: string, body: Record<string, string>) => {
      writes.push({ url, body });
      if (url.endsWith("/set-leverage")) { onLeverage?.(); return [body]; }
      if (url.endsWith("/order")) {
        assert.equal(unresolvedEntry(base.store)?.clOrdId, body.clOrdId, "reservation must commit before POST");
        if (behavior.entryFailure === "post") throw new Error("entry submission timed out");
        if (behavior.entryFailure === "reject") return [{ sCode: "51008", sMsg: "Insufficient balance", ordId: "", clOrdId: body.clOrdId }];
        if (behavior.entryFailure === "envelope-reject") throw new OkxApiError("1", "Order failed", 200,
          [{ sCode: "51008", sMsg: "Insufficient balance", ordId: "", clOrdId: body.clOrdId }]);
        if (behavior.entryFailure === "duplicate") return [{ sCode: "51016", sMsg: "Duplicate client order ID", ordId: "", clOrdId: body.clOrdId }];
        if (behavior.entryFailure === "malformed") return [{ ordId: "", clOrdId: body.clOrdId }];
        if (behavior.entryFailure === "wait" || behavior.entryFailure === "wait-reject") return [{ ordId: "O1", sCode: "0" }];
        positions.push({ instId: body.instId!, posSide: body.posSide!, pos: body.sz!, avgPx: "100", markPx: "100", lever: "4", margin: "5", mgnMode: "isolated" });
        return [{ ordId: "O1", sCode: "0" }];
      }
      if (url.endsWith("/order-algo")) return [{ algoId: "A1", sCode: "0" }];
      throw new Error(`unexpected fake POST ${url}`);
    },
  } as unknown as OkxClient;
  const secondInstrument = "ETH-USDT-SWAP";
  base.risk.hard_limits.allowed_symbols = [meta.instId, secondInstrument];
  const deps = { ...base, client, trading, instruments: { [meta.instId]: meta,
    [secondInstrument]: { ...meta, instId: secondInstrument } }, watchlist: [meta.instId, secondInstrument] };
  setBotState(base.store, "RUNNING");
  setEmergencyHalted(base.store, false);
  const runner = new ScalpRunner({ ...deps, cfg: { ...SCALP_DEFAULTS, position_pct: 20 }, llm: {} as RoleLlmService });
  const openScalp = (instrument = meta.instId) => (runner as unknown as { openScalp(s: ScalpSignal, f: FeatureSnapshot): Promise<void> })
    .openScalp({ ...signal, instrument }, { ...features, instrument });
  const ctx: TickContext = { features, regime: "TRENDING_BULLISH", strategies: [{ name: "TREND_FOLLOWING", version: 1 } as TickContext["strategies"][number]],
    decideFn: async () => ({ decision: "LONG", strategy: "TREND_FOLLOWING_V1", confidence: 1,
      suggested_stop_atr: 2, suggested_take_profit_atr: 4, thesis: ["fixture"], invalidations: [] }) };
  const openSwing = () => runTick(deps, ctx, { instId: meta.instId, meta });
  return { ...deps, writes, positions, behavior, openScalp, openSwing };
}

test("startup never changes leverage and new-entry sync refuses an occupied instrument", async (t) => {
  const f = executionFixture(t);
  assert.equal(await startupSafetySequence(f), true);
  assert.equal(f.writes.length, 0);
  f.positions.push({ instId: meta.instId, posSide: "long", pos: "1" });
  await assert.rejects(synchronizeEntryLeverage(f, meta.instId), /occupied/);
  assert.equal(f.writes.length, 0);
});

for (const engine of ["openScalp", "openSwing"] as const) {
  test(`${engine} uses hot leverage, actual filled position leverage, and actual stop risk`, async (t) => {
    const f = executionFixture(t);
    f.service.update({ revision: 0, limits: { ...f.service.snapshot().limits, max_leverage: 2 } });
    await f[engine]();
    assert.equal(f.writes.filter((w) => w.url.endsWith("/order")).length, 1);
    assert.deepEqual(f.writes.filter((w) => w.url.endsWith("/set-leverage")).map((w) => w.body.lever), ["2", "2"]);
    const trade = f.store.db.prepare("SELECT leverage,planned_risk_pct FROM trades WHERE status='OPEN'").get() as { leverage: number; planned_risk_pct: number };
    assert.equal(trade.leverage, 4); // Position evidence takes precedence over order/default.
    assert.equal(trade.planned_risk_pct, 0.4); // 20 USDT notional at a 2% stop / 100 USDT equity.
  });
  test(`${engine} aborts submission when risk changes while leverage sync is in flight`, async (t) => {
    let changed = false;
    const f = executionFixture(t, () => {
      if (changed) return;
      changed = true;
      f.service.update({ revision: 0, limits: { ...f.service.snapshot().limits, max_leverage: 1 } });
    });
    await f[engine]();
    assert.equal(changed, true);
    assert.equal(f.writes.filter((w) => w.url.endsWith("/order")).length, 0);
  });
  for (const failure of ["reject", "envelope-reject"] as const) {
    test(`${engine} clears proven ${failure} so restart and later entries recover`, async (t) => {
      const f = executionFixture(t);
      f.behavior.entryFailure = failure;
      await f[engine]();
      assert.equal(f.writes.filter((w) => w.url.endsWith("/order")).length, 1);
      assert.equal(unresolvedEntry(f.store), null);
      assert.equal(f.positions.length, 0);
      const reopened = openStore(f.root);
      try {
        assert.equal(unresolvedEntry(reopened), null);
        assert.equal(await startupSafetySequence({ ...f, store: reopened }), true);
      } finally { reopened.close(); }
      f.behavior.entryFailure = null;
      await f[engine]();
      assert.equal(f.writes.filter((w) => w.url.endsWith("/order")).length, 2);
      assert.equal(f.writes.filter((w) => w.url.endsWith("/order-algo")).length, 1);
      assert.equal((f.store.db.prepare("SELECT COUNT(*) n FROM trades WHERE status='OPEN'").get() as { n: number }).n, 1);
    });
  }
  for (const failure of ["post", "wait", "wait-reject", "duplicate", "malformed"] as const) {
    test(`${engine} reserves ambiguous ${failure} through stale exchange snapshots and restart`, async (t) => {
      const f = executionFixture(t);
      f.behavior.entryFailure = failure;
      await f[engine]();
      const reservation = unresolvedEntry(f.store);
      assert.ok(reservation);
      assert.equal(f.positions.length, 0);
      const writesAfterFailure = f.writes.length;
      await f.openScalp("ETH-USDT-SWAP");
      await f.openSwing();
      assert.equal(f.writes.length, writesAfterFailure, "ambiguous entry blocks every further exchange write");
      const reopened = openStore(f.root);
      try {
        assert.deepEqual(unresolvedEntry(reopened), reservation);
        assert.equal(await startupSafetySequence({ ...f, store: reopened }), false);
        assert.equal(f.writes.length, writesAfterFailure);
        assert.ok(f.behavior.reservationQueries >= 3);
        f.behavior.resolution = { clOrdId: reservation.clOrdId, instId: reservation.instId,
          posSide: reservation.posSide, ordId: "O1", state: "canceled", accFillSz: "0" };
        await reconcileEntryReservation({ ...f, store: reopened });
        assert.equal(unresolvedEntry(reopened), null);
      } finally { reopened.close(); }
      f.behavior.entryFailure = null;
      await f[engine]();
      assert.equal(f.positions.length, 1, "resolved zero-fill submission allows a later entry");
    });
  }
  test(`${engine} protects the filled position when optional capital persistence fails`, async (t) => {
    const f = executionFixture(t);
    prepareCapitalStore(f.store);
    f.store.db.exec("CREATE TRIGGER fail_capital BEFORE INSERT ON entry_capital BEGIN SELECT RAISE(ABORT, 'snapshot unavailable'); END;");
    await f[engine]();
    assert.equal(f.writes.filter((w) => w.url.endsWith("/order-algo")).length, 1);
    const trade = f.store.db.prepare("SELECT algo_id FROM trades WHERE status='OPEN'").get() as { algo_id: string };
    assert.equal(trade.algo_id, "A1");
    assert.equal(unresolvedEntry(f.store), null);
    assert.equal((f.store.db.prepare("SELECT COUNT(*) n FROM entry_capital").get() as { n: number }).n, 0);
  });
}

test("reservation reconciliation needs exact order identity and terminal fill evidence", async (t) => {
  const f = executionFixture(t);
  reserveEntry(f.store, { clOrdId: "pending1", instId: meta.instId, posSide: "long" });
  assert.throws(() => reserveEntry(f.store, { clOrdId: "pending2", instId: "ETH-USDT-SWAP", posSide: "long" }), /STATE_UNCERTAIN/);
  releaseEntry(f.store, "different-id");
  assert.equal(unresolvedEntry(f.store)?.clOrdId, "pending1");
  const exact = { clOrdId: "pending1", instId: meta.instId, posSide: "long", ordId: "O1", state: "canceled", accFillSz: "0" };
  for (const patch of [{ clOrdId: "other" }, { instId: "other" }, { posSide: "short" },
    { state: "live" }, { state: "partially_filled", accFillSz: "1" }, { accFillSz: "1" },
    { accFillSz: "" }, { state: "filled", accFillSz: "200" }]) {
    f.behavior.resolution = { ...exact, ...patch };
    await assert.rejects(reconcileEntryReservation(f), /STATE_UNCERTAIN/);
    assert.ok(unresolvedEntry(f.store));
  }
  f.behavior.resolution = exact;
  await reconcileEntryReservation(f);
  assert.equal(unresolvedEntry(f.store), null);
  kvSet(f.store, ENTRY_RESERVATION_KEY, "malformed");
  await assert.rejects(synchronizeEntryLeverage(f, meta.instId));
  assert.equal(f.writes.length, 0);
});

test("restart clears a filled reservation only when its exact fill is already tracked", async (t) => {
  const f = executionFixture(t);
  await f.openScalp();
  const trade = f.store.db.prepare("SELECT cl_open_id,ord_open_id FROM trades WHERE status='OPEN'").get() as { cl_open_id: string; ord_open_id: string };
  reserveEntry(f.store, { clOrdId: trade.cl_open_id, instId: meta.instId, posSide: "long" });
  const writes = f.writes.length;
  f.behavior.resolution = { clOrdId: trade.cl_open_id, instId: meta.instId, posSide: "long",
    ordId: "wrong-order", state: "filled", accFillSz: "200" };
  assert.equal(await startupSafetySequence(f), false);
  assert.ok(unresolvedEntry(f.store));
  f.behavior.resolution.ordId = trade.ord_open_id;
  assert.equal(await startupSafetySequence(f), true);
  assert.equal(unresolvedEntry(f.store), null);
  assert.equal(f.writes.length, writes);
});

test("simultaneous swing/scalp candidates cannot consume the same last slot", async (t) => {
  const f = executionFixture(t);
  await Promise.all([f.openSwing(), f.openScalp("ETH-USDT-SWAP")]);
  assert.equal(f.writes.filter((w) => w.url.endsWith("/order")).length, 1);
  assert.equal((f.store.db.prepare("SELECT COUNT(*) n FROM trades WHERE status='OPEN'").get() as { n: number }).n, 1);
});
