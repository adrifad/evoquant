import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ReviewSchema } from "../src/agents/reviewer-agent.ts";
import { excursionCandles, finalizeOpenTradeFromExchange, sweepUnprovenExits, verifyOpenTradeProtection, recoverProtectionHalt, resetLastKillReason, getLastKillReason, type ExecutorDeps } from "../src/execution/executor.ts";
import { deduplicateFills } from "../src/exchange/okx/orders.ts";
import { openStore } from "../src/memory/db.ts";
import { closeTrade, computeClosedMetrics } from "../src/memory/trades.ts";
import { getBotState, setBotState, getRiskHaltReason, setRiskHaltReason, setEmergencyHalted } from "../src/core/state.ts";
import { evaluateGlobalEntryGate } from "../src/risk/global-entry-gate.ts";
import { portfolioOpenRisk } from "../src/risk/portfolio-open-risk.ts";

const symbol = "BTC-USDT-SWAP";
const instrument = { instId: symbol, tickSz: "0.01", lotSz: "1", minSz: "1", ctVal: "1", ctValCcy: "USDT" };
const entryMs = 1_700_000_000_000;
const exitMs = entryMs + 120_000;

function withStore(t: test.TestContext) {
  const root = mkdtempSync(path.join(os.tmpdir(), "evoq-evidence-"));
  const store = openStore(root);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  return store;
}

function unresolvedTrade(store: ReturnType<typeof openStore>, tradeId = "TRD-EVIDENCE") {
  store.db.prepare(`INSERT INTO trades(trade_id,engine,status,instrument,timeframe,side,strategy,strategy_version,regime,contracts,
    entry_px,entry_ts,stop_px,initial_stop_px,take_profit_px)
    VALUES(?,'SWING_15M','OPEN',?,'15m','LONG','TREND_FOLLOWING',1,'SIDEWAYS','1',?, ?,98,98,106)`)
    .run(tradeId, symbol, 100, new Date(entryMs).toISOString());
  return store.db.prepare("SELECT * FROM trades WHERE trade_id=?").get(tradeId) as Record<string, unknown>;
}

function depsFor(store: ReturnType<typeof openStore>, response: (path: string, query?: Record<string, unknown>) => unknown,
  post: (path: string, body?: unknown) => unknown = () => []): ExecutorDeps {
  return {
    store,
    client: { get: async (endpoint: string, query?: Record<string, unknown>) => endpoint === "/api/v5/trade/orders-algo-pending" ? [] : response(endpoint, query), post: async (endpoint: string, body?: unknown) => post(endpoint, body) },
    trading: { timeframe: "15m" }, risk: {}, instruments: { [symbol]: instrument }, watchlist: [symbol],
  } as unknown as ExecutorDeps;
}

const candleRows = [
  [String(entryMs), "100", "102", "99", "101", "1", "1", "1"],
  [String(exitMs), "101", "106", "100", "105", "1", "1", "1"],
];

test("a disappeared position remains unresolved until a reliable exit fill is found", async t => {
  const store = withStore(t);
  const row = unresolvedTrade(store);
  store.db.prepare("UPDATE trades SET sl_algo_id='SL',tp_algo_id='TP',algo_id='SL' WHERE trade_id='TRD-EVIDENCE'").run();
  let history: Array<Record<string, string>> = [];
  const deps = depsFor(store, (endpoint) => {
    if (endpoint === "/api/v5/trade/fills") return [];
    if (endpoint === "/api/v5/trade/fills-history") return history;
    if (endpoint === "/api/v5/trade/order-algo") return [{ state: "effective", instId: symbol, posSide: "long", sz: "1" }];
    if (endpoint === "/api/v5/market/candles") return candleRows;
    throw new Error(`unexpected endpoint ${endpoint}`);
  });
  await finalizeOpenTradeFromExchange(deps, row);
  let saved = store.db.prepare("SELECT status,exit_px,result_r,evolution_evidence_eligible FROM trades WHERE trade_id='TRD-EVIDENCE'").get() as Record<string, unknown>;
  assert.deepEqual(saved, { status: "RECONCILIATION_PENDING", exit_px: null, result_r: null, evolution_evidence_eligible: 0 });

  history = [{ instId: symbol, tradeId: "F1", ordId: "O-CLOSE", fillPx: "105", fillSz: "1", side: "sell", posSide: "long", execType: "T", ts: String(exitMs), fee: "0.1", feeCcy: "USDT" }];
  await finalizeOpenTradeFromExchange(deps, store.db.prepare("SELECT * FROM trades WHERE trade_id='TRD-EVIDENCE'").get() as Record<string, unknown>);
  saved = store.db.prepare("SELECT status,exit_px,result_r,evidence_state,evolution_evidence_eligible FROM trades WHERE trade_id='TRD-EVIDENCE'").get() as Record<string, unknown>;
  assert.deepEqual(saved, { status: "CLOSED", exit_px: 105, result_r: null, evidence_state: "EVIDENCE_PENDING", evolution_evidence_eligible: 0 });
});

