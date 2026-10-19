import type { Candle } from "../exchange/okx/types.ts";

export interface PriceActionSnapshot {
  confirmed: boolean;
  body: number | null;
  range: number | null;
  upperWickToBody: number | null;
  lowerWickToBody: number | null;
  bodyStrength: number | null;
  rejection: "BULLISH" | "BEARISH" | "NONE" | "UNKNOWN";
  engulfing: "BULLISH" | "BEARISH" | "NONE" | "UNKNOWN";
  breakout: "UP" | "DOWN" | "NONE" | "UNKNOWN";
  falseBreakout: "UP" | "DOWN" | "NONE" | "UNKNOWN";
  /** Descriptive feature only; this module never authorizes a trade. */
  entrySignal: false;
  algorithmVersion: "price-action-v1";
}

export interface PriceActionReference { priorHigh: number; priorLow: number; rejectionWickToBody?: number }

export function describePriceAction(current: Candle, previous: Candle | null, reference: PriceActionReference): PriceActionSnapshot {
  if (!isConfirmed(current) || (previous && !isConfirmed(previous)) || !Number.isFinite(reference.priorHigh)
    || !Number.isFinite(reference.priorLow) || reference.priorHigh <= reference.priorLow) return unknown();
  const range = current.h - current.l;
  if (!(range > 0)) return unknown();
  const body = Math.abs(current.c - current.o);
  const denominator = Math.max(body, Number.EPSILON);
  const upper = current.h - Math.max(current.o, current.c);
  const lower = Math.min(current.o, current.c) - current.l;
  const threshold = reference.rejectionWickToBody ?? 2;
  const closePosition = (current.c - current.l) / range;
  const rejection = lower / denominator >= threshold && closePosition >= 0.65 ? "BULLISH"
    : upper / denominator >= threshold && closePosition <= 0.35 ? "BEARISH" : "NONE";
  const engulfing = previous && previous.c < previous.o && current.c > current.o && current.o <= previous.c && current.c >= previous.o ? "BULLISH"
    : previous && previous.c > previous.o && current.c < current.o && current.o >= previous.c && current.c <= previous.o ? "BEARISH" : "NONE";
  const breakout = current.c > reference.priorHigh ? "UP" : current.c < reference.priorLow ? "DOWN" : "NONE";
  const falseBreakout = current.h > reference.priorHigh && current.c <= reference.priorHigh ? "UP"
    : current.l < reference.priorLow && current.c >= reference.priorLow ? "DOWN" : "NONE";
  return { confirmed: true, body, range, upperWickToBody: upper / denominator, lowerWickToBody: lower / denominator,
    bodyStrength: body / range, rejection, engulfing, breakout, falseBreakout, entrySignal: false, algorithmVersion: "price-action-v1" };
}

export type RetestState = "WAITING" | "CONFIRMED" | "FAILED" | "EXPIRED" | "UNKNOWN";

/** Evaluate only the supplied, already-closed post-breakout bars. Callers can
 * invoke this incrementally at each candle close to avoid future leakage.
 */
export function assessBreakoutRetest(input: { candles: readonly Candle[]; breakoutIndex: number; side: "LONG" | "SHORT";
  level: number; atr: number; maxRetestBars: number; toleranceAtr: number; lostLevelToleranceAtr: number }): RetestState {
  const { candles, breakoutIndex, side, level, atr, maxRetestBars, toleranceAtr, lostLevelToleranceAtr } = input;
  if (!Number.isInteger(breakoutIndex) || breakoutIndex < 0 || breakoutIndex >= candles.length || !Number.isFinite(level)
    || !Number.isFinite(atr) || atr <= 0 || !Number.isInteger(maxRetestBars) || maxRetestBars < 1
    || !Number.isFinite(toleranceAtr) || toleranceAtr <= 0 || !Number.isFinite(lostLevelToleranceAtr) || lostLevelToleranceAtr < 0) return "UNKNOWN";
  const bars = candles.slice(breakoutIndex + 1);
  if (bars.some((bar) => !isConfirmed(bar))) return "UNKNOWN";
  if (bars.length === 0) return "WAITING";
  if (bars.length > maxRetestBars) return "EXPIRED";
  let touched = false;
  for (const bar of bars) {
    const lost = side === "LONG" ? bar.c < level - lostLevelToleranceAtr * atr : bar.c > level + lostLevelToleranceAtr * atr;
    if (lost) return "FAILED";
    const retested = side === "LONG" ? bar.l <= level + toleranceAtr * atr : bar.h >= level - toleranceAtr * atr;
    touched ||= retested;
    const continuation = side === "LONG" ? bar.c > level && bar.c > bar.o : bar.c < level && bar.c < bar.o;
    if (touched && continuation) return "CONFIRMED";
  }
  return bars.length === maxRetestBars ? "EXPIRED" : "WAITING";
}

export function isPullbackConfirmation(current: Candle, previous: Candle, side: "LONG" | "SHORT"): boolean {
  if (!isConfirmed(current) || !isConfirmed(previous)) return false;
  return side === "LONG" ? current.c > previous.h && current.c > current.o
    : current.c < previous.l && current.c < current.o;
}

function unknown(): PriceActionSnapshot {
  return { confirmed: false, body: null, range: null, upperWickToBody: null, lowerWickToBody: null, bodyStrength: null,
    rejection: "UNKNOWN", engulfing: "UNKNOWN", breakout: "UNKNOWN", falseBreakout: "UNKNOWN", entrySignal: false,
    algorithmVersion: "price-action-v1" };
}
function isConfirmed(candle: Candle): boolean {
  return candle.confirm === "1" && Number.isFinite(candle.ts) && [candle.o, candle.h, candle.l, candle.c].every(Number.isFinite)
    && candle.o > 0 && candle.h >= Math.max(candle.o, candle.c) && candle.l <= Math.min(candle.o, candle.c) && candle.h > candle.l;
}
