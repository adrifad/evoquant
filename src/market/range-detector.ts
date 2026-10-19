import type { Candle } from "../exchange/okx/types.ts";
import { detectSupportResistance, type PriceZone } from "./support-resistance.ts";
import { detectMarketStructure, normalizeConfirmedCandles } from "./market-structure.ts";

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
  transitionBars?: number;
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
  algorithmVersion: "range-v2";
}

/** Structural range classifier. It describes context only and does not create
 * entry signals; boundaries must have time-separated confirmed pivot touches.
 */
export function assessStructuralRange(instrument: string, timeframe: string, input: readonly Candle[], atr: number,
  options: StructuralRangeOptions = {}): StructuralRangeAssessment {
  const p = { lookbackBars: 80, minDurationBars: 20, minBoundaryTouches: 2, toleranceAtr: 0.25,
    minWidthAtr: 3, maxWidthAtr: 12, pivotLeftBars: 2, pivotRightBars: 2, minimumNetWidthPct: 0,
    transitionBars: 3, ...options };
  if (!Number.isFinite(atr) || atr <= 0 || !Number.isInteger(p.lookbackBars) || p.lookbackBars < 10
    || !Number.isInteger(p.minDurationBars) || p.minDurationBars < 1 || !Number.isInteger(p.minBoundaryTouches) || p.minBoundaryTouches < 2
    || !Number.isInteger(p.transitionBars) || p.transitionBars < 1 || p.transitionBars > 10
    || ![p.toleranceAtr, p.minWidthAtr, p.maxWidthAtr, p.minimumNetWidthPct].every(Number.isFinite)
    || p.toleranceAtr <= 0 || p.minWidthAtr < 0 || p.maxWidthAtr <= p.minWidthAtr || p.minimumNetWidthPct < 0) {
    throw new Error("invalid structural range inputs");
  }
  const candles = normalizeConfirmedCandles(input).filter(validCandle).slice(-p.lookbackBars);
  const empty = (state: StructuralRangeState, reason: string): StructuralRangeAssessment => ({ state, instrument, timeframe,
    evaluatedAt: candles.at(-1)?.ts ?? null, low: null, high: null, widthAtr: null, widthPct: null,
    positionInRange: null, support: null, resistance: null, breakoutDirection: null, reason, algorithmVersion: "range-v2" });
  if (candles.length < Math.max(p.minDurationBars + 1, p.pivotLeftBars + p.pivotRightBars + 3)) return empty("UNKNOWN", "insufficient_confirmed_history");
  const zones = detectSupportResistance(instrument, timeframe, candles, atr, { lookbackBars: p.lookbackBars,
    toleranceAtr: p.toleranceAtr, minTouchSeparationBars: Math.max(2, p.pivotLeftBars + p.pivotRightBars),
    leftBars: p.pivotLeftBars, rightBars: p.pivotRightBars });
  const price = candles.at(-1)!.c;
  // Pair boundaries into a range before checking for a breach. A historical
  // broken zone is not an active range boundary unless it belongs to the
  // selected, independently confirmed pair.
  const pairs = zones.support.flatMap((candidateSupport) => zones.resistance.flatMap((candidateResistance) => {
    const width = candidateResistance.center - candidateSupport.center;
    const widthAtr = width / atr;
    if (!(width > 0) || widthAtr < p.minWidthAtr || widthAtr > p.maxWidthAtr
      || candidateSupport.touches < p.minBoundaryTouches || candidateResistance.touches < p.minBoundaryTouches
      || candidateSupport.lastConfirmedAt > candles.at(-1)!.ts || candidateResistance.lastConfirmedAt > candles.at(-1)!.ts) return [];
    const supportIndex = barIndexFor(candles, candidateSupport.firstTouchedAt);
    const resistanceIndex = barIndexFor(candles, candidateResistance.firstTouchedAt);
    const firstBoundaryIndex = Math.max(supportIndex, resistanceIndex);
    const duration = candles.length - 1 - firstBoundaryIndex;
    if (duration < p.minDurationBars) return [];
    const evidence = Math.min(candidateSupport.touches, candidateResistance.touches);
    const mostRecentReaction = Math.min(candidateSupport.lastConfirmedAt, candidateResistance.lastConfirmedAt);
    return [{ support: candidateSupport, resistance: candidateResistance, widthAtr, widthPct: width / price * 100,
      duration, evidence, mostRecentReaction }];
  }));
  pairs.sort((a, b) => b.mostRecentReaction - a.mostRecentReaction || b.evidence - a.evidence
    || b.duration - a.duration || a.widthAtr - b.widthAtr || a.support.center - b.support.center);
  const active = pairs[0] ?? null;
  const support = active?.support ?? null;
  const resistance = active?.resistance ?? null;
  const formationAt = active ? Math.max(support!.lastConfirmedAt, resistance!.lastConfirmedAt) : null;
  const formationIndex = formationAt === null ? -1 : candles.findIndex((bar) => bar.ts >= formationAt);
  let lastBoundaryBreak: { direction: "UP" | "DOWN"; index: number } | null = null;
  if (active && formationIndex >= 0) {
    // A pivot can become confirmed at this candle's close. Process that close
    // with the newly available boundary only after the historical prefix is
    // complete; no later candle participates in this decision.
    for (let i = Math.max(1, formationIndex); i < candles.length; i++) {
      const bar = candles[i]!;
      const previous = candles[i - 1]!;
      const upper = bar.c > resistance!.high + atr * p.toleranceAtr;
      const lower = bar.c < support!.low - atr * p.toleranceAtr;
      if (lastBoundaryBreak) {
        const returnedInside = bar.c <= resistance!.high + atr * p.toleranceAtr
          && bar.c >= support!.low - atr * p.toleranceAtr;
        if (returnedInside) lastBoundaryBreak = null;
      }
      if (!lastBoundaryBreak && upper && previous.c <= resistance!.high + atr * p.toleranceAtr)
        lastBoundaryBreak = { direction: "UP", index: i };
      else if (!lastBoundaryBreak && lower && previous.c >= support!.low - atr * p.toleranceAtr)
        lastBoundaryBreak = { direction: "DOWN", index: i };
    }
  }
  const breakout = lastBoundaryBreak && candles.length - 1 - lastBoundaryBreak.index < p.transitionBars
    ? lastBoundaryBreak.direction : null;
  const agedBreakout = lastBoundaryBreak && !breakout ? lastBoundaryBreak.direction : null;
  const width = support && resistance ? resistance.center - support.center : NaN;
  const widthAtr = active?.widthAtr ?? width / atr;
  const widthPct = active?.widthPct ?? width / price * 100;
  const structure = detectMarketStructure(instrument, timeframe, candles, { leftBars: p.pivotLeftBars, rightBars: p.pivotRightBars });
  const highTouches = resistance?.touches ?? 0, lowTouches = support?.touches ?? 0;
  const duration = active?.duration ?? -1;
  if (breakout) return { ...empty("TRANSITION", "confirmed_boundary_breakout"), support, resistance,
    low: support?.low ?? null, high: resistance?.high ?? null,
    widthAtr: finiteOrNull(widthAtr), widthPct: finiteOrNull(widthPct), breakoutDirection: breakout };
  const boundariesExist = Boolean(support && resistance);
  const durationOk = duration >= p.minDurationBars;
  const touchesOk = highTouches >= p.minBoundaryTouches && lowTouches >= p.minBoundaryTouches;
  const widthOk = Number.isFinite(widthAtr) && widthAtr >= p.minWidthAtr && widthAtr <= p.maxWidthAtr
    && widthPct >= p.minimumNetWidthPct;
  const stable = boundariesExist;
  const enoughRangeEvidence = boundariesExist && touchesOk && durationOk && widthOk && stable;
  const state: StructuralRangeState = agedBreakout ? "TRENDING" : enoughRangeEvidence ? "RANGE_CONFIRMED"
    : structure.bias !== "NEUTRAL" && !boundariesExist ? "TRENDING"
      : boundariesExist || structure.bias !== "NEUTRAL" ? "RANGE_CANDIDATE" : "UNKNOWN";
  const reason = agedBreakout ? "active_range_boundary_break_aged_into_trend"
    : enoughRangeEvidence ? "confirmed_distinct_boundaries"
    : !boundariesExist ? "two_confirmed_boundaries_unavailable"
      : !touchesOk ? "insufficient_distinct_boundary_touches"
        : !durationOk ? "range_duration_too_short" : !widthOk ? "range_width_outside_bounds" : "range_not_stable";
  return { state, instrument, timeframe, evaluatedAt: candles.at(-1)?.ts ?? null,
    low: support?.low ?? null, high: resistance?.high ?? null, widthAtr: finiteOrNull(widthAtr), widthPct: finiteOrNull(widthPct),
    positionInRange: support && resistance && resistance.center > support.center
      ? clamp((price - support.center) / (resistance.center - support.center), 0, 1) : null,
    support, resistance, breakoutDirection: agedBreakout, reason, algorithmVersion: "range-v2" };
}

function validCandle(c: Candle): boolean { return [c.ts, c.o, c.h, c.l, c.c].every(Number.isFinite) && c.o > 0 && c.h >= Math.max(c.o, c.c) && c.l <= Math.min(c.o, c.c); }
function barIndexFor(candles: readonly Candle[], ts: number): number { return candles.findIndex((bar) => bar.ts === ts); }
function finiteOrNull(value: number): number | null { return Number.isFinite(value) ? value : null; }
function clamp(value: number, min: number, max: number): number { return Math.max(min, Math.min(max, value)); }
