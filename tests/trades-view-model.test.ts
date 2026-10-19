import assert from "node:assert/strict";
import test from "node:test";
import { TRADE_DESKTOP_COLUMNS, TRADE_PAGE_SIZE, filterTrades, isTrustedNetTrade, paginateTrades, sortTrades, tradeOutcome } from "../apps/console/src/pages/trades-view-model.ts";

const trusted = (trade_id: string, pnl: number, result_r: number, extra: Record<string, unknown> = {}) => ({
  trade_id, status: "CLOSED", instrument: "BTC-USDT-SWAP", strategy: "BREAKOUT", engine: "SWING_15M", side: "LONG",
  entry_ts: "2026-10-01T00:00:00Z", exit_ts: "2026-10-01T01:00:00Z", pnl, fees: 0.1, funding: 0,
  result_r, mfe: 1, mae: 0.5, duration_s: 300, result_r_basis: "NET", evidence_state: "VALID", evolution_evidence_eligible: 1, accounting_quality: "COMPLETE", ...extra,
});

test("trade table defaults to a compact eight-column ledger", () => {
  assert.equal(TRADE_DESKTOP_COLUMNS.length, 8);
  assert.equal(TRADE_PAGE_SIZE, 25);
});

test("financial trust excludes open, pending, incomplete, and non-NET rows", () => {
  const valid = trusted("valid", 1, 0.5);
  assert.equal(isTrustedNetTrade(valid), true);
  assert.equal(tradeOutcome(valid), "WIN");
  assert.equal(tradeOutcome(trusted("loss", -1, -0.5)), "LOSS");
  assert.equal(tradeOutcome(trusted("flat", 0, 0)), "FLAT");
  assert.equal(tradeOutcome({ ...valid, status: "OPEN" }), "OPEN");
  assert.equal(tradeOutcome({ ...valid, status: "RECONCILIATION_PENDING" }), "UNVERIFIED");
  assert.equal(tradeOutcome({ ...valid, evidence_state: "ACCOUNTING_INCOMPLETE" }), "UNVERIFIED");
  assert.equal(tradeOutcome({ ...valid, funding: null }), "UNVERIFIED");
  assert.equal(tradeOutcome({ ...valid, mfe: null }), "WIN", "missing excursion telemetry does not invalidate complete NET accounting");
  assert.equal(isTrustedNetTrade({ ...valid, evolution_evidence_eligible: 0 }), true,
    "Evolution eligibility is separate from verified financial accounting");
  assert.equal(tradeOutcome({ ...valid, evolution_evidence_eligible: 0 }), "WIN");
  assert.equal(tradeOutcome({ ...valid, result_r_basis: "GROSS" }), "UNVERIFIED");
});

test("search and engine, side, status, and outcome filters compose", () => {
  const rows = [
    trusted("BTC-win", 2, 1),
    trusted("ETH-loss", -1, -0.5, { instrument: "ETH-USDT-SWAP", side: "SHORT", engine: "SCALP_5M" }),
    { ...trusted("BTC-open", 0, 0), status: "OPEN", engine: "SCALP_5M" },
  ];
  assert.deepEqual(filterTrades(rows, { search: "eth", engine: "SCALP_5M", side: "SHORT", status: "CLOSED", outcome: "LOSS" }).map(row => row.trade_id), ["ETH-loss"]);
  assert.deepEqual(filterTrades(rows, { search: "btc", engine: "ALL", side: "ALL", status: "ALL", outcome: "ALL" }).map(row => row.trade_id), ["BTC-win", "BTC-open"]);
});

test("sorts raw numeric financial values and timestamps with unavailable values last", () => {
  const rows = [
    trusted("small", 0.1, 0.1, { exit_ts: "2026-10-01T00:00:00Z" }),
    trusted("large", 10, 2, { exit_ts: "2026-10-03T00:00:00Z" }),
    trusted("middle", 2, 1, { exit_ts: "2026-10-02T00:00:00Z" }),
    { ...trusted("unavailable", 99, 99), evidence_state: "PENDING", pnl: null, result_r: null, exit_ts: null, entry_ts: null },
  ];
  assert.deepEqual(sortTrades(rows, "pnl-desc").map(row => row.trade_id), ["large", "middle", "small", "unavailable"]);
  assert.deepEqual(sortTrades(rows, "r-asc").map(row => row.trade_id), ["small", "middle", "large", "unavailable"]);
  assert.deepEqual(sortTrades(rows, "newest").map(row => row.trade_id), ["large", "middle", "small", "unavailable"]);
  assert.deepEqual(sortTrades([{ ...trusted("closed", 1, 0.1), status: "CLOSED" }, { ...trusted("open", 0, 0), status: "OPEN", upl: 100 }], "pnl-desc").map(row => row.trade_id), ["closed", "open"],
    "unrealized PnL is not mixed into the realized NET sort");
});

test("client pagination is bounded and clamps invalid page values", () => {
  const rows = Array.from({ length: 61 }, (_, index) => ({ trade_id: String(index) }));
  assert.equal(paginateTrades(rows, 0).length, 25);
  assert.equal(paginateTrades(rows, 2).length, 11);
  assert.equal(paginateTrades(rows, -4).length, 25);
  assert.deepEqual(paginateTrades(rows, 99), []);
});
