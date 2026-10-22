import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Candle } from "../src/exchange/okx/types.ts";
import { openStore } from "../src/memory/db.ts";
import { assessTradeEconomics, listCostAssessments, recordCostAssessment, summarizeCostAssessments, type CostGateInput } from "../src/evaluation/cost-gate.ts";
import { reconcilePerformanceEvidence } from "../src/evaluation/evidence.ts";
import { aggregateConfirmedCandles, buildMtfContext } from "../src/market/mtf-context.ts";
import { backtestResearchV1, backtestResearchV1WithMtf, summarizeResearchTrades, validateResearchV1WithMtf, type ResearchBacktestResult, type ResearchTrade } from "../src/evaluation/research-strategies.ts";
import { assessResearchEvidence, compareResearchEvidence } from "../src/evaluation/research-evidence.ts";
import { DEFAULT_RESEARCH_FUNDING, fundingSettlementCount, researchFundingCharge, researchFundingFromConfig } from "../src/evaluation/research-funding.ts";
import { calculateExecutionCostR, DEFAULT_V2_COSTS } from "../src/evaluation/backtest.ts";
import { summarize } from "../src/evaluation/performance.ts";
import { buildSuitabilityReport, deriveSuitability } from "../src/evaluation/suitability.ts";

function store() { return openStore(mkdtempSync(path.join(os.tmpdir(), "evoq-research-"))); }
function candle(ts: number, o: number, h: number, l: number, c: number, vol = 100): Candle {
  return { ts, o, h, l, c, vol, volCcy: vol, confirm: "1" };
}
const baseInput: CostGateInput = {
  instrument: "BTC-USDT-SWAP", engine: "SWING_15M", strategy: "TREND_FOLLOWING_V2",
  strategyCoreVersion: 2, strategyVersion: 2, side: "LONG",
  entryPrice: 100, stopPrice: 99, takeProfitPrice: 102, tickSize: 0.1, lotSize: 0.1, minSize: 0.1,
  contractValue: 0.01, atr: 0.5, atrPct: 0.5,
  costs: { entryFeePct: 0.05, exitFeePct: 0.05, slippageBps: 1.5, spreadBps: 1.5, fundingBps: 1 },
};

test("cost gate rejects bad geometry, unsupported regimes, and cost-dominated rewards without authorizing trades", () => {
  const unproven = assessTradeEconomics(baseInput);
  assert.equal(unproven.verdict, "UNPROVEN_EDGE");
  assert.equal(unproven.expectedNetR, null);
  assert.equal(unproven.evidenceQuality, "ESTIMATED_ONLY");
  assert.equal(unproven.mode, "SHADOW");
  assert.equal(unproven.authorizationImpact, "NONE");
  assert.ok((unproven.netPayoutAtTpR ?? 0) > 0);
  assert.ok((unproven.netPayoutAtSlR ?? 0) < 0);

  assert.equal(assessTradeEconomics({ ...baseInput, stopPrice: 101 }).verdict, "NO_TRADE_INVALID_GEOMETRY");
  assert.equal(assessTradeEconomics({ ...baseInput, takeProfitPrice: 100.1 }).verdict, "NO_TRADE_COST_DOMINATED");
  assert.equal(assessTradeEconomics({ ...baseInput, supportedRegimes: ["RANGE:LOW"] }).verdict, "NO_TRADE_UNSUPPORTED_REGIME");
  assert.equal(assessTradeEconomics({ ...baseInput, tickSize: 0 }).verdict, "INSUFFICIENT_DATA");
});

test("cost gate only reports expected R from a calibrated sample and keeps the breakeven explicit", () => {
  const insufficient = assessTradeEconomics({ ...baseInput,
    probability: { sampleSize: 99, wins: 70, source: "HISTORICAL_NET_EVIDENCE" }, minConditionalSample: 100 });
  assert.equal(insufficient.verdict, "UNPROVEN_EDGE");
  assert.equal(insufficient.expectedNetR, null);
  assert.equal(insufficient.calibration.status, "INSUFFICIENT");
  assert.equal(insufficient.evidenceQuality, "INSUFFICIENT_SAMPLE");

  const eligible = assessTradeEconomics({ ...baseInput,
    probability: { sampleSize: 200, wins: 140, source: "HISTORICAL_NET_EVIDENCE" }, minConditionalSample: 100 });
  assert.equal(eligible.verdict, "ELIGIBLE_FOR_RESEARCH");
  assert.equal(eligible.calibration.status, "VALIDATED");
  assert.equal(eligible.evidenceQuality, "HISTORICAL_SAMPLE");
  assert.ok(eligible.breakevenWinRate !== null && eligible.breakevenWinRate < 0.7);
  assert.ok((eligible.expectedNetR ?? 0) > 0);
});

