import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runStartupSafetyAndStartDashboard } from "../src/core/startup-lifecycle.ts";
import { getBotState, getRiskHaltReason, setBotState, setEmergencyHalted, setRiskHaltReason } from "../src/core/state.ts";
import { openStore } from "../src/memory/db.ts";
import { closeTradeOnExchange, type ExecutorDeps } from "../src/execution/executor.ts";
import { ScalpRunner, type ScalpDeps } from "../src/scalp/runner.ts";
import { startDashboard } from "../src/core/dashboard.ts";
import type { AddressInfo } from "node:net";
import { SCALP_DEFAULTS } from "../src/scalp/signals.ts";
import { loadRiskConfig, loadTradingConfig } from "../src/core/config.ts";
import { PositionMonitorHealthTracker } from "../src/core/monitor-health.ts";

const instrument = "BTC-USDT-SWAP";
const meta = { instId: instrument, tickSz: "0.1", lotSz: "1", minSz: "1", ctVal: "1", ctValCcy: "USDT" };

function storeFor(t: test.TestContext) {
  const root = mkdtempSync(path.join(os.tmpdir(), "evoq-runtime-lifecycle-"));
  const store = openStore(root);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  return store;
}

test("startup safety failure persists RISK_HALTED and still starts the local dashboard", async (t) => {
  const store = storeFor(t);
  let dashboardStarted = false;
  const result = await runStartupSafetyAndStartDashboard(store, async () => false, () => {
    dashboardStarted = true;
    return startDashboard({ port: 0, trading: { instrument: { id: instrument }, timeframe: "15m", leverage: { default: 2 } },
      risk: { hard_limits: {} }, deps: () => ({ store, client: { get: async () => { throw new Error("exchange offline"); } }, instruments: {}, watchlist: [] } as never),
      getLastTick: () => null, getKillReason: () => null, getScan: () => [],
      evolution: { reviewEvery: false, signalInterval: 10, strategyInterval: 10, minSample: 10, maxWeightChangePct: 1, maxParamChanges: 1 },
      getExistingPositionMonitoring: () => true });
  });
  assert.equal(result.safetyPassed, false);
  assert.equal(dashboardStarted, true);
  assert.equal(getBotState(store), "RISK_HALTED");
  assert.equal(getRiskHaltReason(store), "STARTUP_SAFETY_FAILURE");
  try {
    let address = result.dashboard.address() as AddressInfo | null;
    for (let i = 0; !address && i < 20; i++) { await new Promise(resolve => setTimeout(resolve, 5)); address = result.dashboard.address() as AddressInfo | null; }
    assert.ok(address);
    const status = await fetch(`http://127.0.0.1:${address.port}/api/status`).then(response => response.json()) as Record<string, unknown>;
    assert.equal(status.botState, "RISK_HALTED");
    assert.equal(status.persistedHaltReason, "STARTUP_SAFETY_FAILURE");
    assert.equal(status.exchangeConnectivity, "UNAVAILABLE");
    assert.equal(status.newEntriesPermitted, false);
    assert.equal(status.existingPositionMonitoringOperational, true);
    assert.equal(status.botState, "RISK_HALTED", "a disconnected status must not be projected as safe");
  } finally { result.dashboard.close(); }
});

test("existing persisted halt survives successful startup verification until explicit recovery", async (t) => {
  const store = storeFor(t);
  setBotState(store, "RISK_HALTED");
  setRiskHaltReason(store, "EXCHANGE_STATE_UNKNOWN");
  await runStartupSafetyAndStartDashboard(store, async () => true, () => ({ close() {}, address: () => null }));
  assert.equal(getBotState(store), "RISK_HALTED");
  assert.equal(getRiskHaltReason(store), "EXCHANGE_STATE_UNKNOWN");
});

