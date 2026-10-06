// M7 (§35) — deterministic event-driven backtest over candles for a strategy.
// Same scorer as live (strategy/library) → champion/challenger comparability.
import type { Candle } from "../exchange/okx/types.ts";
import { buildFeatures } from "../market/features.ts";
import { classifyRegime } from "../market/regime.ts";
import { scoreStrategy, type StrategyDef } from "../strategy/library.ts";
import { summarize, type PerfSummary } from "./performance.ts";
import { DEFAULT_V2_PARAMS, evaluateV2Setup, type StrategyV2Id, type StrategyV2Params } from "../strategy/core-v2.ts";
import type { RegimeAxes } from "../market/regime.ts";
import { calculateSlPlusStop } from "../execution/sl-plus.ts";

export interface BacktestResult {
  summary: PerfSummary;
  trades: Array<{ entryTs: number; side: "LONG" | "SHORT"; resultR: number; grossR: number; feesR: number; exitReason: string }>;
}

export function backtest(def: StrategyDef, candlesChrono: Candle[], timeframe: string, costs: V2CostModel = DEFAULT_V2_COSTS): BacktestResult {
  void timeframe;
  const candles = candlesChrono.filter((c) => c.confirm === "1").slice().sort((a, b) => a.ts - b.ts);
  const rs: number[] = [];
  const trades: BacktestResult["trades"] = [];
  let i = 59;
  while (i < candles.length - 1) {
    const window = candles.slice(0, i + 1);
    const f = buildFeatures(def.name, window.slice().reverse()); // newest-first input
    const regime = classifyRegime(f);
    if (!def.allowed_regimes.includes(regime) || !f.sufficientData) { i++; continue; }
    const s = scoreStrategy(def, f);
    if (Math.abs(s) < 0.6) { i++; continue; }
    const side: "LONG" | "SHORT" = s > 0 ? "LONG" : "SHORT";
    const entryBar = candles[i + 1]!;
    const entry = entryBar.o; // confirmed close signal; enter at next open
    const atrV = f.atr14;
    if (!Number.isFinite(entry) || !Number.isFinite(atrV) || atrV <= 0) { i++; continue; }
    const riskDistance = def.params.stop_atr * atrV;
    const targetDistance = def.params.take_profit_atr * atrV;
    const sign = side === "LONG" ? 1 : -1;
    const initialStop = entry - sign * riskDistance;
    const target = entry + sign * targetDistance;
    let activeStop = initialStop;
    let exitPrice = entry;
    let exitReason = "DATA_END";
    let exitIndex = candles.length - 1;
    let resolved = false;
    let mfe = 0;
    for (let j = i + 1; j < candles.length; j++) {
      const c = candles[j]!;
      const favorable = side === "LONG" ? c.h - entry : entry - c.l;
      mfe = Math.max(mfe, favorable);
      const stopHit = side === "LONG" ? c.l <= activeStop : c.h >= activeStop;
      const targetHit = side === "LONG" ? c.h >= target : c.l <= target;
      if (stopHit) {
        exitPrice = side === "LONG" ? Math.min(c.o, activeStop) : Math.max(c.o, activeStop);
        exitReason = activeStop === initialStop ? "SL" : "SL_PLUS"; exitIndex = j; resolved = true; break;
      }
      if (targetHit) { exitPrice = target; exitReason = "TP"; exitIndex = j; resolved = true; break; }
      if (costs.slPlus.enabled && mfe / riskDistance >= costs.slPlus.activationR) {
        const next = calculateSlPlusStop({ side, entryPx: entry, initialStopPx: initialStop, currentStopPx: activeStop,
          markPx: c.c, tickSz: Math.max(entry * 1e-8, Number.EPSILON), activationR: costs.slPlus.activationR,
          lockInR: costs.slPlus.lockInR, minProfitBufferPct: costs.slPlus.minProfitBufferPct });
        if (next !== null) activeStop = next;
      }
    }
    if (!resolved) exitPrice = candles[exitIndex]!.c;
    const grossR = ((exitPrice - entry) * sign) / riskDistance;
    const feesR = ((costs.entryFeePct + costs.exitFeePct) / 100 + 2 * (costs.slippageBps + costs.spreadBps) / 10_000)
      * (entry + exitPrice) / riskDistance;
    const resultR = Math.round((grossR - feesR) * 1000) / 1000;
    rs.push(resultR);
    trades.push({ entryTs: entryBar.ts, side, resultR, grossR, feesR, exitReason });
    i = Math.max(i + 4, exitIndex + 4);
  }
  return { summary: summarize(rs), trades };
}

