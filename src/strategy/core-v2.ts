import type { Candle } from "../exchange/okx/types.ts";
import type { FeatureSnapshot } from "../market/features.ts";
import { classifyRegimeAxes, type RegimeAxes } from "../market/regime.ts";
import type { Store } from "../memory/db.ts";
import { familyForV2 } from "./identity.ts";
import { z } from "zod";

export interface StrategyCondition {
  name: string;
  passed: boolean;
  value?: number;
  threshold?: number;
}

export interface StrategyV2Params {
  TREND_FOLLOWING_V2: {
    adx_min: number; volume_ratio_min: number; rsi_min: number; rsi_max: number;
    max_extension_atr: number; stop_atr: number; target_r: number; max_hold_bars: number;
  };
  BREAKOUT_V2: {
    lookback_bars: number; volume_ratio_min: number; min_breakout_atr: number;
    max_breakout_extension_atr: number; adx_min: number; max_candle_body_atr: number;
    stop_atr: number; target_r: number; max_hold_bars: number;
  };
  MEAN_REVERSION_V2: {
    adx_max: number; deviation_atr: number; rsi_low: number; rsi_high: number;
    stop_atr: number; target_r: number; max_hold_bars: number;
  };
}

export const DEFAULT_V2_PARAMS: StrategyV2Params = {
  TREND_FOLLOWING_V2: {
    adx_min: 25, volume_ratio_min: 1.1, rsi_min: 52, rsi_max: 68,
    max_extension_atr: 1.2, stop_atr: 1.5, target_r: 2.5, max_hold_bars: 32,
  },
  BREAKOUT_V2: {
    lookback_bars: 20, volume_ratio_min: 1.3, min_breakout_atr: 0.1,
    max_breakout_extension_atr: 1.25, adx_min: 20, max_candle_body_atr: 1.5,
    stop_atr: 1.3, target_r: 2.2, max_hold_bars: 24,
  },
  MEAN_REVERSION_V2: {
    adx_max: 20, deviation_atr: 1.25, rsi_low: 30, rsi_high: 70,
    stop_atr: 1.4, target_r: 1.5, max_hold_bars: 16,
  },
};

export type StrategyV2Id = keyof StrategyV2Params;

export const StrategyV2ParamsSchema: z.ZodType<StrategyV2Params> = z.object({
  TREND_FOLLOWING_V2: z.object({
    adx_min: z.number().min(10).max(60), volume_ratio_min: z.number().min(0.5).max(5),
    rsi_min: z.number().min(40).max(60), rsi_max: z.number().min(55).max(85),
    max_extension_atr: z.number().min(0.2).max(5), stop_atr: z.number().min(0.5).max(5),
    target_r: z.number().min(0.5).max(10), max_hold_bars: z.number().int().min(1).max(500),
  }).strict(),
  BREAKOUT_V2: z.object({
    lookback_bars: z.number().int().min(3).max(200), volume_ratio_min: z.number().min(0.5).max(5),
    min_breakout_atr: z.number().min(0).max(3), max_breakout_extension_atr: z.number().min(0.2).max(5),
    adx_min: z.number().min(5).max(60), max_candle_body_atr: z.number().min(0.2).max(5),
    stop_atr: z.number().min(0.5).max(5), target_r: z.number().min(0.5).max(10),
    max_hold_bars: z.number().int().min(1).max(500),
  }).strict(),
  MEAN_REVERSION_V2: z.object({
    adx_max: z.number().min(5).max(50), deviation_atr: z.number().min(0.2).max(5),
    rsi_low: z.number().min(5).max(45), rsi_high: z.number().min(55).max(95),
    stop_atr: z.number().min(0.5).max(5), target_r: z.number().min(0.5).max(10),
    max_hold_bars: z.number().int().min(1).max(500),
  }).strict(),
}).strict();

export function parseStrategyV2Params(input: unknown): StrategyV2Params {
  return StrategyV2ParamsSchema.parse(input);
}

export interface TradeCandidate {
  instrument: string;
  engine: "SWING_15M" | "SCALP_5M";
  strategy: StrategyV2Id;
  strategyVersion: number;
  side: "LONG" | "SHORT";
  setupScore: number;
  entryPrice: number;
  stopPrice: number;
  takeProfitPrice: number;
  stopAtr: number;
  targetR: number;
  regime: RegimeAxes;
  conditions: StrategyCondition[];
  reasoning: string[];
  maxHoldBars: number;
  features: FeatureSnapshot;
  signalTs: number;
}