test("emergency stop keeps Scalp Layer B monitoring active for an existing position", async (t) => {
  const store = storeFor(t);
  setEmergencyHalted(store, true);
  setBotState(store, "RISK_HALTED");
  setRiskHaltReason(store, "MANUAL_EMERGENCY_STOP");
  const now = new Date().toISOString();
  store.db.prepare(`INSERT INTO trades(trade_id,engine,status,instrument,timeframe,side,strategy,strategy_version,regime,contracts,
    entry_px,entry_ts,stop_px,initial_stop_px,take_profit_px,ord_open_id,protection_state,protection_checked_at)
    VALUES('SCP-HALTED-MONITOR','SCALP_5M','OPEN',?,'scalp','LONG','SCALP_V1',1,'TRENDING_BULLISH','1',100,?,95,95,110,'OPEN-1','VERIFIED',?)`)
    .run(instrument, new Date(Date.now() - 3_600_000).toISOString(), now);
  let closeSubmissions = 0;
  const position = { instId: instrument, posSide: "long", pos: "1", avgPx: "100", markPx: "90", lever: "2", mgnMode: "isolated" };
  const client = {
    get: async (endpoint: string, query?: Record<string, string>) => {
      if (endpoint === "/api/v5/account/positions") return [position];
      if (endpoint === "/api/v5/trade/orders-algo-pending") return [];
      if (endpoint === "/api/v5/trade/order" && query?.clOrdId) return [];
      if (endpoint === "/api/v5/trade/order" && query?.ordId === "CLOSE-1") return [{ ordId: "CLOSE-1", instId: instrument,
        state: "filled", avgPx: "90", accFillSz: "1", sz: "1", side: "sell", posSide: "long", tdMode: "isolated", ordType: "market" }];
      if (endpoint === "/api/v5/trade/fills") return [];
      throw new Error(`unexpected mock GET ${endpoint}`);
    },
    post: async (endpoint: string, body: Record<string, string>) => {
      if (endpoint === "/api/v5/trade/order") { closeSubmissions++; return [{ ordId: "CLOSE-1", clOrdId: body.clOrdId, sCode: "0" }]; }
      throw new Error(`unexpected mock POST ${endpoint}`);
    },
  };
  const trading = loadTradingConfig();
  trading.position_management.sl_plus.enabled = false;
  const deps = { client, store, trading, risk: loadRiskConfig(), instruments: { [instrument]: meta },
    cfg: { ...SCALP_DEFAULTS, watchlist: [instrument], max_hold_s: 60 }, llm: {} } as unknown as ScalpDeps;
  const runner = new ScalpRunner(deps);
  await (runner as unknown as { sweep(): Promise<void> }).sweep();
  assert.equal(closeSubmissions, 1, "Layer B must submit a risk-reducing close during Emergency Stop");
  assert.equal(getBotState(store), "RISK_HALTED", "monitoring must not clear the emergency halt");
});

test("Scalp inFlight cleanup is protected by finally on the order preparation path", async (t) => {
  const store = storeFor(t);
  const trading = loadTradingConfig();
  const deps = { client: { get: async (endpoint: string) => {
      if (endpoint === "/api/v5/account/positions") return [];
      if (endpoint === "/api/v5/account/balance") return [{ details: [{ ccy: "USDT", eq: "100", availEq: "100" }] }];
      if (endpoint === "/api/v5/public/time") return [{ ts: String(Date.now()) }];
      if (endpoint === "/api/v5/trade/orders-pending") return [];
      throw new Error(`unexpected mock GET ${endpoint}`);
    } }, store, trading, risk: loadRiskConfig(),
    instruments: { [instrument]: meta }, cfg: { ...SCALP_DEFAULTS, watchlist: [instrument] }, llm: {} } as unknown as ScalpDeps;
  setBotState(store, "RUNNING");
  setEmergencyHalted(store, false);
  const runner = new ScalpRunner(deps);
  const open = runner as unknown as { openScalp(signal: unknown, features: unknown): Promise<unknown>; inFlight: Set<string> };
  await open.openScalp({ instrument, price: 100, stopPx: 100, tpPx: 110, direction: 1, score: 0.9 }, {});
  assert.equal(open.inFlight.has(instrument), false);
});

