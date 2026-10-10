import type { Candle } from "../exchange/okx/types.ts";
import { buildFeatures } from "../market/features.ts";
import { calculateSlPlusStop } from "../execution/sl-plus.ts";
import { summarize, type PerfSummary } from "./performance.ts";
import { calculateExecutionCostR, DEFAULT_V2_COSTS, type V2CostModel } from "./backtest.ts";
import {
  DEFAULT_BREAKOUT_RETEST_V1, DEFAULT_TREND_PULLBACK_V1, evaluateBreakoutRetestV1,
  evaluateTrendPullbackV1, type ResearchStrategyConfig, type ResearchStrategyId,
} from "../strategy/research-v1.ts";

export interface ResearchTrade {
  instrument: string;
  signalTs: number;
  entryTs: number;
  exitTs: number;
  side: "LONG" | "SHORT";
  resultR: number;
  grossR: number;
  feesR: number;
  exitReason: "SL" | "TP" | "SL_PLUS" | "TIME_STOP" | "DATA_END";
  mfeR: number;
  maeR: number;
  durationBars: number;
}
export interface ResearchBacktestResult { summary: PerfSummary; trades: ResearchTrade[]; assumptions: string[] }
export interface ResearchValidationResult {
  strategy: ResearchStrategyId;
  train: { summary: PerfSummary; bySymbol: Record<string, PerfSummary> };
  outOfSample: { summary: PerfSummary; bySymbol: Record<string, PerfSummary> };
  rolling: { folds: number; positiveFolds: number; expectancies: number[] };
  metrics: { averageMfeR: number; averageMaeR: number; averageHoldingBars: number; positiveSymbols: number; evaluatedSymbols: number };
}

export function backtestResearchV1(strategy: ResearchStrategyId, instrument: string, input: Candle[],
  costs: V2CostModel = DEFAULT_V2_COSTS, signalStartTs = -Infinity,
  params: ResearchStrategyConfig = { trend_pullback_v1: DEFAULT_TREND_PULLBACK_V1, breakout_retest_v1: DEFAULT_BREAKOUT_RETEST_V1 }): ResearchBacktestResult {
  const candles = input.filter(c => c.confirm === "1").slice().sort((a, b) => a.ts - b.ts);
  const trades: ResearchTrade[] = [];
  let i = 59;
  while (i < candles.length - 1) {
    const prefix = candles.slice(0, i + 1);
    const f = buildFeatures(instrument, prefix.slice().reverse());
    const evaluation = strategy === "TREND_PULLBACK_V1"
      ? evaluateTrendPullbackV1(f, prefix, params.trend_pullback_v1)
      : evaluateBreakoutRetestV1(f, prefix, params.breakout_retest_v1);
    const candidate = evaluation.candidate;
    if (!candidate || f.ts < signalStartTs) { i++; continue; }
    const entryBar = candles[i + 1]!;
    const entryPrice = entryBar.o;
    const riskDistance = candidate.stopAtr * f.atr14;
    if (!(entryPrice > 0 && riskDistance > 0)) { i++; continue; }
    const sign = candidate.side === "LONG" ? 1 : -1;
    const initialStop = entryPrice - sign * riskDistance;
    const target = entryPrice + sign * riskDistance * candidate.targetR;
    let activeStop = initialStop, exitPrice = entryPrice, exitTs = entryBar.ts, exitReason: ResearchTrade["exitReason"] = "DATA_END";
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
    if (!resolved) { const last = candles[exitIndex]!; exitPrice = last.c; exitTs = last.ts; }
    const grossR = (exitPrice - entryPrice) * sign / riskDistance;
    const feesR = calculateExecutionCostR(entryPrice, exitPrice, riskDistance, costs);
    trades.push({ instrument, signalTs: candidate.signalTs, entryTs: entryBar.ts, exitTs, side: candidate.side,
      grossR, feesR, resultR: grossR - feesR, exitReason, mfeR: mfe / riskDistance, maeR: mae / riskDistance,
      durationBars: Math.max(1, exitIndex - i) });
    i = Math.max(i + 1, exitIndex + 1);
  }
  return { summary: summarize(trades.map(t => t.resultR)), trades,
    assumptions: ["confirmed close signal enters at next candle open", "stop wins if stop and target touch on one candle",
      "fees, slippage, spread and SL+ use the current V2 cost model", "research-only; no order or promotion authority"] };
}