export interface SetupEvaluation {
  strategy: StrategyV2Id;
  side: "LONG" | "SHORT" | null;
  tradable: boolean;
  setupScore: number;
  conditions: StrategyCondition[];
  candidate: TradeCandidate | null;
}

function condition(name: string, passed: boolean, value?: number, threshold?: number): StrategyCondition {
  return { name, passed,
    ...(typeof value === "number" && Number.isFinite(value) ? { value } : {}),
    ...(typeof threshold === "number" && Number.isFinite(threshold) ? { threshold } : {}) };
}

function buildCandidate(
  strategy: StrategyV2Id, strategyVersion: number, side: "LONG" | "SHORT", f: FeatureSnapshot,
  axes: RegimeAxes, params: { stop_atr: number; target_r: number; max_hold_bars: number },
  conditions: StrategyCondition[], setupScore: number,
): TradeCandidate {
  const sign = side === "LONG" ? 1 : -1;
  const stopDistance = params.stop_atr * f.atr14;
  return {
    instrument: f.instrument, engine: "SWING_15M", strategy, strategyVersion, side,
    setupScore: Math.round(setupScore * 1000) / 1000, entryPrice: f.price,
    stopPrice: f.price - sign * stopDistance,
    takeProfitPrice: f.price + sign * stopDistance * params.target_r,
    stopAtr: params.stop_atr, targetR: params.target_r, regime: axes,
    conditions, reasoning: conditions.filter((x) => x.passed).map((x) => x.name),
    maxHoldBars: params.max_hold_bars, features: f, signalTs: f.ts,
  };
}

function result(strategy: StrategyV2Id, side: "LONG" | "SHORT", f: FeatureSnapshot, axes: RegimeAxes,
  params: { stop_atr: number; target_r: number; max_hold_bars: number }, conditions: StrategyCondition[], tradable: boolean, quality?: number, strategyVersion = 2): SetupEvaluation {
  const setupScore = quality ?? (conditions.length ? conditions.filter((x) => x.passed).length / conditions.length : 0);
  return { strategy, side: tradable ? side : null, tradable, setupScore,
    conditions, candidate: tradable ? buildCandidate(strategy, strategyVersion, side, f, axes, params, conditions, setupScore) : null };
}

function unit(n: number): number { return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0; }

export function evaluateTrendFollowingSetup(f: FeatureSnapshot, p = DEFAULT_V2_PARAMS.TREND_FOLLOWING_V2, strategyVersion = 2): SetupEvaluation {
  const axes = classifyRegimeAxes(f);
  const side = axes.trend === "BULL_TREND" ? "LONG" : axes.trend === "BEAR_TREND" ? "SHORT" : null;
  if (!side) return result("TREND_FOLLOWING_V2", "LONG", f, axes, p, [condition("directional_trend", false)], false, undefined, strategyVersion);
  const sign = side === "LONG" ? 1 : -1;
  const extensionAtr = Math.abs(f.price - f.ema20) / f.atr14;
  const rsiOk = side === "LONG" ? f.rsi14 >= p.rsi_min && f.rsi14 <= p.rsi_max
    : f.rsi14 >= 100 - p.rsi_max && f.rsi14 <= 100 - p.rsi_min;
  const cs = [
    condition("sufficient_data", f.sufficientData),
    condition("regime_direction", axes.trend === (side === "LONG" ? "BULL_TREND" : "BEAR_TREND")),
    condition("ema_alignment", (f.ema20 - f.ema50) * sign > 0),
    condition("ema20_slope", (f.ema20SlopePct ?? NaN) * sign > 0, f.ema20SlopePct, 0),
    condition("adx_min", f.adx14 >= p.adx_min, f.adx14, p.adx_min),
    condition("rsi_continuation", rsiOk, f.rsi14, side === "LONG" ? p.rsi_min : 100 - p.rsi_max),
    condition("volume_ratio", f.volumeRatio >= p.volume_ratio_min, f.volumeRatio, p.volume_ratio_min),
    condition("max_extension_atr", extensionAtr <= p.max_extension_atr, extensionAtr, p.max_extension_atr),
  ];
  const tradable = f.sufficientData && cs.every((c) => c.passed);
  const rsiCenter = side === "LONG" ? (p.rsi_min + p.rsi_max) / 2 : 100 - (p.rsi_min + p.rsi_max) / 2;
  const quality = 0.25 * unit((f.adx14 - p.adx_min) / 25)
    + 0.2 * unit((f.volumeRatio - p.volume_ratio_min) / 1.5)
    + 0.2 * unit(1 - Math.abs(f.rsi14 - rsiCenter) / 20)
    + 0.2 * unit(Math.abs(f.emaSpreadPct) / 1)
    + 0.15 * unit(1 - extensionAtr / p.max_extension_atr);
  return result("TREND_FOLLOWING_V2", side, f, axes, p, cs, tradable, quality, strategyVersion);
}

