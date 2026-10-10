import { z } from "zod";
import type { Candle } from "../exchange/okx/types.ts";
import type { FeatureSnapshot } from "../market/features.ts";
import { classifyRegimeAxes, type RegimeAxes } from "../market/regime.ts";

export const TrendPullbackParamsSchema = z.object({
  adx_min: z.number().min(10).max(60),
  pullback_min_atr: z.number().min(0).max(1),
  pullback_max_atr: z.number().min(0.1).max(2),
  max_ema_invalidation_atr: z.number().min(0.1).max(2),
  rsi_long_min: z.number().min(30).max(55),
  rsi_long_max: z.number().min(50).max(75),
  volume_ratio_min: z.number().min(0.1).max(3),
  volume_ratio_max: z.number().min(1).max(5),
  pullback_volume_ratio_max: z.number().min(0.5).max(4),
  max_extension_atr: z.number().min(0.2).max(3),
  stop_atr: z.number().min(0.5).max(5),
  target_r: z.number().min(0.5).max(10),
  max_hold_bars: z.number().int().min(1).max(500),
}).strict().refine(p => p.pullback_min_atr < p.pullback_max_atr, "pullback_min_atr must be below pullback_max_atr")
  .refine(p => p.rsi_long_min < p.rsi_long_max, "rsi_long_min must be below rsi_long_max")
  .refine(p => p.volume_ratio_min < p.volume_ratio_max, "volume_ratio_min must be below volume_ratio_max");
export type TrendPullbackParams = z.infer<typeof TrendPullbackParamsSchema>;

export const BreakoutRetestParamsSchema = z.object({
  lookback_bars: z.number().int().min(10).max(100),
  max_retest_bars: z.number().int().min(1).max(8),
  min_breakout_atr: z.number().min(0).max(2),
  breakout_volume_ratio_min: z.number().min(0.5).max(5),
  adx_min: z.number().min(10).max(60),
  retest_tolerance_atr: z.number().min(0.05).max(1),
  lost_level_tolerance_atr: z.number().min(0).max(0.75),
  max_extension_atr: z.number().min(0.2).max(3),
  max_confirmation_body_atr: z.number().min(0.2).max(3),
  volume_ratio_min: z.number().min(0.1).max(3),
  volume_ratio_max: z.number().min(1).max(5),
  stop_atr: z.number().min(0.5).max(5),
  target_r: z.number().min(0.5).max(10),
  max_hold_bars: z.number().int().min(1).max(500),
}).strict().refine(p => p.volume_ratio_min < p.volume_ratio_max, "volume_ratio_min must be below volume_ratio_max");
export type BreakoutRetestParams = z.infer<typeof BreakoutRetestParamsSchema>;

export const ResearchStrategyConfigSchema = z.object({
  trend_pullback_v1: TrendPullbackParamsSchema,
  breakout_retest_v1: BreakoutRetestParamsSchema,
}).strict();
export type ResearchStrategyConfig = z.infer<typeof ResearchStrategyConfigSchema>;
export function parseResearchStrategyConfig(input: unknown): ResearchStrategyConfig {
  return ResearchStrategyConfigSchema.parse(input);
}

export const DEFAULT_TREND_PULLBACK_V1: TrendPullbackParams = TrendPullbackParamsSchema.parse({
  adx_min: 22, pullback_min_atr: 0.15, pullback_max_atr: 0.75, max_ema_invalidation_atr: 1.25,
  rsi_long_min: 45, rsi_long_max: 62, volume_ratio_min: 0.7, volume_ratio_max: 2.5, pullback_volume_ratio_max: 1.8,
  max_extension_atr: 1.0, stop_atr: 1.3, target_r: 2.0, max_hold_bars: 24,
});
export const DEFAULT_BREAKOUT_RETEST_V1: BreakoutRetestParams = BreakoutRetestParamsSchema.parse({
  lookback_bars: 20, max_retest_bars: 4, min_breakout_atr: 0.1,
  breakout_volume_ratio_min: 1.15, adx_min: 20, retest_tolerance_atr: 0.35,
  lost_level_tolerance_atr: 0.2, max_extension_atr: 1.4, max_confirmation_body_atr: 1.3,
  volume_ratio_min: 0.65, volume_ratio_max: 2.5, stop_atr: 1.3, target_r: 2.1, max_hold_bars: 24,
});