test("SCP-67624603 regression: repeated recent/history ADA fills finalize only the 13 unique executions", async t => {
  const store = withStore(t);
  const instId = "ADA-USDT-SWAP";
  const orderId = "4015329050973376512";
  const entry = entryMs + 5_000;
  const exit = entry + 120_000;
  store.db.prepare(`INSERT INTO trades(trade_id,engine,status,evidence_state,evolution_evidence_eligible,instrument,timeframe,side,strategy,
    strategy_version,regime,contracts,entry_px,entry_ts,stop_px,initial_stop_px,take_profit_px,ord_open_id,ord_close_id,sl_algo_id,tp_algo_id,algo_id)
    VALUES('SCP-67624603','SCALP_5M','RECONCILIATION_PENDING','RECONCILIATION_PENDING',0,?,'scalp','LONG','SCALP',1,
      'SIDEWAYS','0.84',0.2254,?,0.22,0.22,0.24,'ADA-OPEN',?,'SL-ADA','TP-ADA','SL-ADA')`)
    .run(instId, new Date(entry).toISOString(), orderId);
  const fills = Array.from({ length: 13 }, (_, index) => ({
    instId, tradeId: `ADA-FILL-${index + 1}`, billId: `ADA-BILL-${index + 1}`, ordId: orderId,
    fillPx: "0.225", fillSz: index === 12 ? "0.12" : "0.06", side: "sell", posSide: "long", execType: "T",
    ts: String(exit + index), fee: index === 12 ? "-0.00105" : "-0.0007", feeCcy: "USDT",
  }));
  const deps = {
    store, trading: { timeframe: "15m" }, risk: {}, instruments: { [instId]: { ...instrument, instId, tickSz: "0.0001" } }, watchlist: [instId],
    client: { get: async (endpoint: string, query?: Record<string, unknown>) => {
      if (endpoint === "/api/v5/trade/fills") return query?.ordId === orderId ? fills.map(({ billId: _billId, ...fill }) => fill) : [];
      if (endpoint === "/api/v5/trade/fills-history") return fills;
      if (endpoint === "/api/v5/trade/order-algo") return [{ algoId: String(query?.algoId), state: "effective" }];
      if (endpoint === "/api/v5/trade/orders-algo-pending") return [];
      if (endpoint === "/api/v5/market/candles") return [];
      throw new Error(`unexpected endpoint ${endpoint}`);
    }, post: async () => [] },
  } as unknown as ExecutorDeps;

  const pendingAda = store.db.prepare("SELECT * FROM trades WHERE trade_id='SCP-67624603'").get() as Record<string, unknown>;
  await Promise.all([finalizeOpenTradeFromExchange(deps, pendingAda), finalizeOpenTradeFromExchange(deps, pendingAda)]);
  const result = store.db.prepare(`SELECT status,exit_px,exit_confirmation,evidence_state,evolution_evidence_eligible,
    (SELECT COUNT(*) FROM fills WHERE ordId=?) AS unique_fills,
    (SELECT SUM(CAST(fillSz AS REAL)) FROM fills WHERE ordId=?) AS unique_contracts
    FROM trades WHERE trade_id='SCP-67624603'`).get(orderId, orderId) as Record<string, unknown>;
  assert.deepEqual(result, { status: "CLOSED", exit_px: 0.225, exit_confirmation: "EXCHANGE_FILL_CONFIRMED",
    evidence_state: "EVIDENCE_PENDING", evolution_evidence_eligible: 0, unique_fills: 13, unique_contracts: 0.84 });
  const signedFees = store.db.prepare("SELECT SUM(CAST(fee AS REAL)) AS fees FROM fills WHERE ordId=?").get(orderId) as { fees: number };
  assert.ok(Math.abs(signedFees.fees - (-0.00945)) < 1e-12);
});

test("fill-provider failures never fabricate a breakeven exit", async t => {
  const store = withStore(t);
  const row = unresolvedTrade(store, "TRD-FILL-ERROR");
  const deps = depsFor(store, () => { throw new Error("provider unavailable"); });
  await finalizeOpenTradeFromExchange(deps, row);
  const saved = store.db.prepare("SELECT status,exit_px,result_r FROM trades WHERE trade_id='TRD-FILL-ERROR'").get();
  assert.deepEqual(saved, { status: "RECONCILIATION_PENDING", exit_px: null, result_r: null });
});