export function evaluateBreakoutSetup(f: FeatureSnapshot, candles: Candle[], p = DEFAULT_V2_PARAMS.BREAKOUT_V2, strategyVersion = 2): SetupEvaluation {
  const xs = candles.filter((c) => c.confirm === "1").slice().sort((a, b) => a.ts - b.ts);
  const current = xs.at(-1);
  const prior = xs.slice(-(p.lookback_bars + 1), -1);
  const axes = classifyRegimeAxes(f);
  if (!current || prior.length < p.lookback_bars || !f.sufficientData || !(f.atr14 > 0)) {
    return result("BREAKOUT_V2", "LONG", f, axes, p, [condition("breakout_history_ready", false, prior.length, p.lookback_bars)], false, undefined, strategyVersion);
  }
  const priorHigh = Math.max(...prior.map((c) => c.h));
  const priorLow = Math.min(...prior.map((c) => c.l));
  const side = current.c > priorHigh ? "LONG" : current.c < priorLow ? "SHORT" : null;
  if (!side) return result("BREAKOUT_V2", "LONG", f, axes, p, [condition("close_outside_prior_range", false)], false, undefined, strategyVersion);
  const sign = side === "LONG" ? 1 : -1;
  const level = side === "LONG" ? priorHigh : priorLow;
  const breakoutAtr = Math.abs(current.c - level) / f.atr14;
  const extensionAtr = Math.abs(current.c - f.ema20) / f.atr14;
  const bodyAtr = Math.abs(current.c - current.o) / f.atr14;
  const supportiveTrend = axes.trend === (side === "LONG" ? "BULL_TREND" : "BEAR_TREND");
  const cs = [
    condition("close_outside_prior_range", true, current.c, level),
    condition("breakout_distance_min", breakoutAtr >= p.min_breakout_atr, breakoutAtr, p.min_breakout_atr),
    condition("volume_expansion", f.volumeRatio >= p.volume_ratio_min, f.volumeRatio, p.volume_ratio_min),
    condition("trend_structure_supportive", supportiveTrend && f.adx14 >= p.adx_min, f.adx14, p.adx_min),
    condition("anti_chase_breakout", breakoutAtr <= p.max_breakout_extension_atr, breakoutAtr, p.max_breakout_extension_atr),
    condition("anti_chase_ema_extension", extensionAtr <= p.max_breakout_extension_atr, extensionAtr, p.max_breakout_extension_atr),
    condition("anti_chase_candle_body", bodyAtr <= p.max_candle_body_atr, bodyAtr, p.max_candle_body_atr),
    condition("directional_ema_slope", (f.ema20SlopePct ?? NaN) * sign > 0, f.ema20SlopePct, 0),
  ];
  const quality = 0.3 * unit(breakoutAtr / p.max_breakout_extension_atr)
    + 0.2 * unit((f.volumeRatio - p.volume_ratio_min) / 1.5)
    + 0.2 * unit((f.adx14 - p.adx_min) / 25)
    + 0.15 * unit(1 - bodyAtr / p.max_candle_body_atr)
    + 0.15 * unit(1 - extensionAtr / (p.max_breakout_extension_atr * 1.5));
  return result("BREAKOUT_V2", side, f, axes, p, cs, cs.every((c) => c.passed), quality, strategyVersion);
}

