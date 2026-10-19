import type { Candle } from "../exchange/okx/types.ts";
import { detectSupportResistance, type PriceZone } from "./support-resistance.ts";
import { detectMarketStructure } from "./market-structure.ts";

export type StructuralRangeState = "RANGE_CONFIRMED" | "RANGE_CANDIDATE" | "TRENDING" | "TRANSITION" | "UNKNOWN";

export interface StructuralRangeOptions {
  lookbackBars?: number;
  minDurationBars?: number;
  minBoundaryTouches?: number;
  toleranceAtr?: number;
  minWidthAtr?: number;
  maxWidthAtr?: number;
  pivotLeftBars?: number;
  pivotRightBars?: number;
  minimumNetWidthPct?: number;
}

export interface StructuralRangeAssessment {
  state: StructuralRangeState;
  instrument: string;
  timeframe: string;
  evaluatedAt: number | null;
  low: number | null;
  high: number | null;
  widthAtr: number | null;
  widthPct: number | null;
  positionInRange: number | null;
  support: PriceZone | null;
  resistance: PriceZone | null;
  breakoutDirection: "UP" | "DOWN" | null;
  reason: string;
  algorithmVersion: "range-v1";
}

/** Structural range classifier. It describes context only and does not create
 * entry signals; boundaries must have time-separated confirmed pivot touches.
 */
export function assessStructuralRange(instrument: string, timeframe: string, input: readonly Candle[], atr: number,
  options: StructuralRangeOptions = {}): StructuralRangeAssessment {
  const p = { lookbackBars: 80, minDurationBars: 20, minBoundaryTouches: 2, toleranceAtr: 0.25,
    minWidthAtr: 3, maxWidthAtr: 12, pivotLeftBars: 2, pivotRightBars: 2, minimumNetWidthPct: 0, ...options };
  if (!Number.isFinite(atr) || atr <= 0 || !Number.isInteger(p.lookbackBars) || p.lookbackBars < 10
    || !Number.isInteger(p.minDurationBars) || p.minDurationBars < 1 || !Number.isInteger(p.minBoundaryTouches) || p.minBoundaryTouches < 2
    || ![p.toleranceAtr, p.minWidthAtr, p.maxWidthAtr, p.minimumNetWidthPct].every(Number.isFinite)
    || p.toleranceAtr <= 0 || p.minWidthAtr < 0 || p.maxWidthAtr <= p.minWidthAtr || p.minimumNetWidthPct < 0) {
    throw new Error("invalid structural range inputs");
  }
  const candles = input.filter((c) => c.confirm === "1" && validCandle(c)).slice().sort((a, b) => a.ts - b.ts).slice(-p.lookbackBars);
  const empty = (state: StructuralRangeState, reason: string): StructuralRangeAssessment => ({ state, instrument, timeframe,
    evaluatedAt: candles.at(-1)?.ts ?? null, low: null, high: null, widthAtr: null, widthPct: null,
    positionInRange: null, support: null, resistance: null, breakoutDirection: null, reason, algorithmVersion: "range-v1" });
  if (candles.length < Math.max(p.minDurationBars + 1, p.pivotLeftBars + p.pivotRightBars + 3)) return empty("UNKNOWN", "insufficient_confirmed_history");
  const zones = detectSupportResistance(instrument, timeframe, candles, atr, { lookbackBars: p.lookbackBars,
    toleranceAtr: p.toleranceAtr, minTouchSeparationBars: Math.max(2, p.pivotLeftBars + p.pivotRightBars),
    leftBars: p.pivotLeftBars, rightBars: p.pivotRightBars });
  const price = candles.at(-1)!.c;
  const brokenResistance = zones.resistance.filter((zone) => price > zone.high + atr * p.toleranceAtr)
    .sort((a, b) => b.center - a.center)[0] ?? null;
  const brokenSupport = zones.support.filter((zone) => price < zone.low - atr * p.toleranceAtr)
    .sort((a, b) => a.center - b.center)[0] ?? null;
  const breakout: "UP" | "DOWN" | null = brokenResistance ? "UP" : brokenSupport ? "DOWN" : null;
  const support = zones.support.filter((zone) => !zone.broken && zone.center < price).sort((a, b) => b.center - a.center)[0] ?? null;
  const resistance = zones.resistance.filter((zone) => !zone.broken && zone.center > price).sort((a, b) => a.center - b.center)[0] ?? null;
  const width = support && resistance ? resistance.center - support.center : NaN;
  const widthAtr = width / atr;
  const widthPct = width / price * 100;
  const structure = detectMarketStructure(instrument, timeframe, candles, { leftBars: p.pivotLeftBars, rightBars: p.pivotRightBars });
  const highTouches = resistance?.touches ?? 0, lowTouches = support?.touches ?? 0;
  const barIndex = new Map(candles.map((bar, index) => [bar.ts, index]));
  const firstBoundaryIndex = support && resistance
    ? Math.max(barIndex.get(support.firstTouchedAt) ?? candles.length, barIndex.get(resistance.firstTouchedAt) ?? candles.length) : candles.length;
  const duration = candles.length - 1 - firstBoundaryIndex;
  if (breakout) return { ...empty("TRANSITION", "confirmed_boundary_breakout"), support, resistance,
    low: (support ?? brokenSupport)?.low ?? null, high: (resistance ?? brokenResistance)?.high ?? null,
    widthAtr: finiteOrNull(widthAtr), widthPct: finiteOrNull(widthPct), breakoutDirection: breakout };
  const boundariesExist = Boolean(support && resistance);
  const durationOk = duration >= p.minDurationBars;
  const touchesOk = highTouches >= p.minBoundaryTouches && lowTouches >= p.minBoundaryTouches;
  const widthOk = Number.isFinite(widthAtr) && widthAtr >= p.minWidthAtr && widthAtr <= p.maxWidthAtr
    && widthPct >= p.minimumNetWidthPct;
  const stable = boundariesExist && !support!.broken && !resistance!.broken;
  const enoughRangeEvidence = boundariesExist && touchesOk && durationOk && widthOk && stable;
  const state: StructuralRangeState = enoughRangeEvidence ? "RANGE_CONFIRMED"
    : structure.bias !== "NEUTRAL" && !boundariesExist ? "TRENDING"
      : boundariesExist || structure.bias !== "NEUTRAL" ? "RANGE_CANDIDATE" : "UNKNOWN";
  const reason = enoughRangeEvidence ? "confirmed_distinct_boundaries"
    : !boundariesExist ? "two_confirmed_boundaries_unavailable"
      : !touchesOk ? "insufficient_distinct_boundary_touches"
        : !durationOk ? "range_duration_too_short" : !widthOk ? "range_width_outside_bounds" : "range_not_stable";
  return { state, instrument, timeframe, evaluatedAt: candles.at(-1)?.ts ?? null,
    low: support?.low ?? null, high: resistance?.high ?? null, widthAtr: finiteOrNull(widthAtr), widthPct: finiteOrNull(widthPct),
    positionInRange: support && resistance && resistance.center > support.center
      ? clamp((price - support.center) / (resistance.center - support.center), 0, 1) : null,
    support, resistance, breakoutDirection: null, reason, algorithmVersion: "range-v1" };
}

function validCandle(c: Candle): boolean { return [c.ts, c.o, c.h, c.l, c.c].every(Number.isFinite) && c.o > 0 && c.h >= Math.max(c.o, c.c) && c.l <= Math.min(c.o, c.c); }
function finiteOrNull(value: number): number | null { return Number.isFinite(value) ? value : null; }
function clamp(value: number, min: number, max: number): number { return Math.max(min, Math.min(max, value)); }