// M7 (§36) — walk-forward: K consecutive out-of-sample folds, each fit on the
// preceding in-sample window; score = mean fold expectancy + stability.
export function walkForward(def: StrategyDef, candles: Candle[], timeframe: string, folds = 4, costs: V2CostModel = DEFAULT_V2_COSTS): { foldExpectancies: number[]; mean: number; positiveFolds: number } {
  const size = Math.floor(candles.length / folds);
  const exps: number[] = [];
  for (let k = 1; k < folds; k++) {
    const oos = candles.slice(k * size, (k + 1) * size);
    const res = backtest(def, oos, timeframe, costs);
    exps.push(Math.round(res.summary.expectancy_r * 1000) / 1000);
  }
  const mean = exps.reduce((a, b) => a + b, 0) / (exps.length || 1);
  return { foldExpectancies: exps, mean, positiveFolds: exps.filter((e) => e > 0).length };
}

export interface V2CostModel {
  entryFeePct: number; exitFeePct: number; // percent of notional, each side
  slippageBps: number; spreadBps: number; // each side
  slPlus: { enabled: boolean; activationR: number; lockInR: number; minProfitBufferPct: number };
}
export const DEFAULT_V2_COSTS: V2CostModel = {
  entryFeePct: 0.05, exitFeePct: 0.05, slippageBps: 1.5, spreadBps: 1.5,
  slPlus: { enabled: true, activationR: 1, lockInR: 0.05, minProfitBufferPct: 0.12 },
};
export interface V2BacktestTrade {
  engine: "SWING_15M"; instrument: string; strategy: StrategyV2Id; strategyVersion: 2; regime: RegimeAxes;
  entryTs: number; exitTs: number; side: "LONG" | "SHORT"; entryPrice: number; exitPrice: number;
  grossR: number; netR: number; feesR: number; exitReason: "SL" | "TP" | "SL_PLUS" | "TIME_STOP" | "DATA_END";
  mfeR: number; maeR: number;
}
export interface V2BacktestResult {
  summary: PerfSummary; grossExpectancyR: number; netExpectancyR: number;
  trades: V2BacktestTrade[]; assumptions: { intrabar: string; entry: string; costs: V2CostModel };
}