test("scalp excursion requests confirmed 1m candles and unavailable coverage stays nullable", async () => {
  let bar = "";
  const client = { get: async (endpoint: string, query?: Record<string, unknown>) => {
    assert.equal(endpoint, "/api/v5/market/candles");
    bar = String(query?.bar);
    return candleRows;
  } };
  const rows = await excursionCandles({ client, trading: { timeframe: "15m" } } as unknown as Pick<ExecutorDeps, "client" | "trading">,
    { engine: "SCALP_5M", instrument: symbol, timeframe: "scalp" }, entryMs, exitMs);
  assert.equal(bar, "1m");
  assert.equal(rows?.length, 2);
  const unavailable = computeClosedMetrics({ side: "LONG", entryPx: 100, stopPx: 98, exitPx: 100, contracts: 1, ctVal: 1,
    exitReason: "TP", entryTs: new Date(entryMs).toISOString(), exitTs: new Date(exitMs).toISOString(), candlesWhileOpen: null, fees: 0, funding: null });
  assert.equal(unavailable.mfe, null);
  assert.equal(unavailable.mae, null);
});

test("reviewer schema rejects AI-authored deterministic outcomes and accounting marks funding gaps", t => {
  assert.equal(ReviewSchema.safeParse({ outcome: "WIN", result_r: 99, observations: [], lesson_candidates: [] }).success, false);
  const store = withStore(t);
  unresolvedTrade(store, "TRD-ACCOUNTING");
  closeTrade(store, "TRD-ACCOUNTING", { exitPx: 104, exitTs: new Date(exitMs).toISOString(), exitReason: "FILL_CONFIRM",
    fees: 0.1, funding: null, pnl: 3.9, pnlPct: 4, resultR: 1.95, mfe: 4, mae: 0, durationS: 120 });
  const saved = store.db.prepare("SELECT result_r,result_r_basis,accounting_quality,evidence_state,evolution_evidence_eligible FROM trades WHERE trade_id='TRD-ACCOUNTING'").get();
  assert.deepEqual(saved, { result_r: null, result_r_basis: "PENDING", accounting_quality: "FUNDING_PENDING", evidence_state: "EVIDENCE_PENDING", evolution_evidence_eligible: 0 });
});

test("five shared slots and the portfolio stop-risk cap reject a sixth or excessive candidate", () => {
  const risk = { hard_limits: { allowed_symbols: [symbol], max_concurrent_positions: 5, max_portfolio_open_risk_pct: 4 } } as never;
  const input = { killSwitchActive: null, botState: "RUNNING" as const, openPositions: 4, instrument: symbol, instrumentOccupied: false,
    portfolioOpenRiskPct: 3.4, candidateRiskPct: 0.5 };
  assert.equal(evaluateGlobalEntryGate(input, risk).allowed, true);
  assert.equal(evaluateGlobalEntryGate({ ...input, openPositions: 5 }, risk).reason, "MAX_CONCURRENT_POSITIONS");
  assert.equal(evaluateGlobalEntryGate({ ...input, candidateRiskPct: 0.7 }, risk).reason, "PORTFOLIO_OPEN_RISK_LIMIT");
  const tenPercentTradeRisk = { hard_limits: { allowed_symbols: [symbol], max_concurrent_positions: 5, max_portfolio_open_risk_pct: 5 } } as never;
  assert.equal(evaluateGlobalEntryGate({ ...input, portfolioOpenRiskPct: 0, candidateRiskPct: 8 }, tenPercentTradeRisk).reason,
    "PORTFOLIO_OPEN_RISK_LIMIT", "a valid 10% per-trade ceiling never overrides the 5% portfolio cap");
  assert.equal(evaluateGlobalEntryGate({ ...input, instrumentOccupied: true }, risk).reason, "INSTRUMENT_ALREADY_OCCUPIED");
  const snapshot = portfolioOpenRisk({ equity: 1_000, positions: [{ posId: "P", instId: symbol, posSide: "long", pos: "2", avgPx: "100", markPx: "100", lever: "3", upl: "0", mgnMode: "isolated" }],
    trades: [{ instrument: symbol, side: "LONG", stop_px: 83 }], instruments: { [symbol]: instrument } });
  assert.deepEqual(snapshot, { known: true, lossToStops: 34, riskPct: 3.4000000000000004, unavailable: [] });
});