/** Stable per-symbol time splits; OOS bars use preceding candles only as feature warm-up. */
export function validateResearchV1(strategy: ResearchStrategyId, histories: ReadonlyMap<string, Candle[]>,
  costs: V2CostModel = DEFAULT_V2_COSTS, trainFraction = 0.8, rollingFolds = 5,
  params: ResearchStrategyConfig = { trend_pullback_v1: DEFAULT_TREND_PULLBACK_V1, breakout_retest_v1: DEFAULT_BREAKOUT_RETEST_V1 }): ResearchValidationResult {
  if (!(trainFraction > 0 && trainFraction < 1) || !Number.isInteger(rollingFolds) || rollingFolds < 2) throw new Error("invalid research split configuration");
  const trainBySymbol: Record<string, PerfSummary> = {}, oosBySymbol: Record<string, PerfSummary> = {};
  const trainTrades: ResearchTrade[] = [], oosTrades: ResearchTrade[] = [], rollingExpectancies: number[] = [];
  const validSymbols = [...histories].filter(([, c]) => c.filter(x => x.confirm === "1").length >= 120).sort(([a], [b]) => a.localeCompare(b));
  for (const [symbol, raw] of validSymbols) {
    const candles = raw.filter(c => c.confirm === "1").slice().sort((a, b) => a.ts - b.ts);
    const boundary = candles[Math.floor(candles.length * trainFraction)]?.ts ?? Infinity;
    const train = backtestResearchV1(strategy, symbol, candles.filter(c => c.ts <= boundary), costs, -Infinity, params);
    // Retain full prior history for feature construction, but admit only OOS signals.
    const oos = backtestResearchV1(strategy, symbol, candles, costs, boundary, params);
    trainBySymbol[symbol] = train.summary; oosBySymbol[symbol] = oos.summary;
    trainTrades.push(...train.trades.filter(t => t.signalTs < boundary)); oosTrades.push(...oos.trades);
    for (let fold = 1; fold < rollingFolds; fold++) {
      const startTs = candles[Math.floor(candles.length * fold / rollingFolds)]?.ts ?? Infinity;
      const endTs = candles[Math.floor(candles.length * (fold + 1) / rollingFolds)]?.ts ?? Infinity;
      const result = backtestResearchV1(strategy, symbol, candles.filter(c => c.ts <= endTs), costs, startTs, params);
      if (result.trades.length) rollingExpectancies.push(result.summary.expectancy_r);
    }
  }
  const allTrades = [...trainTrades, ...oosTrades];
  const positiveSymbols = Object.entries(oosBySymbol).filter(([, summary]) => summary.expectancy_r > 0).length;
  return { strategy,
    train: { summary: summarize(trainTrades.map(t => t.resultR)), bySymbol: trainBySymbol },
    outOfSample: { summary: summarize(oosTrades.map(t => t.resultR)), bySymbol: oosBySymbol },
    rolling: { folds: rollingExpectancies.length, positiveFolds: rollingExpectancies.filter(x => x > 0).length, expectancies: rollingExpectancies },
    metrics: { averageMfeR: mean(allTrades.map(t => t.mfeR)), averageMaeR: mean(allTrades.map(t => t.maeR)),
      averageHoldingBars: mean(allTrades.map(t => t.durationBars)), positiveSymbols, evaluatedSymbols: validSymbols.length } };
}

function mean(values: number[]): number { return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0; }
