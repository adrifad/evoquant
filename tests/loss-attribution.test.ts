import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { openStore } from "../src/memory/db.ts";
import { buildLossAttribution } from "../src/memory/loss-attribution.ts";
import { recordDecision } from "../src/memory/trades.ts";

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "evoquant-loss-attribution-"));
  const store = openStore(root);
  const insert = store.db.prepare(`INSERT INTO trades(trade_id,engine,result_r_basis,status,evidence_state,evolution_evidence_eligible,
    accounting_quality,instrument,timeframe,side,strategy,strategy_core_version,strategy_version,regime,contracts,entry_ts,exit_ts,
    pnl,fees,funding,result_r,mfe,mae,duration_s,exit_reason) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const base = { engine: "SWING_15M", result_r_basis: "NET", status: "CLOSED", evidence_state: "VALID", eligible: 1,
    accounting: "COMPLETE", instrument: "BTC-USDT-SWAP", timeframe: "15m", side: "LONG", strategy: "TREND_FOLLOWING",
    core: 2, version: 3, regime: "TRENDING_BULLISH", contracts: "1", entry: "2026-10-01T00:00:00Z", exit: "TP" };
  const row = (id: string, pnl: number | null, fees: number | null, funding: number | null, resultR: number | null,
    mfe: number | null, mae: number | null, duration: number | null, extra: Record<string, unknown> = {}) => {
    const value = { ...base, ...extra };
    insert.run(id, value.engine, value.result_r_basis, value.status, value.evidence_state, value.eligible, value.accounting,
      value.instrument, value.timeframe, value.side, value.strategy, value.core, value.version, value.regime, value.contracts,
      value.entry, "2026-10-01T00:15:00Z", pnl, fees, funding, resultR, mfe, mae, duration, value.exit ?? "TP");
  };
  return { root, store, row, close: () => { store.close(); rmSync(root, { recursive: true, force: true }); } };
}

test("loss attribution uses only complete valid NET evidence and states its accounting formulas", () => {
  const f = fixture();
  try {
    f.row("WIN", 8, 2, -1, 0.8, 3, 1, 600);
    f.row("LOSS", -4, 2, 0, -0.4, 1, 2, 1200, { side: "SHORT", regime: "TRENDING_BEARISH", exit: "SL" });
    f.row("PENDING", null, null, null, null, null, null, 20, { evidence_state: "EVIDENCE_PENDING", eligible: 0, accounting: "FEE_PENDING" });
    f.row("CORRUPT", 3, null, 0, 0.3, 2, 1, 300);
    f.row("INCOMPLETE_QUALITY", 1, 0, 0, 0.1, 1, 1, 60, { accounting: "FUNDING_PENDING" });

    const report = buildLossAttribution(f.store);
    assert.equal(report.currency, "USDT");
    assert.equal(report.accounting.closedTrades, 5);
    assert.equal(report.accounting.completeValidNetTrades, 2);
    assert.equal(report.accounting.validButCorrupt, 2);
    assert.equal(report.accounting.excludedByState, 1, "corrupt VALID rows are reported separately from non-VALID states");
    assert.equal(report.overall.tradeCount, 2);
    assert.equal(report.overall.winRate, 0.5);
    assert.equal(report.overall.totalNetPnlUsdt, 4);
    assert.equal(report.overall.totalGrossPnlUsdt, 9);
    assert.equal(report.overall.totalTradingFeesUsdt, 4);
    assert.equal(report.overall.totalFundingUsdt, -1);
    assert.equal(report.overall.averageNetPnlUsdt, 2);
    assert.equal(report.overall.averageGrossPnlUsdt, 4.5, "gross = net + fees - signed funding");
    assert.equal(report.overall.averageWinUsdt, 8);
    assert.equal(report.overall.averageLossUsdt, -4);
    assert.equal(report.overall.averageWinR, 0.8);
    assert.equal(report.overall.averageLossR, -0.4);
    assert.equal(report.overall.profitFactor, 2);
    assert.equal(report.overall.expectancyR, 0.2);
    assert.equal(report.overall.averageMfe, 2);
    assert.equal(report.overall.averageMae, 1.5);
    assert.equal(report.overall.averageDurationSeconds, 900);
    assert.equal(report.overall.maxTradeSequenceDrawdownUsdt, 4);
    assert.equal(report.by.side.find(item => item.key === "SHORT")?.metrics.tradeCount, 1);
    assert.equal(report.by.exitReason.find(item => item.key === "SL")?.metrics.tradeCount, 1);
    assert.equal(report.by.gateDecision.find(item => item.key === "UNKNOWN")?.metrics.tradeCount, 2,
      "legacy records without correlated Gate evidence remain explicitly unknown");
    assert.ok(report.unavailable.includes("gate_decision_causality"));
  } finally { f.close(); }
});

test("loss attribution uses persisted Gate outcome, setup conditions, and UTC entry/exit hours", () => {
  const f = fixture();
  try {
    f.row("ATTRIBUTION", 5, 1, -0.2, 0.5, 2, 0.5, 300);
    recordDecision(f.store, { decisionId: "DEC-ATTRIBUTION", ts: "2026-10-01T05:00:00Z", instrument: "BTC-USDT-SWAP",
      decision: "LONG", gateResult: "ALLOW", strategy: "TREND_FOLLOWING_V2", regime: "TRENDING_BULLISH", riskVerdict: { approved: true } });
    f.store.db.prepare("UPDATE trades SET decision_id=?,entry_conditions=?,entry_ts=?,exit_ts=? WHERE trade_id=?")
      .run("DEC-ATTRIBUTION", JSON.stringify([{ name: "ADX_MIN", passed: true }, { name: "VOLUME_RATIO", passed: true }]),
        "2026-10-01T05:35:00Z", "2026-10-01T07:10:00Z", "ATTRIBUTION");
    const report = buildLossAttribution(f.store);
    assert.equal(report.by.gateDecision.find(item => item.key === "ALLOW")?.metrics.tradeCount, 1);
    assert.equal(report.by.setup.find(item => item.key.includes("ADX_MIN,VOLUME_RATIO"))?.metrics.tradeCount, 1);
    assert.equal(report.by.entryHourUtc.find(item => item.key === "05:00 UTC")?.metrics.tradeCount, 1);
    assert.equal(report.by.exitHourUtc.find(item => item.key === "07:00 UTC")?.metrics.tradeCount, 1);
  } finally { f.close(); }
});

test("loss attribution leaves profit factor unavailable when no complete losing trade exists", () => {
  const f = fixture();
  try {
    f.row("ONLY-WIN", 2, 1, 0, 0.2, 3, 1, 30);
    assert.equal(buildLossAttribution(f.store).overall.profitFactor, null);
  } finally { f.close(); }
});

test("cross-instrument raw MFE/MAE averages are unavailable while per-symbol values remain comparable", () => {
  const f = fixture();
  try {
    f.row("BTC-TRADE", 2, 0, 0, 0.2, 10, 4, 30);
    f.row("ETH-TRADE", 3, 0, 0, 0.3, 2, 1, 30, { instrument: "ETH-USDT-SWAP" });
    const report = buildLossAttribution(f.store);
    assert.equal(report.overall.averageMfe, null);
    assert.equal(report.by.symbol.find(item => item.key === "BTC-USDT-SWAP")?.metrics.averageMfe, 10);
    assert.equal(report.formulas.maxTradeSequenceDrawdownUsdt.includes("not account-equity drawdown"), true);
  } finally { f.close(); }
});