export type ResearchStrategyId = "TREND_PULLBACK_V1" | "BREAKOUT_RETEST_V1";
export interface ResearchCandidate {
  strategy: ResearchStrategyId;
  side: "LONG" | "SHORT";
  setupScore: number;
  entryPrice: number;
  stopPrice: number;
  takeProfitPrice: number;
  stopAtr: number;
  targetR: number;
  maxHoldBars: number;
  signalTs: number;
  conditions: Array<{ name: string; passed: boolean; value?: number; threshold?: number }>;
  regime: RegimeAxes;
}
export interface ResearchEvaluation { candidate: ResearchCandidate | null; conditions: ResearchCandidate["conditions"]; setupScore: number }

function condition(name: string, passed: boolean, value?: number, threshold?: number) {
  return { name, passed, ...(typeof value === "number" && Number.isFinite(value) ? { value } : {}),
    ...(typeof threshold === "number" && Number.isFinite(threshold) ? { threshold } : {}) };
}
function finish(strategy: ResearchStrategyId, side: "LONG" | "SHORT", f: FeatureSnapshot, axes: RegimeAxes,
  stopAtr: number, targetR: number, maxHoldBars: number, conditions: ResearchCandidate["conditions"], quality: number): ResearchEvaluation {
  const tradable = conditions.every(item => item.passed) && f.sufficientData && f.price > 0 && f.atr14 > 0;
  const distance = stopAtr * f.atr14, sign = side === "LONG" ? 1 : -1;
  return { setupScore: Math.max(0, Math.min(1, Number.isFinite(quality) ? quality : 0)), conditions,
    candidate: tradable ? { strategy, side, setupScore: Math.max(0, Math.min(1, quality)), entryPrice: f.price,
      stopPrice: f.price - sign * distance, takeProfitPrice: f.price + sign * distance * targetR,
      stopAtr, targetR, maxHoldBars, signalTs: f.ts, conditions, regime: axes } : null };
}