test("Scalp Layer B monitors without opening when there are no live Scalp positions", async (t) => {
  const store = storeFor(t);
  setEmergencyHalted(store, true);
  let requests = 0;
  const trading = loadTradingConfig(); trading.position_management.sl_plus.enabled = false;
  const deps = { client: { get: async () => { requests++; return []; }, post: async () => { throw new Error("must not submit"); } },
    store, trading, risk: loadRiskConfig(), instruments: {}, cfg: { ...SCALP_DEFAULTS, watchlist: [] }, llm: {} } as unknown as ScalpDeps;
  const runner = new ScalpRunner(deps);
  await (runner as unknown as { sweep(): Promise<void> }).sweep();
  assert.equal(requests, 0);
});

test("disabled Scalp entry engine does not call stance or candidate LLM and leaves monitor callable", async (t) => {
  const store = storeFor(t);
  setBotState(store, "RUNNING");
  setEmergencyHalted(store, false);
  let marketRequests = 0;
  let llmCalls = 0;
  const trading = loadTradingConfig();
  const deps = { client: { get: async () => { marketRequests++; return []; }, post: async () => { throw new Error("entry order forbidden"); } },
    store, trading, risk: loadRiskConfig(), instruments: {}, cfg: { ...SCALP_DEFAULTS, watchlist: [] },
    entryEnabled: false, llm: { json: async () => { llmCalls++; throw new Error("disabled Scalp must not call LLM"); } } } as unknown as ScalpDeps;
  const runner = new ScalpRunner(deps);
  await runner.tick();
  await (runner as unknown as { sweep(): Promise<void> }).sweep();
  assert.equal(llmCalls, 0);
  assert.equal(marketRequests, 0);
});

test("dashboard entry readiness reports unresolved reconciliation as a blocker", async (t) => {
  const store = storeFor(t);
  setBotState(store, "RUNNING");
  setEmergencyHalted(store, false);
  const now = new Date().toISOString();
  store.db.prepare(`INSERT INTO trades(trade_id,engine,status,evidence_state,instrument,timeframe,side,strategy,strategy_version,regime,contracts,entry_px,entry_ts)
    VALUES('TRD-READINESS','SWING_15M','RECONCILIATION_PENDING','RECONCILIATION_PENDING',?,'15m','LONG','TREND_FOLLOWING',1,'SIDEWAYS','1',100,?)`)
    .run(instrument, now);
  const trading = loadTradingConfig();
  const risk = loadRiskConfig();
  const monitorHealth = new PositionMonitorHealthTracker();
  const deps = { store, trading, risk, instruments: {}, watchlist: [], client: { get: async (endpoint: string) => {
    if (endpoint === "/api/v5/account/balance") return [{ details: [{ ccy: "USDT", eq: "100", availEq: "100" }] }];
    if (endpoint === "/api/v5/account/positions") return [];
    throw new Error(`unexpected exchange read ${endpoint}`);
  } } } as never;
  const server = startDashboard({ port: 0, trading, risk, deps: () => deps, getLastTick: () => null, getKillReason: () => null,
    getScan: () => [], getPositionMonitoringHealth: () => monitorHealth.snapshot({ SWING_15M: true, SCALP_5M: false }),
    evolution: { reviewEvery: false, signalInterval: 10, strategyInterval: 10, minSample: 10, maxWeightChangePct: 1, maxParamChanges: 1 } });
  t.after(() => server.close());
  let address = server.address();
  for (let i = 0; !address && i < 20; i++) { await new Promise(resolve => setTimeout(resolve, 5)); address = server.address(); }
  assert.ok(address);
  const status = await fetch(`http://127.0.0.1:${address.port}/api/status`).then(response => response.json()) as Record<string, unknown>;
  assert.equal(status.newEntriesPermitted, false);
  const blockers = (status.entryReadiness as { blockers: Array<{ code: string }> }).blockers.map(blocker => blocker.code);
  assert.ok(blockers.includes("RECONCILIATION_PENDING"));
  const monitoring = status.positionMonitoring as Record<string, { health: string; required: boolean }>;
  assert.equal(monitoring.SWING_15M?.health, "UNKNOWN");
  assert.equal(monitoring.SWING_15M?.required, true);
  assert.equal(status.existingPositionMonitoringOperational, false, "initialized timers alone are not proof of healthy sweeps");
});

