// Regime-aware overlay for the existing research strategies. This does not add
// a new strategy family: it only requires higher-timeframe context that was
// already closed at the decision timestamp before a research candidate exists.
import type { Candle } from "../exchange/okx/types.ts";
import type { FeatureSnapshot } from "../market/features.ts";
import type { MtfContext } from "../market/mtf-context.ts";
import {
  DEFAULT_BREAKOUT_RETEST_V1, DEFAULT_RANGE_MEAN_REVERSION_V1, DEFAULT_TREND_PULLBACK_V1,
  evaluateBreakoutRetestV1, evaluateRangeMeanReversionV1, evaluateTrendPullbackV1,
  type ResearchCandidate, type ResearchEvaluation, type ResearchStrategyConfig, type ResearchStrategyId,
} from "./research-v1.ts";

export interface RegimeAwareResearchEvaluation extends ResearchEvaluation {
  mtf: {
    status: MtfContext["status"];
    timeframe: string;
    trend: string | null;
    structureBias: string | null;
    rangeState: string | null;
  };
}

function condition(name: string, passed: boolean, value?: number, threshold?: number): ResearchCandidate["conditions"][number] {
  return { name, passed, ...(typeof value === "number" && Number.isFinite(value) ? { value } : {}),
    ...(typeof threshold === "number" && Number.isFinite(threshold) ? { threshold } : {}) };
}

function withCandidate(base: ResearchEvaluation, conditions: ResearchCandidate["conditions"],
  context: MtfContext): RegimeAwareResearchEvaluation {
  const mtf = { status: context.status, timeframe: context.timeframe,
    trend: context.regime?.trend ?? null, structureBias: context.structureBias,
    rangeState: context.rangeState };
  const allPassed = conditions.every((item) => item.passed);
  const candidate = base.candidate && allPassed ? {
    ...base.candidate, conditions: [...base.candidate.conditions, ...conditions],
  } : null;
  return { ...base, candidate, mtf };
}

export function evaluateRegimeAwareResearchV1(
  strategy: ResearchStrategyId, features: FeatureSnapshot, candles: Candle[], context: MtfContext,
  roundTripCostPct: number,
  params: ResearchStrategyConfig = { trend_pullback_v1: DEFAULT_TREND_PULLBACK_V1,
    breakout_retest_v1: DEFAULT_BREAKOUT_RETEST_V1, range_mean_reversion_v1: DEFAULT_RANGE_MEAN_REVERSION_V1 },
): RegimeAwareResearchEvaluation {
  const base = strategy === "TREND_PULLBACK_V1" ? evaluateTrendPullbackV1(features, candles, params.trend_pullback_v1)
    : strategy === "BREAKOUT_RETEST_V1" ? evaluateBreakoutRetestV1(features, candles, params.breakout_retest_v1)
      : evaluateRangeMeanReversionV1(features, candles, roundTripCostPct, params.range_mean_reversion_v1);
  if (context.status !== "ALIGNED" || !context.regime) {
    return withCandidate(base, [condition("htf_context_available", false)], context);
  }
  if (context.lastClosedAt !== null && context.lastClosedAt > context.decisionTs) {
    return withCandidate(base, [condition("htf_no_future_leakage", false)], context);
  }
  if (strategy === "MEAN_REVERSION_RANGE_V1") {
    const rangeConfirmed = context.rangeState === "RANGE_CONFIRMED";
    return withCandidate(base, [
      condition("htf_context_available", true),
      condition("htf_range_context", rangeConfirmed),
      condition("htf_not_trending", context.rangeState !== "TRENDING"),
    ], context);
  }
  const side = base.candidate?.side;
  if (!side) return withCandidate(base, [condition("htf_context_available", true),
    condition("htf_alignment_evaluable", false)], context);
  const expected = side === "LONG" ? "BULL_TREND" : "BEAR_TREND";
  const adverse = side === "LONG" ? "BEARISH" : "BULLISH";
  return withCandidate(base, [
    condition("htf_context_available", true),
    condition("htf_trend_alignment", context.regime.trend === expected),
    condition("htf_structure_alignment", context.structureBias !== adverse),
  ], context);
}
