import type { Candle } from "../exchange/okx/types.ts";
import { buildFeatures, type FeatureSnapshot } from "../market/features.ts";
import { buildMtfContext, timeframeMs, type MtfContextStatus } from "../market/mtf-context.ts";
import { calculateSlPlusStop } from "../execution/sl-plus.ts";
import { summarize, type PerfSummary } from "./performance.ts";
import { calculateExecutionCostR, DEFAULT_V2_COSTS, type V2CostModel } from "./backtest.ts";
import { DEFAULT_RESEARCH_FUNDING, researchFundingCharge, type ResearchFundingModel } from "./research-funding.ts";
import {
  DEFAULT_BREAKOUT_RETEST_V1, DEFAULT_RANGE_MEAN_REVERSION_V1, DEFAULT_TREND_PULLBACK_V1, evaluateBreakoutRetestV1,
  evaluateRangeMeanReversionV1, evaluateTrendPullbackV1, type ResearchEvaluation, type ResearchStrategyConfig, type ResearchStrategyId,
} from "../strategy/research-v1.ts";
import { evaluateRegimeAwareResearchV1 } from "../strategy/research-regime-v1.ts";

export interface ResearchTrade {
  instrument: string;
  signalTs: number;
  entryTs: number;
  exitTs: number;
  side: "LONG" | "SHORT";
  resultR: number;
  grossR: number;
  feesR: number;
  fundingR: number;
  fundingSettlements: number;
  exitReason: "SL" | "TP" | "SL_PLUS" | "TIME_STOP";
  mfeR: number;
  maeR: number;
  durationBars: number;
}

/** Exposure that was still open when historical data ended. It has no realized R. */
export interface UnresolvedResearchExposure {
  instrument: string;
  signalTs: number;
  entryTs: number;
  lastTs: number;
  side: "LONG" | "SHORT";
  mfeR: number;
  maeR: number;
  durationBars: number;
  reason: "DATA_END";
}

export interface ResearchBacktestResult {
  summary: PerfSummary;
  /** Resolved trades only. DATA_END exposure is reported separately. */
  trades: ResearchTrade[];
  unresolvedTrades: UnresolvedResearchExposure[];
  funding: ResearchFundingModel;
  assumptions: string[];
}
export interface ResearchValidationResult {
  strategy: ResearchStrategyId;
  train: { summary: PerfSummary; bySymbol: Record<string, PerfSummary> };
  outOfSample: { summary: PerfSummary; bySymbol: Record<string, PerfSummary> };
  rolling: { folds: number; positiveFolds: number; expectancies: number[] };
  metrics: { averageMfeR: number; averageMaeR: number; averageHoldingBars: number; positiveSymbols: number; evaluatedSymbols: number };
  funding: ResearchFundingModel;
  counts: {
    trainTrades: number;
    outOfSampleTrades: number;
    rollingFolds: number;
    excludedDataEnd: { train: number; outOfSample: number; rolling: number };
  };
}

const DEFAULT_RESEARCH_PARAMS: ResearchStrategyConfig = {
  trend_pullback_v1: DEFAULT_TREND_PULLBACK_V1, breakout_retest_v1: DEFAULT_BREAKOUT_RETEST_V1,
  range_mean_reversion_v1: DEFAULT_RANGE_MEAN_REVERSION_V1,
};

function baselineEvaluation(strategy: ResearchStrategyId, f: FeatureSnapshot, prefix: Candle[],
  roundTripCostPct: number, params: ResearchStrategyConfig): ResearchEvaluation {
  return strategy === "TREND_PULLBACK_V1" ? evaluateTrendPullbackV1(f, prefix, params.trend_pullback_v1)
    : strategy === "BREAKOUT_RETEST_V1" ? evaluateBreakoutRetestV1(f, prefix, params.breakout_retest_v1)
      : evaluateRangeMeanReversionV1(f, prefix, roundTripCostPct, params.range_mean_reversion_v1);
}