test("cost assessments persist as append-only shadow evidence", () => {
  const db = store();
  const assessment = assessTradeEconomics(baseInput);
  recordCostAssessment(db, assessment);
  recordCostAssessment(db, assessTradeEconomics({ ...baseInput, takeProfitPrice: 100.1 }));
  const stored = listCostAssessments(db);
  assert.equal(stored.length, 2);
  assert.equal(stored[0]!.verdict, "NO_TRADE_COST_DOMINATED");
  const summary = summarizeCostAssessments(db);
  assert.equal(summary.mode, "SHADOW");
  assert.equal(summary.authorizationImpact, "NONE");
  assert.equal(summary.total, 2);
  assert.equal(summary.byVerdict.UNPROVEN_EDGE, 1);
  db.close();
});

test("performance evidence excludes incomplete and unrealized rows from NET statistics", () => {
  const db = store();
  const closed = db.db.prepare(`INSERT INTO trades(trade_id,engine,result_r_basis,status,evidence_state,
    evolution_evidence_eligible,accounting_quality,instrument,timeframe,side,strategy,strategy_core_version,strategy_version,
    regime,contracts,entry_ts,exit_ts,pnl,fees,funding,result_r,mfe,mae,duration_s,exit_reason)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  closed.run("VERIFIED-WIN", "SWING_15M", "NET", "CLOSED", "VALID", 1, "COMPLETE", "BTC-USDT-SWAP", "15m", "LONG",
    "TREND_FOLLOWING", 2, 2, "TRENDING_BULLISH", "1", "2026-10-01T00:00:00Z", "2026-10-01T01:00:00Z",
    5, 1, 0.5, 1.2, 2, 1, 3600, "TP");
  closed.run("VERIFIED-LOSS", "SCALP_5M", "NET", "CLOSED", "VALID", 1, "COMPLETE", "ETH-USDT-SWAP", "scalp", "SHORT",
    "SCALP", 1, 1, "SIDEWAYS", "1", "2026-10-02T00:00:00Z", "2026-10-02T00:10:00Z",
    -2, 0.4, 0, -0.8, 1, 2, 600, "SL");
  closed.run("FINANCIAL-VALID-INELIGIBLE", "SWING_15M", "NET", "CLOSED", "VALID", 0, "COMPLETE", "XRP-USDT-SWAP", "15m", "LONG",
    "TREND_FOLLOWING", 2, 2, "TRENDING_BULLISH", "1", "2026-10-02T12:00:00Z", "2026-10-02T13:00:00Z",
    1, 0.1, 0, 0.25, 1.5, 0.5, 3600, "TP");
  closed.run("PENDING", "SWING_15M", "PENDING", "CLOSED", "EVIDENCE_PENDING", 0, "FUNDING_PENDING", "SOL-USDT-SWAP", "15m", "LONG",
    "BREAKOUT", 2, 2, "RANGE", "1", "2026-10-03T00:00:00Z", "2026-10-03T01:00:00Z",
    null, 0.2, null, null, null, null, 3600, "EXCHANGE_CLOSE_UNCLASSIFIED");
  db.db.prepare(`INSERT INTO trades(trade_id,engine,status,evidence_state,instrument,timeframe,side,strategy,
    strategy_core_version,strategy_version,regime,contracts,entry_ts)
    VALUES('OPEN-ONE','SWING_15M','OPEN','OPEN','BTC-USDT-SWAP','15m','LONG','TREND_FOLLOWING',2,2,'RANGE','1','2026-10-04T00:00:00Z')`).run();
  db.db.prepare(`INSERT INTO shadow_trades(shadow_trade_id,engine,strategy,strategy_version,instrument,side,status,
    signal_ts,last_processed_ts,signal_price,stop_atr,target_r,max_hold_bars,regime_axes,entry_conditions,costs_json,
    net_r,exit_ts)
    VALUES('SHD-1','SWING_15M','TREND_FOLLOWING',3,'BTC-USDT-SWAP','LONG','CLOSED',1,2,100,1.5,2,24,'{}','[]','{}',0.7,3)`).run();
  const report = reconcilePerformanceEvidence(db);
  assert.equal(report.completeness.closedTrades, 4);
  assert.equal(report.completeness.verifiedNetTrades, 3);
  assert.equal(report.completeness.evolutionEligibleTrades, 2);
  assert.equal(report.completeness.incompleteAccounting, 1);
  assert.equal(report.completeness.evidencePending, 1);
  assert.equal(report.completeness.uncertainExitAttribution, 1);
  assert.equal(report.completeness.openTrades, 1);
  assert.equal(report.completeness.simulatedResearchTrades, 1);
  assert.equal(report.overall?.trades, 3);
  assert.equal(report.overall?.netPnlUsdt, 4);
  assert.equal(report.overall?.feesUsdt, 1.5);
  assert.equal(report.overall?.fundingUsdt, 0.5);
  assert.equal(report.overall?.expectancyR, 0.216667);
  assert.equal(report.overall?.wins, 2);
  assert.equal(report.overall?.losses, 1);
  assert.equal(report.overall?.profitFactor, 3);
  assert.equal(report.cohorts.verifiedNet.trades, 3);
  assert.equal(report.cohorts.evolutionEligible.trades, 2);
  assert.equal(report.cohorts.evolutionEligible.metrics?.trades, 2);
  assert.equal(report.cohortReconciliation.financiallyVerifiedByEngine.SWING_15M, 2);
  assert.equal(report.cohortReconciliation.evolutionEligibleByEngine.SWING_15M, 1);
  assert.equal(report.cohortReconciliation.financiallyVerifiedByEngine.SCALP_5M, 1);
  assert.equal(report.cohorts.unrealized.metrics, null);
  assert.equal(report.cohorts.incompleteAccounting.trades, 1);
  assert.equal(report.cohorts.incompleteAccounting.metrics, null);
  assert.ok(report.limitations.some((item) => item.includes("MFE/MAE")));
  db.close();
});

test("MTF context only uses source candles closed before the decision timestamp", () => {
  const bars = Array.from({ length: 400 }, (_, index) => {
    const base = 100 + index * 0.05 + Math.sin(index / 5);
    return candle(index * 900_000, base, base + 0.4, base - 0.4, base + 0.1);
  });
  const decisionTs = bars[bars.length - 1]!.ts + 900_000;
  const context = buildMtfContext({ instrument: "BTC-USDT-SWAP", sourceTimeframe: "15m", timeframe: "1H",
    candles: bars, decisionTs });
  assert.equal(context.status, "ALIGNED");
  assert.ok(context.lastClosedAt !== null && context.lastClosedAt <= decisionTs);
  const future = [...bars, candle(decisionTs + 3_600_000, 500, 900, 400, 800)];
  const afterFuture = buildMtfContext({ instrument: "BTC-USDT-SWAP", sourceTimeframe: "15m", timeframe: "1H",
    candles: future, decisionTs });
  assert.deepEqual(afterFuture, context);
  const partial = aggregateConfirmedCandles(bars.slice(0, 3), "15m", "1H");
  assert.equal(partial.length, 0, "an incomplete 1H bucket is never synthesized");
  const full = aggregateConfirmedCandles(bars.slice(0, 4), "15m", "1H");
  assert.equal(full.length, 1);
  assert.equal(full[0]!.o, bars[0]!.o);
  assert.equal(full[0]!.c, bars[3]!.c);
});

test("regime-aware research backtest is deterministic and reports higher-timeframe coverage", () => {
  const bars: Candle[] = [];
  let price = 100;
  for (let index = 0; index < 420; index++) {
    const drift = index % 60 < 40 ? 0.12 : -0.05;
    const open = price;
    price += drift + Math.sin(index / 4) * 0.04;
    bars.push(candle(index * 900_000, open, Math.max(open, price) + 0.12, Math.min(open, price) - 0.12, price));
  }
  const first = backtestResearchV1WithMtf("TREND_PULLBACK_V1", "BTC-USDT-SWAP", bars);
  const second = backtestResearchV1WithMtf("TREND_PULLBACK_V1", "BTC-USDT-SWAP", bars);
  assert.deepEqual(first, second);
  assert.equal(first.mtfTimeframe, "1H");
  assert.ok(first.mtfCoverage.aligned + first.mtfCoverage.insufficientData + first.mtfCoverage.noClosedHistory > 0);
  assert.ok(first.trades.every((trade) => trade.resultR <= trade.grossR));
  assert.ok(first.assumptions.some((item) => item.includes("before the decision timestamp")));
  assert.equal(backtestResearchV1("TREND_PULLBACK_V1", "BTC-USDT-SWAP", bars).trades.length >= first.trades.length, true);
});

test("MTF validation produces out-of-sample and rolling cohorts without promoting an insufficient sample", () => {
  const make = (offset: number): Candle[] => {
    const bars: Candle[] = [];
    let price = 100 + offset;
    for (let index = 0; index < 320; index++) {
      const drift = index % 50 < 30 ? 0.1 : -0.06;
      const open = price;
      price += drift + Math.sin(index / 3) * 0.03;
      bars.push(candle(index * 900_000, open, Math.max(open, price) + 0.1, Math.min(open, price) - 0.1, price));
    }
    return bars;
  };
  const histories = new Map([["BTC-USDT-SWAP", make(0)], ["ETH-USDT-SWAP", make(5)]]);
  const validation = validateResearchV1WithMtf("BREAKOUT_RETEST_V1", histories, undefined, 0.8, 3);
  assert.equal(validation.strategy, "BREAKOUT_RETEST_V1");
  assert.equal(validation.mtfTimeframe, "1H");
  assert.ok(validation.mtfCoverage.aligned > 0);
  assert.equal(validation.metrics.evaluatedSymbols, 2);
  const backtest = backtestResearchV1WithMtf("BREAKOUT_RETEST_V1", "BTC-USDT-SWAP", make(0));
  const evidence = assessResearchEvidence(backtest, validation, { minimumSample: 10, minimumOutOfSampleSample: 5 });
  assert.ok(["ELIGIBLE_FOR_RESEARCH", "UNPROVEN_EDGE", "NO_TRADE_COST_DOMINATED", "INSUFFICIENT_EVIDENCE"].includes(evidence.verdict));
  assert.equal(evidence.outOfSample.evaluatedSymbols, 2);
  if (evidence.promotionEligible) assert.equal(evidence.verdict, "ELIGIBLE_FOR_RESEARCH");
});

function researchResult(rs: number[], fees = 0.05, funding = 0, side: "LONG" | "SHORT" = "LONG"): ResearchBacktestResult {
  const trades: ResearchTrade[] = rs.map((grossR, index) => ({
    instrument: "BTC-USDT-SWAP", signalTs: index, entryTs: index, exitTs: index + 1,
    side, grossR, feesR: fees, fundingR: funding,
    fundingSettlements: funding === 0 ? 0 : 1, resultR: grossR - fees - funding,
    exitReason: "TP" as const, mfeR: grossR, maeR: 1, durationBars: 1,
  }));
  return { summary: summarizeResearchTrades(trades), trades, unresolvedTrades: [],
    funding: DEFAULT_RESEARCH_FUNDING, assumptions: [] };
}

test("research evidence returns INSUFFICIENT_EVIDENCE instead of manufacturing a verdict", () => {
  const small = assessResearchEvidence(researchResult(Array.from({ length: 10 }, () => 0.3)), undefined, { minimumSample: 30 });
  assert.equal(small.verdict, "INSUFFICIENT_EVIDENCE");
  assert.equal(small.promotionEligible, false);
  const dominated = assessResearchEvidence(researchResult(Array.from({ length: 40 }, () => 0.1), 0.15), undefined,
    { minimumSample: 30 });
  assert.equal(dominated.verdict, "NO_TRADE_COST_DOMINATED");
  assert.ok(dominated.costSensitivity.some((point) => point.costMultiplier === 2));
  const champion = researchResult(Array.from({ length: 40 }, () => -0.1), 0.01);
  const challenger = researchResult(Array.from({ length: 40 }, () => -0.05), 0.01);
  const comparison = compareResearchEvidence(champion, challenger, undefined, undefined, { minimumSample: 30 });
  assert.equal(comparison.promoted, false);
  assert.ok(comparison.reasons.some((reason) => reason.includes("CHALLENGER_")));
});

test("DATA_END exposure is reported but never enters realized research metrics or promotion", () => {
  const resolved = researchResult([0.2, 0.3, 0.4]);
  const withOpenExposure: ResearchBacktestResult = { ...resolved, unresolvedTrades: [{
    instrument: "BTC-USDT-SWAP", signalTs: 99, entryTs: 100, lastTs: 110, side: "LONG",
    mfeR: 5, maeR: 1, durationBars: 10, reason: "DATA_END",
  }] };
  const assessment = assessResearchEvidence(withOpenExposure, undefined, { minimumSample: 3 });
  assert.equal(assessment.sample, 3);
  assert.equal(assessment.netExpectancyR, 0.25);
  assert.equal(assessment.excludedDataEnd.backtest, 1);
  assert.ok(assessment.reasons.some((reason) => reason.startsWith("DATA_END_UNRESOLVED_EXCLUDED")));

  const legacy = researchResult([0.2, 0.3]);
  legacy.trades.push({ ...legacy.trades[0]!, exitReason: "DATA_END" as never, grossR: 100, resultR: 99 });
  const legacyAssessment = assessResearchEvidence(legacy, undefined, { minimumSample: 2 });
  assert.equal(legacyAssessment.sample, 2);
  assert.equal(legacyAssessment.netExpectancyR, 0.2);
  assert.equal(legacyAssessment.excludedDataEnd.legacyTrades, 1);

  const allOpen: ResearchBacktestResult = { ...researchResult([]), unresolvedTrades: [{
    instrument: "BTC-USDT-SWAP", signalTs: 1, entryTs: 2, lastTs: 3, side: "LONG",
    mfeR: 1, maeR: 1, durationBars: 1, reason: "DATA_END",
  }] };
  const none = assessResearchEvidence(allOpen, undefined, { minimumSample: 1 });
  assert.equal(none.verdict, "INSUFFICIENT_EVIDENCE");
  assert.equal(none.promotionEligible, false);
  assert.equal(none.sample, 0);
  assert.equal(summarizeResearchTrades(legacy.trades).trades, 2);
});

test("train, out-of-sample and rolling cohorts exclude terminal exposure consistently", () => {
  const make = (offset: number): Candle[] => {
    const bars: Candle[] = [];
    let price = 100 + offset;
    for (let index = 0; index < 320; index++) {
      const drift = index % 50 < 30 ? 0.1 : -0.06;
      const open = price;
      price += drift + Math.sin(index / 3) * 0.03;
      bars.push(candle(index * 900_000, open, Math.max(open, price) + 0.1, Math.min(open, price) - 0.1, price));
    }
    return bars;
  };
  const validation = validateResearchV1WithMtf("BREAKOUT_RETEST_V1",
    new Map([["BTC-USDT-SWAP", make(0)], ["ETH-USDT-SWAP", make(5)]]), undefined, 0.8, 3);
  assert.equal(validation.counts.trainTrades, validation.train.summary.trades);
  assert.equal(validation.counts.outOfSampleTrades, validation.outOfSample.summary.trades);
  assert.equal(validation.counts.rollingFolds, validation.rolling.folds);
  assert.ok(validation.counts.excludedDataEnd.train >= 0);
  assert.ok(validation.counts.excludedDataEnd.outOfSample >= 0);
  assert.ok(validation.counts.excludedDataEnd.rolling >= 0);
  assert.equal(validation.funding.source, DEFAULT_RESEARCH_FUNDING.source);
});

test("research funding is signed by side, charged once per crossed settlement, and included in NET R", () => {
  const entryTs = Date.parse("2026-01-01T12:00:00Z");
  const noSettlement = fundingSettlementCount(entryTs, entryTs + 3 * 3_600_000, 8);
  const oneSettlement = fundingSettlementCount(entryTs, entryTs + 5 * 3_600_000, 8);
  const threeSettlements = fundingSettlementCount(entryTs, entryTs + 24 * 3_600_000, 8);
  assert.equal(noSettlement, 0);
  assert.equal(oneSettlement, 1);
  assert.equal(threeSettlements, 3);

  const long = researchFundingCharge({ side: "LONG", entryPrice: 100, riskDistance: 1,
    entryTs, exitTs: entryTs + 24 * 3_600_000, funding: DEFAULT_RESEARCH_FUNDING });
  const short = researchFundingCharge({ side: "SHORT", entryPrice: 100, riskDistance: 1,
    entryTs, exitTs: entryTs + 24 * 3_600_000, funding: DEFAULT_RESEARCH_FUNDING });
  assert.equal(long.settlements, 3);
  assert.equal(short.settlements, 3);
  assert.equal(long.rateBps, 1);
  assert.equal(short.rateBps, -1);
  assert.equal(long.fundingR, 0.03);
  assert.equal(short.fundingR, -0.03);
  assert.equal(researchFundingCharge({ side: "LONG", entryPrice: 100, riskDistance: 1,
    entryTs, exitTs: entryTs + 3 * 3_600_000, funding: DEFAULT_RESEARCH_FUNDING }).fundingR, 0);
  assert.deepEqual(researchFundingFromConfig({ research_funding: {
    enabled: true, rate_bps_per_settlement: 1, settlement_interval_hours: 8,
    source: "CONFIGURED_CONSERVATIVE_ESTIMATE" } }), DEFAULT_RESEARCH_FUNDING);

  const withoutFunding = researchResult(Array.from({ length: 40 }, () => 0.2), 0.05, 0);
  const withFunding = researchResult(Array.from({ length: 40 }, () => 0.2), 0.05, 0.2);
  assert.equal(assessResearchEvidence(withoutFunding, undefined, { minimumSample: 30 }).verdict, "ELIGIBLE_FOR_RESEARCH");
  assert.equal(assessResearchEvidence(withFunding, undefined, { minimumSample: 30 }).verdict, "NO_TRADE_COST_DOMINATED");
  const doubled = assessResearchEvidence(withFunding, undefined, { minimumSample: 30 }).costSensitivity
    .find((point) => point.costMultiplier === 2)!;
  assert.equal(doubled.totalCostR, 20);
  assert.equal(doubled.totalCostR / 40, 0.5);
  assert.equal(doubled.fundingStress, "ADVERSE_ABSOLUTE");
  assert.ok(Math.abs((doubled.summary.expectancy_r ?? 0) + 0.3) < 1e-9);
});

test("adverse funding stress removes SHORT rebate benefit and blocks promotion", () => {
  const shortRebate = researchResult(Array.from({ length: 40 }, () => 0.1), 0.05, -0.2, "SHORT");
  const assessment = assessResearchEvidence(shortRebate, undefined, { minimumSample: 30 });
  const points = assessment.costSensitivity;
  const baseline = points.find((point) => point.costMultiplier === 1)!;
  const stress = points.find((point) => point.costMultiplier === 2)!;
  assert.equal(baseline.fundingStress, "SIGNED");
  assert.equal(stress.fundingStress, "ADVERSE_ABSOLUTE");
  assert.equal(baseline.summary.expectancy_r, 0.25);
  assert.ok((stress.summary.expectancy_r ?? 0) < (baseline.summary.expectancy_r ?? 0));
  assert.ok(Math.abs((stress.summary.expectancy_r ?? 0) + 0.4) < 1e-9);

  const validation = {
    strategy: "TREND_PULLBACK_V1" as const,
    train: { summary: summarize(Array.from({ length: 20 }, () => 0.25)), bySymbol: {} },
    outOfSample: { summary: summarize(Array.from({ length: 20 }, () => 0.25)), bySymbol: {} },
    rolling: { folds: 3, positiveFolds: 3, expectancies: [0.25, 0.25, 0.25] },
    metrics: { averageMfeR: 1, averageMaeR: 1, averageHoldingBars: 1, positiveSymbols: 1, evaluatedSymbols: 1 },
    funding: DEFAULT_RESEARCH_FUNDING,
    counts: { trainTrades: 20, outOfSampleTrades: 20, rollingFolds: 3,
      excludedDataEnd: { train: 0, outOfSample: 0, rolling: 0 } },
  };
  const withValidation = assessResearchEvidence(shortRebate, validation, { minimumSample: 30 });
  assert.equal(withValidation.verdict, "ELIGIBLE_FOR_RESEARCH");
  assert.equal(withValidation.promotionEligible, false);
});

test("configured research funding is propagated through backtest costs", () => {
  const configured = researchFundingFromConfig({ research_funding: {
    enabled: true, rate_bps_per_settlement: 7, settlement_interval_hours: 8,
    source: "CONFIGURED_CONSERVATIVE_ESTIMATE" } });
  assert.equal(configured.rateBpsPerSettlement, 7);
  const bars: Candle[] = [];
  let price = 100;
  for (let index = 0; index < 900; index++) {
    const drift = index % 70 < 48 ? 0.13 : -0.07;
    const open = price;
    price += drift + Math.sin(index / 4) * 0.04;
    bars.push(candle(index * 900_000, open, Math.max(open, price) + 0.12, Math.min(open, price) - 0.12, price));
  }
  const backtest = backtestResearchV1("TREND_PULLBACK_V1", "BTC-USDT-SWAP", bars,
    { ...DEFAULT_V2_COSTS, researchFunding: configured });
  assert.equal(backtest.funding.rateBpsPerSettlement, 7);
  assert.equal(backtest.funding.source, "CONFIGURED_CONSERVATIVE_ESTIMATE");
  const entryTs = Date.parse("2026-01-01T12:00:00Z");
  const args = { side: "LONG" as const, entryPrice: 100, riskDistance: 1,
    entryTs, exitTs: entryTs + 24 * 3_600_000 };
  const baselineCharge = researchFundingCharge({ ...args, funding: DEFAULT_RESEARCH_FUNDING });
  const configuredCharge = researchFundingCharge({ ...args, funding: configured });
  assert.equal(baselineCharge.fundingR, 0.03);
  assert.equal(configuredCharge.fundingR, 0.21);
  assert.equal(configuredCharge.fundingR, baselineCharge.fundingR * 7);
});

test("cost gate normalizes off-tick prices into executable conservative geometry", () => {
  const long = assessTradeEconomics({ ...baseInput, entryPrice: 100.05, stopPrice: 99.05, takeProfitPrice: 102.05 });
  assert.deepEqual(long.normalizedPrices, { entryPrice: 100, stopPrice: 99.1, takeProfitPrice: 102 });
  assert.equal(long.verdict, "UNPROVEN_EDGE");
  const expectedCost = calculateExecutionCostR(100, 102, 0.9, { ...DEFAULT_V2_COSTS,
    entryFeePct: baseInput.costs.entryFeePct, exitFeePct: baseInput.costs.exitFeePct,
    slippageBps: baseInput.costs.slippageBps, spreadBps: baseInput.costs.spreadBps });
  assert.equal(long.executionCostR, Math.round(expectedCost * 1_000_000) / 1_000_000);
  assert.equal(long.grossRewardR, Math.round((2 / 0.9) * 1_000_000) / 1_000_000);

  const short = assessTradeEconomics({ ...baseInput, side: "SHORT",
    entryPrice: 100.05, stopPrice: 101.05, takeProfitPrice: 99.05 });
  assert.deepEqual(short.normalizedPrices, { entryPrice: 100.1, stopPrice: 101, takeProfitPrice: 99.1 });
  assert.equal(short.verdict, "UNPROVEN_EDGE");

  const invalidAfterNormalization = assessTradeEconomics({ ...baseInput,
    entryPrice: 100.4, stopPrice: 100.1, takeProfitPrice: 101.4, tickSize: 1 });
  assert.equal(invalidAfterNormalization.verdict, "NO_TRADE_INVALID_GEOMETRY");
  assert.equal(invalidAfterNormalization.reason, "NORMALIZED_GEOMETRY_INVALID");
  assert.deepEqual(invalidAfterNormalization.normalizedPrices, {
    entryPrice: 100, stopPrice: 101, takeProfitPrice: 101,
  });
});

test("suitability is observation-only and requires a loss sample before ELIGIBLE", () => {
  assert.deepEqual(deriveSuitability({ trades: 5, wins: 5, losses: 0, winRate: 1, netExpectancyR: 1,
    grossExpectancyR: 1.1, averageFeeR: 0.1, averageFundingR: 0, profitFactor: 2, netPnlUsdt: 5 },
  { riskBlocked: false, minimumSample: 20, minimumProfitFactor: 1.05 }), { decision: "UNPROVEN", reason: "SAMPLE_5_BELOW_20" });
  assert.equal(deriveSuitability({ trades: 25, wins: 15, losses: 10, winRate: 0.6, netExpectancyR: 0.2,
    grossExpectancyR: 0.3, averageFeeR: 0.1, averageFundingR: 0, profitFactor: 1.4, netPnlUsdt: 5 },
  { riskBlocked: false, minimumSample: 20, minimumProfitFactor: 1.05 }).decision, "ELIGIBLE");
  assert.equal(deriveSuitability({ trades: 25, wins: 15, losses: 10, winRate: 0.6, netExpectancyR: -0.1,
    grossExpectancyR: 0.1, averageFeeR: 0.2, averageFundingR: 0, profitFactor: 0.9, netPnlUsdt: -1 },
  { riskBlocked: false, minimumSample: 20, minimumProfitFactor: 1.05 }).decision, "NO_TRADE");
  assert.equal(deriveSuitability({ trades: 25, wins: 15, losses: 10, winRate: 0.6, netExpectancyR: 0.2,
    grossExpectancyR: 0.3, averageFeeR: 0.1, averageFundingR: 0, profitFactor: 1.4, netPnlUsdt: 5 },
  { riskBlocked: true, minimumSample: 20, minimumProfitFactor: 1.05 }).decision, "BLOCKED_BY_RISK");

  const db = store();
  const insert = db.db.prepare(`INSERT INTO trades(trade_id,engine,result_r_basis,status,evidence_state,
    evolution_evidence_eligible,accounting_quality,instrument,timeframe,side,strategy,strategy_core_version,strategy_version,
    regime,contracts,entry_ts,exit_ts,pnl,fees,funding,result_r,mfe,mae,duration_s,exit_reason)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  for (let index = 0; index < 25; index++) {
    const win = index < 15;
    insert.run(`SUIT-${index}`, "SWING_15M", "NET", "CLOSED", "VALID", 1, "COMPLETE", "BTC-USDT-SWAP", "15m", "LONG",
      "TREND_FOLLOWING", 2, 2, "TRENDING_BULLISH", "1", "2026-10-01T00:00:00Z", `2026-10-01T01:${String(index).padStart(2, "0")}:00Z`,
      win ? 1 : -0.5, 0.1, 0, win ? 0.5 : -0.3, 1, 1, 3600, win ? "TP" : "SL");
  }
  const report = buildSuitabilityReport(db, { riskBlocked: false, minimumSample: 20 });
  assert.equal(report.observationOnly, true);
  assert.equal(report.authorizationImpact, "NONE");
  assert.equal(report.summary.ELIGIBLE, 1);
  assert.equal(report.scopes[0]?.decision, "ELIGIBLE");
  const blocked = buildSuitabilityReport(db, { riskBlocked: true, minimumSample: 20 });
  assert.equal(blocked.scopes[0]?.decision, "BLOCKED_BY_RISK");
  db.close();
});

test("research intelligence API exposes evidence, shadow cost gate and suitability without exchange access", async (t) => {
  const { startDashboard } = await import("../src/core/dashboard.ts");
  const { loadRiskConfig, loadTradingConfig } = await import("../src/core/config.ts");
  const root = mkdtempSync(path.join(os.tmpdir(), "evoq-research-api-"));
  const db = openStore(root);
  const risk = loadRiskConfig(), trading = loadTradingConfig();
  let exchangeRequests = 0;
  const deps = { store: db, risk, trading, instruments: {}, watchlist: ["BTC-USDT-SWAP"], client: {
    get: async () => { exchangeRequests++; throw new Error("offline fixture"); },
    post: async () => { throw new Error("orders not permitted"); },
  } } as never;
  const server = startDashboard({ port: 0, trading, risk, deps: () => deps, strategyCoreVersion: 2,
    getLastTick: () => null, getScan: () => [], getKillReason: () => null,
    evolution: { reviewEvery: true, signalInterval: 8, strategyInterval: 15, minSample: 20,
      maxWeightChangePct: 5, maxParamChanges: 1 } });
  t.after(() => { server.close(); db.close(); rmSync(root, { recursive: true, force: true }); });
  await new Promise<void>((resolve) => setImmediate(resolve));
  const base = `http://127.0.0.1:${server.address()!.port}`;
  const response = await fetch(base + "/api/research-intelligence");
  assert.equal(response.status, 200);
  const body = await response.json() as Record<string, unknown>;
  assert.deepEqual(body.mode, { costGate: "SHADOW", observationOnly: true, authorizationImpact: "NONE" });
  assert.equal((body.performance as Record<string, unknown>).completeness !== undefined, true);
  assert.equal((body.costGate as Record<string, unknown>).authorizationImpact, "NONE");
  assert.equal((body.suitability as Record<string, unknown>).observationOnly, true);
  assert.equal((await fetch(base + "/api/research-intelligence", { method: "POST" })).status, 405);
  assert.equal(exchangeRequests, 0);
});