test("close retry reuses its persisted client order ID and resolves an accepted timed-out close", async (t) => {
  const store = storeFor(t);
  store.db.prepare(`INSERT INTO trades(trade_id,engine,status,instrument,timeframe,side,strategy,strategy_version,regime,contracts,
    entry_px,entry_ts,stop_px,initial_stop_px,take_profit_px,ord_open_id,protection_state,sl_algo_id,tp_algo_id,algo_id)
    VALUES('SCP-CLOSE-UNKNOWN','SCALP_5M','OPEN',?,'scalp','LONG','SCALP_V1',1,'TRENDING_BULLISH','1',100,?,95,95,110,
      'OPEN-1','VERIFIED','SL-1','TP-1','SL-1')`).run(instrument, new Date(Date.now() - 60_000).toISOString());
  let submissions = 0;
  let firstStatusRequest = true;
  let acceptedClientId = "";
  const livePosition = { instId: instrument, posSide: "long", pos: "1", avgPx: "100", markPx: "90", lever: "2", mgnMode: "isolated" };
  const closeFills = [
    { instId: instrument, tradeId: "F-CLOSE-1", billId: "B-CLOSE-1", ordId: "CLOSE-ACCEPTED", fillPx: "90", fillSz: "0.4",
      side: "sell", posSide: "long", execType: "T", ts: String(Date.now() - 1_000), fee: "-0.004", feeCcy: "USDT" },
    { instId: instrument, tradeId: "F-CLOSE-2", billId: "B-CLOSE-2", ordId: "CLOSE-ACCEPTED", fillPx: "100", fillSz: "0.6",
      side: "sell", posSide: "long", execType: "T", ts: String(Date.now() - 999), fee: "-0.006", feeCcy: "USDT" },
  ];
  const client = {
    get: async (endpoint: string, query?: Record<string, string>) => {
      if (endpoint === "/api/v5/account/positions") return [livePosition];
      if (endpoint === "/api/v5/trade/order" && query?.clOrdId) {
        return acceptedClientId ? [{ ordId: "CLOSE-ACCEPTED", clOrdId: acceptedClientId, instId: instrument,
          state: "filled", avgPx: "90", accFillSz: "1", sz: "1", side: "sell", posSide: "long", tdMode: "isolated", ordType: "market" }] : [];
      }
      if (endpoint === "/api/v5/trade/order" && query?.ordId === "CLOSE-ACCEPTED") {
        if (firstStatusRequest) { firstStatusRequest = false; throw new Error("status request timed out after accepted close"); }
        return [{ ordId: "CLOSE-ACCEPTED", clOrdId: acceptedClientId, instId: instrument, state: "filled", avgPx: "90",
          accFillSz: "1", sz: "1", side: "sell", posSide: "long", tdMode: "isolated", ordType: "market" }];
      }
      if (endpoint === "/api/v5/trade/fills") return query?.ordId === "CLOSE-ACCEPTED" ? closeFills : [];
      if (endpoint === "/api/v5/trade/orders-algo-pending") return [];
      if (endpoint === "/api/v5/trade/order-algo") return [{ algoId: String(query?.algoId), state: "canceled", instId: instrument,
        tdMode: "isolated", side: "sell", posSide: "long", ordType: "conditional", sz: "1" }];
      if (endpoint === "/api/v5/trade/fills-history") return closeFills;
      if (endpoint === "/api/v5/market/candles") return [];
      throw new Error(`unexpected mock GET ${endpoint}`);
    },
    post: async (endpoint: string, body: Record<string, string>) => {
      if (endpoint === "/api/v5/trade/order") { submissions++; acceptedClientId = body.clOrdId ?? ""; return [{ ordId: "CLOSE-ACCEPTED", clOrdId: acceptedClientId, sCode: "0" }]; }
      if (endpoint === "/api/v5/trade/cancel-algos") return [{ sCode: "0" }];
      throw new Error(`unexpected mock POST ${endpoint}`);
    },
  };
  const deps = { client, store, trading: { timeframe: "15m" }, risk: {}, instruments: { [instrument]: meta }, watchlist: [instrument] } as unknown as ExecutorDeps;
  const trade = store.db.prepare("SELECT * FROM trades WHERE trade_id='SCP-CLOSE-UNKNOWN'").get() as Record<string, unknown>;
  const position = { instId: instrument, posSide: "long", pos: "1", markPx: "90", avgPx: "100" } as never;
  await assert.rejects(closeTradeOnExchange(deps, trade, position, "SL"), /timed out/);
  const closeIdAfterTimeout = (store.db.prepare("SELECT cl_close_id FROM trades WHERE trade_id='SCP-CLOSE-UNKNOWN'").get() as { cl_close_id: string }).cl_close_id;
  assert.ok(closeIdAfterTimeout);
  await closeTradeOnExchange(deps, store.db.prepare("SELECT * FROM trades WHERE trade_id='SCP-CLOSE-UNKNOWN'").get() as Record<string, unknown>, position, "SL");
  assert.equal(submissions, 1, "unknown accepted close must be queried by the same client ID, never blindly resubmitted");
  const closed = store.db.prepare("SELECT status,ord_close_id,exit_px FROM trades WHERE trade_id='SCP-CLOSE-UNKNOWN'").get() as Record<string, unknown>;
  assert.equal(closed.status, "CLOSED");
  assert.equal(closed.exit_px, 96, "closed trade uses quantity-weighted price across both unique partial fills");
});