test("open-position protection requires exact exchange position readback and can recover after outage", async t => {
  const store = withStore(t); unresolvedTrade(store, "TRD-PROTECTION-READBACK");
  store.db.prepare(`UPDATE trades SET sl_algo_id='SL-1',tp_algo_id='TP-1',algo_id='SL-1',protection_state='DEGRADED',
    protection_checked_at='2020-01-01T00:00:00.000Z' WHERE trade_id='TRD-PROTECTION-READBACK'`).run();
  const deps = depsFor(store, endpoint => {
    if (endpoint === "/api/v5/account/positions") throw new Error("temporary positions outage");
    throw new Error(`unexpected endpoint ${endpoint}`);
  });
  assert.equal(await verifyOpenTradeProtection(deps, symbol), false);
  assert.equal((store.db.prepare("SELECT protection_state FROM trades WHERE trade_id='TRD-PROTECTION-READBACK'").get() as { protection_state: string }).protection_state, "DEGRADED");
  assert.equal(getBotState(store), "RISK_HALTED");

  store.db.prepare("UPDATE trades SET protection_checked_at='2020-01-01T00:00:00.000Z' WHERE trade_id='TRD-PROTECTION-READBACK'").run();
  const recovered = depsFor(store, (endpoint, query) => {
    if (endpoint === "/api/v5/account/positions") return [{ instId: symbol, posSide: "long", pos: "1" }];
    if (endpoint === "/api/v5/trade/order-algo") {
      const id = String(query?.algoId);
      return [{ algoId: id, state: "live", instId: symbol, tdMode: "isolated", side: "sell", ordType: "conditional",
        posSide: "long", sz: "1", slTriggerPx: id === "SL-1" ? "98" : "", slTriggerPxType: "mark",
        tpTriggerPx: id === "TP-1" ? "106" : "", tpTriggerPxType: "mark" }];
    }
    throw new Error(`unexpected endpoint ${endpoint}`);
  });
  assert.equal(await verifyOpenTradeProtection(recovered, symbol), true);
  assert.equal((store.db.prepare("SELECT protection_state FROM trades WHERE trade_id='TRD-PROTECTION-READBACK'").get() as { protection_state: string }).protection_state, "VERIFIED");
});

test("a live position with unverified native protection remains halted", async t => {
  const store = withStore(t); unresolvedTrade(store, "TRD-LIVE-UNPROTECTED");
  store.db.prepare("UPDATE trades SET sl_algo_id=NULL,tp_algo_id=NULL,algo_id=NULL WHERE trade_id='TRD-LIVE-UNPROTECTED'").run();
  setEmergencyHalted(store, false);
  const deps = depsFor(store, endpoint => {
    if (endpoint === "/api/v5/account/positions") return [{ instId: symbol, posSide: "long", pos: "1" }];
    throw new Error(`unexpected endpoint ${endpoint}`);
  });
  assert.equal(await verifyOpenTradeProtection(deps), false);
  assert.equal(getBotState(store), "RISK_HALTED");
  assert.equal(getRiskHaltReason(store), "LIVE_POSITION_PROTECTION_UNVERIFIED");
});

test("restart recovery resolves filled-entry algo client IDs without placing duplicate protection", async t => {
  const store = withStore(t); unresolvedTrade(store, "TRD-ENTRY-PROTECTION-PENDING");
  store.db.prepare(`UPDATE trades SET sl_algo_id=NULL,tp_algo_id=NULL,algo_id=NULL,
    sl_algo_cl_ord_id='CL-ENTRY-SL',tp_algo_cl_ord_id='CL-ENTRY-TP',protection_state='ENTRY_FILLED_PROTECTION_PENDING',
    protection_checked_at='2020-01-01T00:00:00.000Z' WHERE trade_id='TRD-ENTRY-PROTECTION-PENDING'`).run();
  const deps = depsFor(store, (endpoint, query) => {
    if (endpoint === "/api/v5/account/positions") return [{ instId: symbol, posSide: "long", pos: "1" }];
    if (endpoint === "/api/v5/trade/order-algo" && query?.algoClOrdId) {
      const isStop = query.algoClOrdId === "CL-ENTRY-SL";
      return [{ algoId: isStop ? "SL-RECOVERED" : "TP-RECOVERED" }];
    }
    if (endpoint === "/api/v5/trade/order-algo" && query?.algoId) {
      const isStop = query.algoId === "SL-RECOVERED";
      return [{ algoId: String(query.algoId), state: "live", instId: symbol, tdMode: "isolated", side: "sell", ordType: "conditional",
        posSide: "long", sz: "1", slTriggerPx: isStop ? "98" : "", slTriggerPxType: "mark",
        tpTriggerPx: isStop ? "" : "106", tpTriggerPxType: "mark" }];
    }
    throw new Error(`unexpected endpoint ${endpoint}`);
  });
  assert.equal(await verifyOpenTradeProtection(deps), true);
  assert.deepEqual(store.db.prepare(`SELECT sl_algo_id,tp_algo_id,protection_state FROM trades WHERE trade_id='TRD-ENTRY-PROTECTION-PENDING'`).get(),
    { sl_algo_id: "SL-RECOVERED", tp_algo_id: "TP-RECOVERED", protection_state: "VERIFIED" });
});