/** V2 evaluation uses the exact pure setup evaluator used by scanCoreV2. */
export function backtestV2(
  strategy: StrategyV2Id, candlesChrono: Candle[], timeframe: string,
  params: StrategyV2Params = DEFAULT_V2_PARAMS,
  costs: V2CostModel = DEFAULT_V2_COSTS,
  instrument = "BACKTEST",
): V2BacktestResult {
  void timeframe;
  const candles = candlesChrono.filter((c) => c.confirm === "1").slice().sort((a, b) => a.ts - b.ts);
  const trades: V2BacktestTrade[] = [];
  let i = 59;
  while (i < candles.length - 1) {
    const prefix = candles.slice(0, i + 1);
    const features = buildFeatures(instrument, prefix.slice().reverse());
    const evaluated = evaluateV2Setup(strategy, features, prefix, params);
    const candidate = evaluated.candidate;
    if (!candidate) { i++; continue; }
    const entryBar = candles[i + 1]!;
    const entryPrice = entryBar.o; // signal at close; market entry modeled at next open
    const riskDistance = candidate.stopAtr * features.atr14;
    if (!(entryPrice > 0 && riskDistance > 0)) { i++; continue; }
    const sign = candidate.side === "LONG" ? 1 : -1;
    const stopAt = entryPrice - sign * riskDistance;
    const targetAt = entryPrice + sign * riskDistance * candidate.targetR;
    let activeStop = stopAt;
    let exitPrice = entryBar.c;
    let exitTs = entryBar.ts;
    let exitReason: V2BacktestTrade["exitReason"] = "DATA_END";
    let mfe = 0, mae = 0;
    const maxBars = strategy === "TREND_FOLLOWING_V2" ? params.TREND_FOLLOWING_V2.max_hold_bars
      : strategy === "BREAKOUT_V2" ? params.BREAKOUT_V2.max_hold_bars : params.MEAN_REVERSION_V2.max_hold_bars;
    const lastBar = Math.min(candles.length - 1, i + maxBars);
    let resolved = false;
    for (let j = i + 1; j <= lastBar; j++) {
      const c = candles[j]!;
      const favorable = candidate.side === "LONG" ? c.h - entryPrice : entryPrice - c.l;
      const adverse = candidate.side === "LONG" ? entryPrice - c.l : c.h - entryPrice;
      mfe = Math.max(mfe, favorable); mae = Math.max(mae, adverse);
      const stopHit = candidate.side === "LONG" ? c.l <= activeStop : c.h >= activeStop;
      const targetHit = candidate.side === "LONG" ? c.h >= targetAt : c.l <= targetAt;
      if (stopHit) {
        // Conservative gap handling; if SL and TP share a candle, stop wins.
        exitPrice = candidate.side === "LONG" ? Math.min(c.o, activeStop) : Math.max(c.o, activeStop);
        exitTs = c.ts;
        exitReason = activeStop === stopAt ? "SL" : "SL_PLUS";
        resolved = true; break;
      }
      if (targetHit) { exitPrice = targetAt; exitTs = c.ts; exitReason = "TP"; resolved = true; break; }
      if (costs.slPlus.enabled && favorable / riskDistance >= costs.slPlus.activationR) {
        const nextStop = calculateSlPlusStop({ side: candidate.side, entryPx: entryPrice,
          initialStopPx: stopAt, currentStopPx: activeStop, markPx: c.c,
          tickSz: Math.max(entryPrice * 1e-8, Number.EPSILON), activationR: costs.slPlus.activationR,
          lockInR: costs.slPlus.lockInR, minProfitBufferPct: costs.slPlus.minProfitBufferPct });
        if (nextStop !== null) activeStop = nextStop; // close-based, takes effect from next modeled candle
      }
      if (j - i >= maxBars) {
        const next = candles[j + 1];
        exitPrice = next?.o ?? c.c;
        exitTs = next?.ts ?? c.ts;
        exitReason = "TIME_STOP"; resolved = true; break;
      }
    }
    if (!resolved) { const c = candles[lastBar]!; exitPrice = c.c; exitTs = c.ts; }
    const grossR = ((exitPrice - entryPrice) * sign) / riskDistance;
    const costFraction = (costs.entryFeePct + costs.exitFeePct) / 100 +
      2 * (costs.slippageBps + costs.spreadBps) / 10_000;
    const feesR = costFraction * (entryPrice + exitPrice) / riskDistance;
    const netR = grossR - feesR;
    trades.push({ engine: "SWING_15M", instrument, strategy, strategyVersion: 2, regime: candidate.regime,
      entryTs: entryBar.ts, exitTs, side: candidate.side, entryPrice, exitPrice,
      grossR, netR, feesR, exitReason, mfeR: mfe / riskDistance, maeR: mae / riskDistance });
    i = Math.max(i + 1, candles.findIndex((c) => c.ts === exitTs) + 1);
  }
  const gross = trades.map((t) => t.grossR), net = trades.map((t) => t.netR);
  return {
    summary: summarize(net),
    grossExpectancyR: gross.length ? gross.reduce((a, b) => a + b, 0) / gross.length : 0,
    netExpectancyR: net.length ? net.reduce((a, b) => a + b, 0) / net.length : 0,
    trades,
    assumptions: { intrabar: "If stop and target both touch in one candle, stop fills first; gaps through stops fill at the worse open.",
      entry: "Setup is evaluated on a confirmed close and entered at the next candle open.", costs },
  };
}

export function walkForwardV2(strategy: StrategyV2Id, candles: Candle[], timeframe: string, folds = 5,
  params: StrategyV2Params = DEFAULT_V2_PARAMS, costs: V2CostModel = DEFAULT_V2_COSTS): {
    foldExpectancies: number[]; positiveFolds: number; mean: number; worstFold: number; dispersion: number;
  } {
  const size = Math.floor(candles.length / folds);
  const foldExpectancies: number[] = [];
  for (let k = 1; k < folds; k++) {
    const fold = candles.slice(k * size, (k + 1) * size);
    foldExpectancies.push(backtestV2(strategy, fold, timeframe, params, costs).netExpectancyR);
  }
  const mean = foldExpectancies.length ? foldExpectancies.reduce((a, b) => a + b, 0) / foldExpectancies.length : 0;
  const variance = foldExpectancies.length ? foldExpectancies.reduce((a, b) => a + (b - mean) ** 2, 0) / foldExpectancies.length : 0;
  return { foldExpectancies, positiveFolds: foldExpectancies.filter((x) => x > 0).length,
    mean, worstFold: foldExpectancies.length ? Math.min(...foldExpectancies) : 0, dispersion: Math.sqrt(variance) };
}