/** Research-only deterministic pullback continuation; not wired to live scanner. */
export function evaluateTrendPullbackV1(f: FeatureSnapshot, candles: Candle[], raw: TrendPullbackParams = DEFAULT_TREND_PULLBACK_V1): ResearchEvaluation {
  const p = TrendPullbackParamsSchema.parse(raw);
  const xs = candles.filter(c => c.confirm === "1").slice().sort((a, b) => a.ts - b.ts);
  const pullback = xs.at(-2), confirm = xs.at(-1), axes = classifyRegimeAxes(f);
  const side: "LONG" | "SHORT" = axes.trend === "BEAR_TREND" ? "SHORT" : "LONG";
  const sign = side === "LONG" ? 1 : -1;
  const pullbackDistance = pullback ? Math.abs(pullback.c - f.ema20) / f.atr14 : NaN;
  const invalidation = pullback ? (side === "LONG" ? f.ema20 - pullback.l : pullback.h - f.ema20) / f.atr14 : NaN;
  const priorVolumeMean = xs.length > 2 ? xs.slice(Math.max(0, xs.length - 22), -2).reduce((sum, candle) => sum + candle.vol, 0) / xs.slice(Math.max(0, xs.length - 22), -2).length : NaN;
  const pullbackVolumeRatio = pullback && priorVolumeMean > 0 ? pullback.vol / priorVolumeMean : NaN;
  const rsiOk = side === "LONG" ? f.rsi14 >= p.rsi_long_min && f.rsi14 <= p.rsi_long_max
    : f.rsi14 >= 100 - p.rsi_long_max && f.rsi14 <= 100 - p.rsi_long_min;
  const confirmation = !!(pullback && confirm) && (side === "LONG" ? confirm!.c > pullback!.h && confirm!.c > confirm!.o : confirm!.c < pullback!.l && confirm!.c < confirm!.o);
  const conditions = [
    condition("sufficient_data", f.sufficientData),
    condition("trend_regime", axes.trend === (side === "LONG" ? "BULL_TREND" : "BEAR_TREND")),
    condition("ema_alignment", (f.ema20 - f.ema50) * sign > 0),
    condition("ema_slope", (f.ema20SlopePct ?? NaN) * sign > 0),
    condition("adx_floor", f.adx14 >= p.adx_min, f.adx14, p.adx_min),
    condition("pullback_zone", pullbackDistance >= p.pullback_min_atr && pullbackDistance <= p.pullback_max_atr, pullbackDistance, p.pullback_max_atr),
    condition("pullback_direction", pullback ? (side === "LONG" ? pullback.c <= f.ema20 + 0.1 * f.atr14 : pullback.c >= f.ema20 - 0.1 * f.atr14) : false),
    condition("trend_not_invalidated", invalidation <= p.max_ema_invalidation_atr, invalidation, p.max_ema_invalidation_atr),
    condition("rsi_reset", rsiOk, f.rsi14),
    condition("confirmation_structure", confirmation),
    condition("anti_chase", Math.abs(f.price - f.ema20) / f.atr14 <= p.max_extension_atr),
    condition("volume_behavior", f.volumeRatio >= p.volume_ratio_min && f.volumeRatio <= p.volume_ratio_max, f.volumeRatio),
    condition("valid_stop_geometry", f.atr14 > 0 && f.price > p.stop_atr * f.atr14),
    condition("pullback_pressure", pullback ? (side === "LONG" ? pullback.c <= pullback.o : pullback.c >= pullback.o)
      && pullbackVolumeRatio <= p.pullback_volume_ratio_max : false, pullbackVolumeRatio, p.pullback_volume_ratio_max),
  ];
  const quality = 0.25 * unit((f.adx14 - p.adx_min) / 25) + 0.2 * unit(1 - pullbackDistance / p.pullback_max_atr)
    + 0.2 * unit(1 - Math.abs(f.rsi14 - 50) / 20) + 0.2 * unit(f.volumeRatio / p.volume_ratio_max)
    + 0.15 * unit(1 - Math.abs(f.price - f.ema20) / (p.max_extension_atr * f.atr14));
  return finish("TREND_PULLBACK_V1", side, f, axes, p.stop_atr, p.target_r, p.max_hold_bars, conditions, quality);
}