test("flat RECONCILIATION_PENDING trade without historical algo IDs is not an active protection failure", async t => {
  const store = withStore(t);
  unresolvedTrade(store, "TRD-FLAT-PENDING");
  store.db.prepare(`UPDATE trades SET status='RECONCILIATION_PENDING',evidence_state='RECONCILIATION_PENDING',
    evidence_reason='EXIT_FILL_NOT_PROVEN',protection_state='DEGRADED',sl_algo_id=NULL,tp_algo_id=NULL,algo_id=NULL
    WHERE trade_id='TRD-FLAT-PENDING'`).run();
  const deps = depsFor(store, endpoint => {
    if (endpoint === "/api/v5/account/positions") return [];
    throw new Error(`unexpected endpoint ${endpoint}`);
  });
  setBotState(store, "RUNNING");
  assert.equal(await verifyOpenTradeProtection(deps), true);
  assert.equal(getBotState(store), "RUNNING");
  assert.deepEqual(store.db.prepare("SELECT status,protection_state,evidence_state,evolution_evidence_eligible FROM trades WHERE trade_id='TRD-FLAT-PENDING'").get(),
    { status: "RECONCILIATION_PENDING", protection_state: "EXITED_PENDING_ACCOUNTING", evidence_state: "RECONCILIATION_PENDING", evolution_evidence_eligible: 0 });
});

test("fill normalization removes endpoint overlap but preserves distinct partial executions", () => {
  const partials = [
    { instId: symbol, ordId: "O", tradeId: "F1", billId: "B1", ts: "100", fillPx: "10", fillSz: "0.2", fee: "-0.01", feeCcy: "USDT", side: "sell" as const, posSide: "long" as const, execType: "T" as const },
    { instId: symbol, ordId: "O", tradeId: "F2", billId: "B2", ts: "100", fillPx: "11", fillSz: "0.3", fee: "-0.02", feeCcy: "USDT", side: "sell" as const, posSide: "long" as const, execType: "T" as const },
  ];
  const result = deduplicateFills([...partials, ...partials]);
  assert.equal(result.fills.length, 2);
  assert.equal(result.duplicateCount, 2);
  assert.equal(result.conflicts, 0);
  assert.equal(result.fills.reduce((sum, fill) => sum + Number(fill.fillSz), 0), 0.5);
  const conflict = deduplicateFills([partials[0]!, { ...partials[0]!, fillSz: "0.4" }]);
  assert.equal(conflict.fills.length, 1);
  assert.equal(conflict.conflicts, 1);
  const { billId: _billId, ...legacyNoBillId } = partials[0]!;
  const legacy = deduplicateFills([legacyNoBillId, legacyNoBillId]);
  assert.equal(legacy.fills.length, 1, "tradeId and timestamp provide a conservative legacy identity");
  assert.equal(legacy.duplicateCount, 1);
  const overlappingSources = deduplicateFills([legacyNoBillId, partials[0]!]);
  assert.equal(overlappingSources.fills.length, 1, "recent fills without billId must match historical fills that include it");
  assert.equal(overlappingSources.conflicts, 0);
});

test("protection-owned halt clears only after fresh flat account and risk verification", async t => {
  const store = withStore(t);
  setBotState(store, "RISK_HALTED");
  setRiskHaltReason(store, "LIVE_POSITION_PROTECTION_UNVERIFIED");
  setEmergencyHalted(store, false);
  const now = Date.now();
  const deps = depsFor(store, endpoint => {
    if (endpoint === "/api/v5/account/balance") return [{ details: [{ ccy: "USDT", eq: "100", availEq: "100", availBal: "100" }] }];
    if (endpoint === "/api/v5/public/time") return [{ ts: String(now) }];
    if (endpoint === "/api/v5/account/positions") return [];
    if (endpoint === "/api/v5/trade/orders-pending" || endpoint === "/api/v5/trade/orders-algo-pending") return [];
    throw new Error(`unexpected endpoint ${endpoint}`);
  });
  (deps as unknown as { risk: Record<string, unknown> }).risk = {
    clock_drift_max_ms: 60_000,
    hard_limits: { max_concurrent_positions: 5, max_daily_loss_pct: 3, max_drawdown_pct: 10 },
  };
  assert.equal(await recoverProtectionHalt(deps), true);
  assert.equal(getBotState(store), "RUNNING");
  assert.equal(getRiskHaltReason(store), null);
});

test("protection recovery cannot clear a daily-loss halt or an active manual kill switch", async t => {
  const store = withStore(t);
  setBotState(store, "RISK_HALTED");
  setRiskHaltReason(store, "KILL_SWITCH:MAX_DAILY_LOSS_REACHED");
  setEmergencyHalted(store, false);
  const deps = depsFor(store, () => { throw new Error("must not query for an unrelated halt"); });
  assert.equal(await recoverProtectionHalt(deps), false);
  assert.equal(getBotState(store), "RISK_HALTED");
  assert.equal(getRiskHaltReason(store), "KILL_SWITCH:MAX_DAILY_LOSS_REACHED");
});