function runResearchBacktest(instrument: string, input: Candle[],
  costs: V2CostModel, signalStartTs: number,
  evaluate: (f: FeatureSnapshot, prefix: Candle[], roundTripCostPct: number) => ResearchEvaluation,
  assumptions: string[]): ResearchBacktestResult {
  const candles = input.filter(c => c.confirm === "1").slice().sort((a, b) => a.ts - b.ts);
  const trades: ResearchTrade[] = [];
  const unresolvedTrades: UnresolvedResearchExposure[] = [];
  const fundingModel = costs.researchFunding ?? DEFAULT_RESEARCH_FUNDING;
  let i = 59;
  while (i < candles.length - 1) {
    const prefix = candles.slice(0, i + 1);
    const f = buildFeatures(instrument, prefix.slice().reverse());
    const roundTripCostPct = costs.entryFeePct + costs.exitFeePct + 2 * (costs.slippageBps + costs.spreadBps) / 100;
    const evaluation = evaluate(f, prefix, roundTripCostPct);
    const candidate = evaluation.candidate;
    if (!candidate || f.ts < signalStartTs) { i++; continue; }
    const entryBar = candles[i + 1]!;
    const entryPrice = entryBar.o;
    const sign = candidate.side === "LONG" ? 1 : -1;
    // Preserve candidate geometry at the next executable open. A gap through
    // either exit invalidates the setup instead of silently rebuilding it.
    const initialStop = candidate.stopPrice;
    const target = candidate.takeProfitPrice;
    const riskDistance = Math.abs(entryPrice - initialStop);
    const validGeometry = entryPrice > 0 && riskDistance > 0 && Number.isFinite(target)
      && (candidate.side === "LONG" ? initialStop < entryPrice && target > entryPrice : target < entryPrice && entryPrice < initialStop);
    if (!validGeometry) { i++; continue; }
    let activeStop = initialStop, exitPrice = entryPrice, exitTs = entryBar.ts, exitReason: ResearchTrade["exitReason"] = "TIME_STOP";
    let exitIndex = candles.length - 1, mfe = 0, mae = 0, resolved = false;
    for (let j = i + 1; j < Math.min(candles.length, i + candidate.maxHoldBars + 1); j++) {
      const candle = candles[j]!;
      const favorable = candidate.side === "LONG" ? candle.h - entryPrice : entryPrice - candle.l;
      const adverse = candidate.side === "LONG" ? entryPrice - candle.l : candle.h - entryPrice;
      mfe = Math.max(mfe, favorable); mae = Math.max(mae, adverse);
      const stopHit = candidate.side === "LONG" ? candle.l <= activeStop : candle.h >= activeStop;
      const targetHit = candidate.side === "LONG" ? candle.h >= target : candle.l <= target;
      if (stopHit) {
        exitPrice = candidate.side === "LONG" ? Math.min(candle.o, activeStop) : Math.max(candle.o, activeStop);
        exitTs = candle.ts; exitIndex = j; exitReason = activeStop === initialStop ? "SL" : "SL_PLUS"; resolved = true; break;
      }
      if (targetHit) { exitPrice = target; exitTs = candle.ts; exitIndex = j; exitReason = "TP"; resolved = true; break; }
      if (costs.slPlus.enabled && favorable / riskDistance >= costs.slPlus.activationR) {
        const next = calculateSlPlusStop({ side: candidate.side, entryPx: entryPrice, initialStopPx: initialStop,
          currentStopPx: activeStop, markPx: candle.c, tickSz: Math.max(entryPrice * 1e-8, Number.EPSILON),
          activationR: costs.slPlus.activationR, lockInR: costs.slPlus.lockInR,
          minProfitBufferPct: costs.slPlus.minProfitBufferPct });
        if (next !== null) activeStop = next;
      }
      if (j - i >= candidate.maxHoldBars) {
        const next = candles[j + 1]; exitPrice = next?.o ?? candle.c; exitTs = next?.ts ?? candle.ts;
        exitIndex = next ? j + 1 : j; exitReason = "TIME_STOP"; resolved = true; break;
      }
    }
    if (!resolved) {
      const last = candles[exitIndex]!;
      // DATA_END is unresolved exposure, not a realized trade. Report it
      // separately and never let it influence expectancy or promotion.
      unresolvedTrades.push({ instrument, signalTs: candidate.signalTs, entryTs: entryBar.ts, lastTs: last.ts,
        side: candidate.side, mfeR: mfe / riskDistance, maeR: mae / riskDistance,
        durationBars: Math.max(1, exitIndex - i), reason: "DATA_END" });
      i = candles.length;
      continue;
    }
    const grossR = (exitPrice - entryPrice) * sign / riskDistance;
    const feesR = calculateExecutionCostR(entryPrice, exitPrice, riskDistance, costs);
    const funding = researchFundingCharge({ side: candidate.side, entryPrice, riskDistance,
      entryTs: entryBar.ts, exitTs, funding: fundingModel });
    trades.push({ instrument, signalTs: candidate.signalTs, entryTs: entryBar.ts, exitTs, side: candidate.side,
      grossR, feesR, fundingR: funding.fundingR, fundingSettlements: funding.settlements,
      resultR: grossR - feesR - funding.fundingR, exitReason, mfeR: mfe / riskDistance, maeR: mae / riskDistance,
      durationBars: Math.max(1, exitIndex - i) });
    i = Math.max(i + 1, exitIndex + 1);
  }
  return { summary: summarizeResearchTrades(trades), trades, unresolvedTrades,
    funding: fundingModel, assumptions: [...assumptions, fundingAssumption(fundingModel)] };
}