test("terminal canceled close remains an open managed position and does not resubmit or spam events", async (t) => {
  const store = storeFor(t);
  store.db.prepare(`INSERT INTO trades(trade_id,engine,status,instrument,timeframe,side,strategy,strategy_version,regime,contracts,
    entry_px,entry_ts,stop_px,initial_stop_px,take_profit_px,ord_open_id,protection_state)
    VALUES('SCP-CLOSE-CANCELED','SCALP_5M','OPEN',?,'scalp','LONG','SCALP_V1',1,'TRENDING_BULLISH','1',100,?,95,95,110,'OPEN-1','VERIFIED')`)
    .run(instrument, new Date(Date.now() - 60_000).toISOString());
  let submissions = 0;
  const client = {
    get: async (endpoint: string, query?: Record<string, string>) => {
      if (endpoint === "/api/v5/trade/order" && query?.clOrdId) return [{ ordId: "CLOSE-CANCELED", clOrdId: query.clOrdId,
        instId: instrument, state: "canceled", accFillSz: "0", sz: "1", side: "sell", posSide: "long", ordType: "market" }];
      throw new Error(`unexpected mock GET ${endpoint}`);
    },
    post: async () => { submissions++; return []; },
  };
  const deps = { client, store, trading: {}, risk: {}, instruments: { [instrument]: meta }, watchlist: [instrument] } as unknown as ExecutorDeps;
  const position = { instId: instrument, posSide: "long", pos: "1", markPx: "90", avgPx: "100" } as never;
  const trade = store.db.prepare("SELECT * FROM trades WHERE trade_id='SCP-CLOSE-CANCELED'").get() as Record<string, unknown>;
  await assert.rejects(closeTradeOnExchange(deps, trade, position, "SL"), /prior close order is canceled/);
  await assert.rejects(closeTradeOnExchange(deps, store.db.prepare("SELECT * FROM trades WHERE trade_id='SCP-CLOSE-CANCELED'").get() as Record<string, unknown>, position, "SL"), /prior close order is canceled/);
  const saved = store.db.prepare("SELECT status,exit_confirmation FROM trades WHERE trade_id='SCP-CLOSE-CANCELED'").get() as Record<string, unknown>;
  assert.equal(saved.status, "OPEN", "open exposure must remain under position management until a fresh safe action is taken");
  assert.equal(saved.exit_confirmation, "CLOSE_ORDER_TERMINAL_UNFILLED");
  assert.equal(getBotState(store), "RISK_HALTED");
  assert.equal(getRiskHaltReason(store), "CLOSE_ORDER_UNRESOLVED");
  assert.equal(submissions, 0, "a terminal close must not be blindly resubmitted under another order ID");
  const reviewEvents = store.db.prepare("SELECT COUNT(*) n FROM system_events WHERE kind='RISK_EVENT'").get() as { n: number };
  assert.equal(reviewEvents.n, 1, "identical review warnings should be emitted once");
});