test("safe halt recovery stays blocked by an orphan conditional algo or pending order", async t => {
  const store = withStore(t);
  setBotState(store, "RISK_HALTED");
  setRiskHaltReason(store, "EXIT_PROTECTION_CLEANUP_UNVERIFIED");
  setEmergencyHalted(store, false);
  const deps = depsFor(store, endpoint => {
    if (endpoint === "/api/v5/account/balance") return [{ details: [{ ccy: "USDT", eq: "100" }] }];
    if (endpoint === "/api/v5/public/time") return [{ ts: String(Date.now()) }];
    if (endpoint === "/api/v5/account/positions") return [];
    if (endpoint === "/api/v5/trade/orders-pending") return [];
    throw new Error(`unexpected endpoint ${endpoint}`);
  });
  (deps as unknown as { risk: Record<string, unknown> }).risk = {
    clock_drift_max_ms: 60_000,
    hard_limits: { max_concurrent_positions: 5, max_daily_loss_pct: 3, max_drawdown_pct: 10 },
  };
  const withOrphanAlgo = { ...deps, client: { ...deps.client, get: async (endpoint: string, query?: Record<string, unknown>) =>
    endpoint === "/api/v5/trade/orders-algo-pending" ? [{ algoId: "ORPHAN", instId: symbol, posSide: "long" }]
      : (deps.client.get as (endpoint: string, query?: Record<string, unknown>) => Promise<unknown>)(endpoint, query) } } as unknown as ExecutorDeps;
  assert.equal(await recoverProtectionHalt(withOrphanAlgo), false);
  assert.equal(getBotState(store), "RISK_HALTED");
});

test("repeated unresolved exit evidence escalates without fabricating a financial result", async t => {
  const store = withStore(t); zombieExit(store, "SCP-REVIEW-REQUIRED");
  store.db.prepare(`UPDATE trades SET exit_reconcile_attempts=7,exit_reconcile_next_retry_ts='2000-01-01T00:00:00.000Z'
    WHERE trade_id='SCP-REVIEW-REQUIRED'`).run();
  const deps = depsFor(store, endpoint => {
    if (endpoint === "/api/v5/account/positions") return [];
    if (endpoint === "/api/v5/trade/fills" || endpoint === "/api/v5/trade/fills-history") return [];
    throw new Error(`unexpected endpoint ${endpoint}`);
  });
  assert.equal(await sweepUnprovenExits(deps), 0);
  const after = store.db.prepare(`SELECT status,evidence_state,evolution_evidence_eligible,result_r,exit_reconcile_attempts,
    exit_reconcile_state,exit_reconcile_last_failure_reason FROM trades WHERE trade_id='SCP-REVIEW-REQUIRED'`).get();
  assert.deepEqual(after, { status: "RECONCILIATION_PENDING", evidence_state: "RECONCILIATION_PENDING",
    evolution_evidence_eligible: 0, result_r: null, exit_reconcile_attempts: 8,
    exit_reconcile_state: "ACCOUNTING_REVIEW_REQUIRED", exit_reconcile_last_failure_reason: "EXIT_FILL_NOT_PROVEN" });
  assert.equal(await sweepUnprovenExits(deps), 0, "review escalation backs off rather than retrying each cycle");
  assert.equal((store.db.prepare("SELECT exit_reconcile_attempts FROM trades WHERE trade_id='SCP-REVIEW-REQUIRED'").get() as { exit_reconcile_attempts: number }).exit_reconcile_attempts, 8);
});

function zombieExit(store: ReturnType<typeof openStore>, tradeId = "SCP-ZOMBIE") {
  store.db.prepare(`INSERT INTO trades(trade_id,engine,status,instrument,timeframe,side,strategy,strategy_version,regime,contracts,
    entry_px,entry_ts,stop_px,initial_stop_px,take_profit_px,ord_open_id,ord_close_id,cl_close_id,algo_id,sl_algo_id,tp_algo_id)
    VALUES(?,'SCALP_5M','RECONCILIATION_PENDING',?,'scalp','LONG','SCALP_V1',1,'TRENDING_BULLISH','1',?, ?,1.397,1.397,1.425,'OPEN-Z','CLOSE-Z','CL-Z','SL-Z','SL-Z','TP-Z')`)
    .run(tradeId, symbol, 1.4, new Date(entryMs).toISOString());
  store.db.prepare("UPDATE trades SET evidence_state='RECONCILIATION_PENDING', evidence_reason='EXIT_FILL_NOT_PROVEN' WHERE trade_id=?").run(tradeId);
}