/** Legacy DATA_END rows are excluded even if a caller still includes them. */
export function summarizeResearchTrades(trades: readonly ResearchTrade[]): PerfSummary {
  return summarize(trades.filter((trade) => String(trade.exitReason) !== "DATA_END").map((trade) => trade.resultR));
}

function fundingAssumption(funding: ResearchFundingModel): string {
  if (!funding.enabled) return "funding disabled: research results are EXECUTION-NET, not funding-inclusive NET";
  return `funding modeled once per crossed settlement at ${funding.rateBpsPerSettlement} bps per ${funding.settlementIntervalHours}h; `
    + `positive rates are paid by LONG and received by SHORT; source=${funding.source}`;
}

const RESEARCH_ASSUMPTIONS = ["confirmed close signal enters at next candle open",
  "candidate stop/target are preserved; gaps that invalidate geometry are skipped",
  "stop wins if stop and target touch on one candle",
  "fees, slippage, spread and SL+ use the current V2 cost model",
  "research-only; no order or promotion authority"];

export function backtestResearchV1(strategy: ResearchStrategyId, instrument: string, input: Candle[],
  costs: V2CostModel = DEFAULT_V2_COSTS, signalStartTs = -Infinity,
  params: ResearchStrategyConfig = DEFAULT_RESEARCH_PARAMS): ResearchBacktestResult {
  return runResearchBacktest(instrument, input, costs, signalStartTs,
    (f, prefix, roundTripCostPct) => baselineEvaluation(strategy, f, prefix, roundTripCostPct, params),
    RESEARCH_ASSUMPTIONS);
}

export interface ResearchMtfBacktestResult extends ResearchBacktestResult {
  mtfCoverage: { aligned: number; insufficientData: number; noClosedHistory: number };
  mtfTimeframe: string;
}

/**
 * Same execution model as backtestResearchV1, but each signal additionally
 * requires higher-timeframe context closed before the decision timestamp.
 */
export function backtestResearchV1WithMtf(strategy: ResearchStrategyId, instrument: string, input: Candle[],
  costs: V2CostModel = DEFAULT_V2_COSTS, signalStartTs = -Infinity,
  params: ResearchStrategyConfig = DEFAULT_RESEARCH_PARAMS,
  sourceTimeframe = "15m", mtfTimeframe = "1H"): ResearchMtfBacktestResult {
  const sourceMs = timeframeMs(sourceTimeframe);
  if (sourceMs === null || timeframeMs(mtfTimeframe) === null) throw new Error("unsupported research timeframe");
  const coverage: Record<MtfContextStatus, number> = { ALIGNED: 0, INSUFFICIENT_DATA: 0, NO_CLOSED_HISTORY: 0 };
  const result = runResearchBacktest(instrument, input, costs, signalStartTs,
    (f, prefix, roundTripCostPct) => {
      const decisionTs = f.ts + sourceMs;
      const context = buildMtfContext({ instrument, sourceTimeframe, timeframe: mtfTimeframe,
        candles: prefix, decisionTs });
      coverage[context.status] += 1;
      return evaluateRegimeAwareResearchV1(strategy, f, prefix, context, roundTripCostPct, params);
    },
    [...RESEARCH_ASSUMPTIONS, `higher-timeframe ${mtfTimeframe} context uses only fully closed ${sourceTimeframe} buckets before the decision timestamp`]);
  return { ...result, mtfTimeframe,
    mtfCoverage: { aligned: coverage.ALIGNED, insufficientData: coverage.INSUFFICIENT_DATA,
      noClosedHistory: coverage.NO_CLOSED_HISTORY } };
}

type ResearchRunner = (strategy: ResearchStrategyId, symbol: string, candles: Candle[], costs: V2CostModel,
  signalStartTs: number, params: ResearchStrategyConfig) => ResearchBacktestResult;

