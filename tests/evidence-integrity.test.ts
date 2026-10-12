import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ReviewSchema } from "../src/agents/reviewer-agent.ts";
import { excursionCandles, finalizeOpenTradeFromExchange, sweepUnprovenExits, resetLastKillReason, getLastKillReason, type ExecutorDeps } from "../src/execution/executor.ts";
import { openStore } from "../src/memory/db.ts";
import { closeTrade, computeClosedMetrics } from "../src/memory/trades.ts";
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

function depsFor(store: ReturnType<typeof openStore>, response: (path: string, query?: Record<string, unknown>) => unknown): ExecutorDeps {
  return {
    store,
    client: { get: async (endpoint: string, query?: Record<string, unknown>) => response(endpoint, query), post: async () => [] },
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
  let history: Array<Record<string, string>> = [];
  const deps = depsFor(store, (endpoint) => {
    if (endpoint === "/api/v5/trade/fills" || endpoint === "/api/v5/trade/fills-history") return history;
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

function zombieExit(store: ReturnType<typeof openStore>, tradeId = "SCP-ZOMBIE") {
  store.db.prepare(`INSERT INTO trades(trade_id,engine,status,instrument,timeframe,side,strategy,strategy_version,regime,contracts,
    entry_px,entry_ts,stop_px,initial_stop_px,take_profit_px,ord_open_id,ord_close_id,cl_close_id)
    VALUES(?,'SCALP_5M','RECONCILIATION_PENDING',?,'scalp','LONG','SCALP_V1',1,'TRENDING_BULLISH','1',?, ?,1.397,1.397,1.425,'OPEN-Z','CLOSE-Z','CL-Z')`)
    .run(tradeId, symbol, 1.4, new Date(entryMs).toISOString());
  store.db.prepare("UPDATE trades SET evidence_state='RECONCILIATION_PENDING', evidence_reason='EXIT_FILL_NOT_PROVEN' WHERE trade_id=?").run(tradeId);
}

test("zombie exit sweep heals RECONCILIATION_PENDING once the exchange fill is readable", async t => {
  const store = withStore(t); zombieExit(store);
  const exitFill = [{ instId: symbol, tradeId: "FZ", ordId: "CLOSE-Z", fillPx: "140", fillSz: "1", side: "sell", posSide: "long", execType: "T", ts: String(exitMs), fee: "-0.01", feeCcy: "USDT" }];
  const healed = await sweepUnprovenExits(depsFor(store, (endpoint, query) => {
    if (endpoint === "/api/v5/account/positions") return [];
    if (endpoint === "/api/v5/trade/fills" && query?.ordId === "CLOSE-Z") return [];
    if (endpoint === "/api/v5/trade/fills-history") return exitFill;
    if (endpoint === "/api/v5/market/candles") return [];
    throw new Error(`unexpected endpoint ${endpoint}`);
  }));
  assert.equal(healed, 1);
  const row = store.db.prepare("SELECT status,exit_px,exit_reason FROM trades WHERE trade_id='SCP-ZOMBIE'").get() as Record<string, unknown>;
  assert.deepEqual(row, { status: "CLOSED", exit_px: 140, exit_reason: "FILL_CONFIRM" });
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

test("zombie exit sweep is inert without candidates and reports per-cycle kill reason", async t => {
  const store = withStore(t);
  const healed = await sweepUnprovenExits(depsFor(store, () => { throw new Error("exchange must not be queried"); }));
  assert.equal(healed, 0);
  // kill reason is per-cycle state: the global tick resets it before any runTick can stale-cache an old reason.
  resetLastKillReason();
  assert.equal(getLastKillReason(), null);
});