test("zombie exit sweep heals RECONCILIATION_PENDING once the exchange fill is readable", async t => {
  const store = withStore(t); zombieExit(store);
  const exitFill = [{ instId: symbol, tradeId: "FZ", ordId: "CLOSE-Z", fillPx: "140", fillSz: "1", side: "sell", posSide: "long", execType: "T", ts: String(exitMs), fee: "-0.01", feeCcy: "USDT" }];
  const healed = await sweepUnprovenExits(depsFor(store, (endpoint, query) => {
    if (endpoint === "/api/v5/account/positions") return [];
    if (endpoint === "/api/v5/trade/fills") return [];
    if (endpoint === "/api/v5/trade/order-algo") return [{ algoId: String(query?.algoId), state: "effective", instId: symbol, posSide: "long", sz: "1" }];
    if (endpoint === "/api/v5/trade/fills" && query?.ordId === "CLOSE-Z") return [];
    if (endpoint === "/api/v5/trade/fills-history") return exitFill;
    if (endpoint === "/api/v5/market/candles") return [];
    throw new Error(`unexpected endpoint ${endpoint}`);
  }));
  assert.equal(healed, 1);
  const row = store.db.prepare("SELECT status,exit_px,exit_reason,exit_confirmation,ord_close_id FROM trades WHERE trade_id='SCP-ZOMBIE'").get() as Record<string, unknown>;
  assert.deepEqual(row, { status: "CLOSED", exit_px: 140, exit_reason: "EXCHANGE_CLOSE_UNCLASSIFIED",
    exit_confirmation: "EXCHANGE_FILL_CONFIRMED", ord_close_id: "CLOSE-Z" });
});

test("reconciliation preserves a known strategic exit reason separately from fill confirmation", async t => {
  const store = withStore(t); zombieExit(store, "SCP-EXIT-REASON");
  store.db.prepare("UPDATE trades SET exit_reason='SL' WHERE trade_id='SCP-EXIT-REASON'").run();
  const exitFill = [{ instId: symbol, tradeId: "FZ2", ordId: "CLOSE-Z", fillPx: "140", fillSz: "1", side: "sell", posSide: "long", execType: "T", ts: String(exitMs), fee: "-0.01", feeCcy: "USDT" }];
  await sweepUnprovenExits(depsFor(store, (endpoint, query) => {
    if (endpoint === "/api/v5/account/positions") return [];
    if (endpoint === "/api/v5/trade/fills") return [];
    if (endpoint === "/api/v5/trade/order-algo") return [{ algoId: String(query?.algoId), state: "effective", instId: symbol, posSide: "long", sz: "1" }];
    if (endpoint === "/api/v5/trade/fills" && query?.ordId === "CLOSE-Z") return [];
    if (endpoint === "/api/v5/trade/fills-history") return exitFill;
    if (endpoint === "/api/v5/market/candles") return [];
    throw new Error(`unexpected endpoint ${endpoint}`);
  }));
  const row = store.db.prepare("SELECT exit_reason,exit_confirmation FROM trades WHERE trade_id='SCP-EXIT-REASON'").get() as Record<string, unknown>;
  assert.deepEqual(row, { exit_reason: "SL", exit_confirmation: "EXCHANGE_FILL_CONFIRMED" });
});

test("proven exchange exit cancels and confirms both independent protection legs before closing", async t => {
  const store = withStore(t); zombieExit(store, "SCP-CANCEL-SIBLING");
  const exitFill = [{ instId: symbol, tradeId: "FC", ordId: "CLOSE-Z", fillPx: "140", fillSz: "1", side: "sell", posSide: "long", execType: "T", ts: String(exitMs), fee: "-0.01", feeCcy: "USDT" }];
  const states = new Map([ ["SL-Z", "live"], ["TP-Z", "live"] ]);
  const canceled: string[] = [];
  await finalizeOpenTradeFromExchange(depsFor(store, (endpoint, query) => {
    if (endpoint === "/api/v5/trade/fills") return [];
    if (endpoint === "/api/v5/trade/fills-history") return exitFill;
    if (endpoint === "/api/v5/market/candles") return candleRows;
    if (endpoint === "/api/v5/trade/order-algo") {
      const algoId = String(query?.algoId);
      return [{ algoId, state: states.get(algoId), instId: symbol, posSide: "long", sz: "1" }];
    }
    throw new Error(`unexpected endpoint ${endpoint}`);
  }, (endpoint, body) => {
    assert.equal(endpoint, "/api/v5/trade/cancel-algos");
    for (const item of body as Array<{ algoId: string }>) { canceled.push(item.algoId); states.set(item.algoId, "canceled"); }
    return [{ sCode: "0" }];
  }), store.db.prepare("SELECT * FROM trades WHERE trade_id='SCP-CANCEL-SIBLING'").get() as Record<string, unknown>);
  assert.deepEqual(canceled.sort(), ["SL-Z", "TP-Z"]);
  assert.equal((store.db.prepare("SELECT status FROM trades WHERE trade_id='SCP-CANCEL-SIBLING'").get() as { status: string }).status, "CLOSED");
});