/** Stable per-symbol time splits; OOS bars use preceding candles only as feature warm-up. */
function validateResearchV1Internal(strategy: ResearchStrategyId, histories: ReadonlyMap<string, Candle[]>,
  costs: V2CostModel, trainFraction: number, rollingFolds: number, params: ResearchStrategyConfig,
  run: ResearchRunner): ResearchValidationResult {
  if (!(trainFraction > 0 && trainFraction < 1) || !Number.isInteger(rollingFolds) || rollingFolds < 2) throw new Error("invalid research split configuration");
  const trainBySymbol: Record<string, PerfSummary> = {}, oosBySymbol: Record<string, PerfSummary> = {};
  const trainTrades: ResearchTrade[] = [], oosTrades: ResearchTrade[] = [], rollingExpectancies: number[] = [];
  const excluded = { train: 0, outOfSample: 0, rolling: 0 };
  const funding = costs.researchFunding ?? DEFAULT_RESEARCH_FUNDING;
  const validSymbols = [...histories].filter(([, c]) => c.filter(x => x.confirm === "1").length >= 120).sort(([a], [b]) => a.localeCompare(b));
  for (const [symbol, raw] of validSymbols) {
    const candles = raw.filter(c => c.confirm === "1").slice().sort((a, b) => a.ts - b.ts);
    const boundary = candles[Math.floor(candles.length * trainFraction)]?.ts ?? Infinity;
    const train = run(strategy, symbol, candles.filter(c => c.ts <= boundary), costs, -Infinity, params);
    // Retain full prior history for feature construction, but admit only OOS signals.
    const oos = run(strategy, symbol, candles, costs, boundary, params);
    trainBySymbol[symbol] = train.summary; oosBySymbol[symbol] = oos.summary;
    trainTrades.push(...train.trades.filter(t => t.signalTs < boundary)); oosTrades.push(...oos.trades);
    excluded.train += train.unresolvedTrades.length;
    excluded.outOfSample += oos.unresolvedTrades.length;
    for (let fold = 1; fold < rollingFolds; fold++) {
      const startTs = candles[Math.floor(candles.length * fold / rollingFolds)]?.ts ?? Infinity;
      const endTs = candles[Math.floor(candles.length * (fold + 1) / rollingFolds)]?.ts ?? Infinity;
      const result = run(strategy, symbol, candles.filter(c => c.ts <= endTs), costs, startTs, params);
      excluded.rolling += result.unresolvedTrades.length;
      if (result.trades.length) rollingExpectancies.push(result.summary.expectancy_r);
    }
  }
  const allTrades = [...trainTrades, ...oosTrades];
  const positiveSymbols = Object.entries(oosBySymbol).filter(([, summary]) => summary.expectancy_r > 0).length;
  return { strategy, funding,
    train: { summary: summarizeResearchTrades(trainTrades), bySymbol: trainBySymbol },
    outOfSample: { summary: summarizeResearchTrades(oosTrades), bySymbol: oosBySymbol },
    rolling: { folds: rollingExpectancies.length, positiveFolds: rollingExpectancies.filter(x => x > 0).length, expectancies: rollingExpectancies },
    metrics: { averageMfeR: mean(allTrades.map(t => t.mfeR)), averageMaeR: mean(allTrades.map(t => t.maeR)),
      averageHoldingBars: mean(allTrades.map(t => t.durationBars)), positiveSymbols, evaluatedSymbols: validSymbols.length },
    counts: { trainTrades: trainTrades.length, outOfSampleTrades: oosTrades.length,
      rollingFolds: rollingExpectancies.length, excludedDataEnd: excluded } };
}

export function validateResearchV1(strategy: ResearchStrategyId, histories: ReadonlyMap<string, Candle[]>,
  costs: V2CostModel = DEFAULT_V2_COSTS, trainFraction = 0.8, rollingFolds = 5,
  params: ResearchStrategyConfig = DEFAULT_RESEARCH_PARAMS): ResearchValidationResult {
  return validateResearchV1Internal(strategy, histories, costs, trainFraction, rollingFolds, params,
    (id, symbol, candles, runCosts, start, runParams) => backtestResearchV1(id, symbol, candles, runCosts, start, runParams));
}

export interface ResearchMtfValidationResult extends ResearchValidationResult {
  mtfCoverage: { aligned: number; insufficientData: number; noClosedHistory: number };
  mtfTimeframe: string;
}

/** Out-of-sample and rolling validation using the same closed-candle MTF gate. */
export function validateResearchV1WithMtf(strategy: ResearchStrategyId, histories: ReadonlyMap<string, Candle[]>,
  costs: V2CostModel = DEFAULT_V2_COSTS, trainFraction = 0.8, rollingFolds = 5,
  params: ResearchStrategyConfig = DEFAULT_RESEARCH_PARAMS,
  sourceTimeframe = "15m", mtfTimeframe = "1H"): ResearchMtfValidationResult {
  const coverage = { aligned: 0, insufficientData: 0, noClosedHistory: 0 };
  const result = validateResearchV1Internal(strategy, histories, costs, trainFraction, rollingFolds, params,
    (id, symbol, candles, runCosts, start, runParams) => {
      const run = backtestResearchV1WithMtf(id, symbol, candles, runCosts, start, runParams, sourceTimeframe, mtfTimeframe);
      coverage.aligned += run.mtfCoverage.aligned;
      coverage.insufficientData += run.mtfCoverage.insufficientData;
      coverage.noClosedHistory += run.mtfCoverage.noClosedHistory;
      return run;
    });
  return { ...result, mtfCoverage: coverage, mtfTimeframe };
}

function mean(values: number[]): number { return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0; }