/** Research-only retest of a confirmed range breakout; not wired to live scanner. */
export function evaluateBreakoutRetestV1(f: FeatureSnapshot, candles: Candle[], raw: BreakoutRetestParams = DEFAULT_BREAKOUT_RETEST_V1): ResearchEvaluation {
  const p = BreakoutRetestParamsSchema.parse(raw);
  const xs = candles.filter(c => c.confirm === "1").slice().sort((a, b) => a.ts - b.ts);
  const current = xs.at(-1), previous = xs.at(-2), axes = classifyRegimeAxes(f);
  let side: "LONG" | "SHORT" = axes.trend === "BEAR_TREND" ? "SHORT" : "LONG";
  let level = NaN, breakoutAtr = NaN, retestFound = false, breakoutFound = false;
  if (current && previous && f.atr14 > 0 && axes.trend !== "UNKNOWN") {
    const first = Math.max(p.lookback_bars, xs.length - p.max_retest_bars - 2);
    for (let breakoutIndex = first; breakoutIndex <= xs.length - 3; breakoutIndex++) {
      const breakout = xs[breakoutIndex]!;
      const prior = xs.slice(breakoutIndex - p.lookback_bars, breakoutIndex);
      if (prior.length < p.lookback_bars) continue;
      const high = Math.max(...prior.map(c => c.h)), low = Math.min(...prior.map(c => c.l));
      const direction = breakout.c > high ? "LONG" : breakout.c < low ? "SHORT" : null;
      if (!direction) continue;
      const sign = direction === "LONG" ? 1 : -1, testLevel = direction === "LONG" ? high : low;
      const distance = Math.abs(breakout.c - testLevel) / f.atr14;
      const priorVolumeMean = prior.reduce((sum, candle) => sum + candle.vol, 0) / prior.length;
      if (distance < p.min_breakout_atr || breakout.vol / Math.max(priorVolumeMean, Number.EPSILON) < p.breakout_volume_ratio_min
        || axes.trend !== (direction === "LONG" ? "BULL_TREND" : "BEAR_TREND")) continue;
      const retestBars = xs.slice(breakoutIndex + 1, -1);
      const held = retestBars.some(bar => direction === "LONG"
        ? bar.l <= testLevel + p.retest_tolerance_atr * f.atr14 && bar.c >= testLevel - p.lost_level_tolerance_atr * f.atr14
        : bar.h >= testLevel - p.retest_tolerance_atr * f.atr14 && bar.c <= testLevel + p.lost_level_tolerance_atr * f.atr14);
      if (!held) continue;
      side = direction; level = testLevel; breakoutAtr = distance; retestFound = true; breakoutFound = true;
    }
  }
  const sign = side === "LONG" ? 1 : -1;
  const extension = f.atr14 > 0 ? Math.abs(f.price - level) / f.atr14 : NaN;
  const bodyAtr = current && f.atr14 > 0 ? Math.abs(current.c - current.o) / f.atr14 : NaN;
  const confirmation = !!(previous && current) && (side === "LONG" ? current!.c > previous!.h && current!.c > current!.o : current!.c < previous!.l && current!.c < current!.o);
  const conditions = [
    condition("sufficient_data", f.sufficientData),
    condition("confirmed_breakout", breakoutFound),
    condition("supportive_trend", axes.trend === (side === "LONG" ? "BULL_TREND" : "BEAR_TREND") && f.adx14 >= p.adx_min, f.adx14, p.adx_min),
    condition("bounded_retest", retestFound),
    condition("level_held", Number.isFinite(level) && (side === "LONG" ? current ? current.l >= level - p.lost_level_tolerance_atr * f.atr14 : false
      : current ? current.h <= level + p.lost_level_tolerance_atr * f.atr14 : false)),
    condition("continuation_confirmation", confirmation),
    condition("anti_chase", Number.isFinite(extension) && extension <= p.max_extension_atr, extension, p.max_extension_atr),
    condition("confirmation_body", Number.isFinite(bodyAtr) && bodyAtr <= p.max_confirmation_body_atr, bodyAtr, p.max_confirmation_body_atr),
    condition("volume_context", f.volumeRatio >= p.volume_ratio_min && f.volumeRatio <= p.volume_ratio_max, f.volumeRatio),
    condition("valid_stop_geometry", f.atr14 > 0 && f.price > p.stop_atr * f.atr14),
  ];
  const quality = 0.25 * unit(breakoutAtr / Math.max(p.min_breakout_atr, 0.01))
    + 0.2 * unit(1 - extension / p.max_extension_atr) + 0.2 * unit(f.adx14 / 40)
    + 0.2 * unit(f.volumeRatio / p.volume_ratio_max) + 0.15 * unit(1 - bodyAtr / p.max_confirmation_body_atr);
  return finish("BREAKOUT_RETEST_V1", side, f, axes, p.stop_atr, p.target_r, p.max_hold_bars, conditions, quality);
}

function unit(value: number): number { return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0; }