test("protection cleanup failure preserves the strategic exit reason and retries to a confirmed close", async t => {
  const store = withStore(t); zombieExit(store, "SCP-CLEANUP-RETRY");
  store.db.prepare("UPDATE trades SET exit_reason='SL' WHERE trade_id='SCP-CLEANUP-RETRY'").run();
  const exitFill = [{ instId: symbol, tradeId: "FCR", ordId: "CLOSE-Z", fillPx: "140", fillSz: "1", side: "sell", posSide: "long", execType: "T", ts: String(exitMs), fee: "-0.01", feeCcy: "USDT" }];
  let failFirstCancel = true;
  const states = new Map([["SL-Z", "live"], ["TP-Z", "live"]]);
  const deps = depsFor(store, (endpoint, query) => {
    if (endpoint === "/api/v5/account/positions") return [];
    if (endpoint === "/api/v5/trade/fills") return [];
    if (endpoint === "/api/v5/trade/fills-history") return exitFill;
    if (endpoint === "/api/v5/market/candles") return candleRows;
    if (endpoint === "/api/v5/trade/order-algo") {
      const algoId = String(query?.algoId);
      return [{ algoId, state: states.get(algoId), instId: symbol, posSide: "long", sz: "1" }];
    }
    throw new Error(`unexpected endpoint ${endpoint}`);
  }, (_endpoint, body) => {
    const ids = body as Array<{ algoId: string }>;
    if (failFirstCancel) {
      failFirstCancel = false;
      return ids.map(item => ({ algoId: item.algoId, sCode: "500", sMsg: "temporary cancel failure" }));
    }
    for (const item of ids) states.set(item.algoId, "canceled");
    return ids.map(item => ({ algoId: item.algoId, sCode: "0" }));
  });

  await finalizeOpenTradeFromExchange(deps, store.db.prepare("SELECT * FROM trades WHERE trade_id='SCP-CLEANUP-RETRY'").get() as Record<string, unknown>);
  let row = store.db.prepare("SELECT status,exit_reason,exit_confirmation,protection_state FROM trades WHERE trade_id='SCP-CLEANUP-RETRY'").get() as Record<string, unknown>;
  assert.deepEqual(row, { status: "RECONCILIATION_PENDING", exit_reason: "SL", exit_confirmation: null, protection_state: "DEGRADED" });
  assert.equal(getBotState(store), "RISK_HALTED");

  store.db.prepare("UPDATE trades SET exit_reconcile_next_retry_ts=NULL WHERE trade_id='SCP-CLEANUP-RETRY'").run();
  assert.equal(await sweepUnprovenExits(deps), 1);
  row = store.db.prepare("SELECT status,exit_reason,exit_confirmation FROM trades WHERE trade_id='SCP-CLEANUP-RETRY'").get() as Record<string, unknown>;
  assert.deepEqual(row, { status: "CLOSED", exit_reason: "SL", exit_confirmation: "EXCHANGE_FILL_CONFIRMED" });
});

test("zombie exit sweep never touches rows the exchange still holds", async t => {
  const store = withStore(t); zombieExit(store, "SCP-LIVE");
  const healed = await sweepUnprovenExits(depsFor(store, (endpoint) => {
    if (endpoint === "/api/v5/account/positions") return [{ instId: symbol, posSide: "long", pos: "1", avgPx: "100", markPx: "105", lever: "5", upl: "5" }];
    throw new Error(`unexpected endpoint ${endpoint}`);
  }));
  assert.equal(healed, 0);
  assert.equal((store.db.prepare("SELECT status FROM trades WHERE trade_id='SCP-LIVE'").get() as { status: string }).status, "RECONCILIATION_PENDING");
});

test("unproven exit reconciliation persists its retry backoff instead of polling each cycle", async t => {
  const store = withStore(t); zombieExit(store, "SCP-RETRY-BACKOFF");
  await sweepUnprovenExits(depsFor(store, endpoint => {
    if (endpoint === "/api/v5/account/positions") return [];
    if (endpoint === "/api/v5/trade/fills" || endpoint === "/api/v5/trade/fills-history") return [];
    throw new Error(`unexpected endpoint ${endpoint}`);
  }));
  const saved = store.db.prepare(`SELECT exit_reconcile_attempts,exit_reconcile_last_attempt_ts,exit_reconcile_next_retry_ts
    FROM trades WHERE trade_id='SCP-RETRY-BACKOFF'`).get() as Record<string, unknown>;
  assert.equal(saved.exit_reconcile_attempts, 1);
  assert.ok(Date.parse(String(saved.exit_reconcile_next_retry_ts)) > Date.parse(String(saved.exit_reconcile_last_attempt_ts)));
  assert.equal(await sweepUnprovenExits(depsFor(store, () => { throw new Error("backoff should avoid an exchange request"); })), 0);
});

test("zombie exit sweep is inert without candidates and reports per-cycle kill reason", async t => {
  const store = withStore(t);
  const healed = await sweepUnprovenExits(depsFor(store, () => { throw new Error("exchange must not be queried"); }));
  assert.equal(healed, 0);
  // kill reason is per-cycle state: the global tick resets it before any runTick can stale-cache an old reason.
  resetLastKillReason();
  assert.equal(getLastKillReason(), null);
});