export function evaluateMeanReversionSetup(f: FeatureSnapshot, candles: Candle[], p = DEFAULT_V2_PARAMS.MEAN_REVERSION_V2, strategyVersion = 2): SetupEvaluation {
  const xs = candles.filter((c) => c.confirm === "1").slice().sort((a, b) => a.ts - b.ts);
  const current = xs.at(-1), previous = xs.at(-2);
  const axes = classifyRegimeAxes(f);
  if (!current || !previous || !f.sufficientData || !(f.atr14 > 0)) {
    return result("MEAN_REVERSION_V2", "LONG", f, axes, p, [condition("confirmation_history_ready", false)], false, undefined, strategyVersion);
  }
  const deviationAtr = (f.price - f.ema20) / f.atr14;
  const side = Math.abs(deviationAtr) >= p.deviation_atr ? (deviationAtr < 0 ? "LONG" : "SHORT") : null;
  if (!side) return result("MEAN_REVERSION_V2", "LONG", f, axes, p, [condition("mean_deviation", false, Math.abs(deviationAtr), p.deviation_atr)], false, undefined, strategyVersion);
  const sign = side === "LONG" ? 1 : -1;
  const priorOutside = side === "LONG"
    ? previous.c <= f.ema20 - p.deviation_atr * f.atr14
    : previous.c >= f.ema20 + p.deviation_atr * f.atr14;
  const structureReclaim = side === "LONG" ? current.c > previous.h : current.c < previous.l;
  const rsiExtreme = side === "LONG" ? f.rsi14 <= p.rsi_low : f.rsi14 >= p.rsi_high;
  const cs = [
    condition("range_context", axes.trend === "RANGE"),
    condition("adx_below_max", f.adx14 <= p.adx_max, f.adx14, p.adx_max),
    condition("price_displacement", Math.abs(deviationAtr) >= p.deviation_atr, Math.abs(deviationAtr), p.deviation_atr),
    condition("rsi_extreme", rsiExtreme, f.rsi14, side === "LONG" ? p.rsi_low : p.rsi_high),
    condition("prior_extreme", priorOutside),
    condition("reversion_confirmation", structureReclaim),
    condition("confirmation_direction", (current.c - previous.c) * sign > 0),
  ];
  const reclaimAtr = side === "LONG" ? (current.c - previous.h) / f.atr14 : (previous.l - current.c) / f.atr14;
  const quality = 0.45 * unit(1 - (Math.abs(deviationAtr) - p.deviation_atr) / p.deviation_atr)
    + 0.3 * unit((side === "LONG" ? p.rsi_low - f.rsi14 : f.rsi14 - p.rsi_high) / 15)
    + 0.25 * unit(reclaimAtr / 0.5);
  return result("MEAN_REVERSION_V2", side, f, axes, p, cs, cs.every((c) => c.passed), quality, strategyVersion);
}

export type StrategyV2Versions = Record<StrategyV2Id, number>;
export const DEFAULT_V2_VERSIONS: StrategyV2Versions = {
  TREND_FOLLOWING_V2: 2, BREAKOUT_V2: 2, MEAN_REVERSION_V2: 2,
};

export function evaluateAllV2Setups(f: FeatureSnapshot, candles: Candle[], params = DEFAULT_V2_PARAMS,
  versions: StrategyV2Versions = DEFAULT_V2_VERSIONS): SetupEvaluation[] {
  return [evaluateTrendFollowingSetup(f, params.TREND_FOLLOWING_V2, versions.TREND_FOLLOWING_V2),
    evaluateBreakoutSetup(f, candles, params.BREAKOUT_V2, versions.BREAKOUT_V2),
    evaluateMeanReversionSetup(f, candles, params.MEAN_REVERSION_V2, versions.MEAN_REVERSION_V2)];
}

export function evaluateV2Setup(strategy: StrategyV2Id, f: FeatureSnapshot, candles: Candle[], params = DEFAULT_V2_PARAMS, strategyVersion = 2): SetupEvaluation {
  switch (strategy) {
    case "TREND_FOLLOWING_V2": return evaluateTrendFollowingSetup(f, params.TREND_FOLLOWING_V2, strategyVersion);
    case "BREAKOUT_V2": return evaluateBreakoutSetup(f, candles, params.BREAKOUT_V2, strategyVersion);
    case "MEAN_REVERSION_V2": return evaluateMeanReversionSetup(f, candles, params.MEAN_REVERSION_V2, strategyVersion);
  }
}

/** Persist immutable V2 definitions for audit/UI; conflicts never rewrite history. */
export function persistV2Definitions(store: Store, params: StrategyV2Params): void {
  const hypotheses: Record<StrategyV2Id, string> = {
    TREND_FOLLOWING_V2: "Continuation requires aligned trend, positive slope, momentum, volume, and bounded extension.",
    BREAKOUT_V2: "Trade confirmed range breaks with expansion while rejecting overextended breakout candles.",
    MEAN_REVERSION_V2: "Fade statistically displaced range prices only after price reclaims nearby structure.",
  };
  const insert = store.db.prepare(`INSERT INTO strategy_versions(name,version,parent_version,params,status,created_ts,hypothesis)
    VALUES(?,2,NULL,?,'TESTING',?,?) ON CONFLICT(name,version) DO NOTHING`);
  for (const strategy of Object.keys(params) as StrategyV2Id[]) {
    const name = familyForV2(strategy);
    insert.run(name, JSON.stringify(params[strategy]), new Date().toISOString(), hypotheses[strategy]);
  }
}
