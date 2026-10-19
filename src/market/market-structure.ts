import type { Candle } from "../exchange/okx/types.ts";

export type StructureDirection = "BULLISH" | "BEARISH" | "NEUTRAL";
export type StructurePivotKind = "SWING_HIGH" | "SWING_LOW";
export type StructureEventKind = "HH" | "HL" | "LH" | "LL" | "BREAK_OF_STRUCTURE" | "CHANGE_OF_CHARACTER";

export interface ConfirmedPivot {
  kind: StructurePivotKind;
  instrument: string;
  timeframe: string;
  ts: number;
  confirmedAt: number;
  price: number;
  sourceCandleIds: number[];
  confirmationState: "CONFIRMED";
  algorithmVersion: "structure-v1";
}

export interface StructureEvent {
  kind: StructureEventKind;
  instrument: string;
  timeframe: string;
  ts: number;
  confirmedAt: number;
  price: number;
  direction: "BULLISH" | "BEARISH";
  sourceCandleIds: number[];
  confirmationState: "CONFIRMED";
  algorithmVersion: "structure-v1";
}

export interface MarketStructureSnapshot {
  instrument: string;
  timeframe: string;
  evaluatedAt: number | null;
  pivots: ConfirmedPivot[];
  events: StructureEvent[];
  bias: StructureDirection;
  invalidationLevel: number | null;
  invalidated: boolean;
  algorithmVersion: "structure-v1";
}

export interface MarketStructureOptions { leftBars?: number; rightBars?: number }

/** Deterministic non-repainting structure from confirmed candles only. A pivot
 * becomes available at `confirmedAt`, after all configured right-side bars close.
 */
export function detectMarketStructure(instrument: string, timeframe: string, input: readonly Candle[], options: MarketStructureOptions = {}): MarketStructureSnapshot {
  const left = options.leftBars ?? 2;
  const right = options.rightBars ?? 2;
  if (!Number.isInteger(left) || left < 1 || !Number.isInteger(right) || right < 1) throw new Error("pivot confirmation bars must be positive integers");
  const candles = input.filter(isConfirmedValid).slice().sort((a, b) => a.ts - b.ts);
  const pivots: ConfirmedPivot[] = [];
  for (let i = left; i < candles.length - right; i++) {
    const window = candles.slice(i - left, i + right + 1);
    const current = candles[i]!;
    const highPivot = window.slice(0, left).every((bar) => current.h > bar.h)
      && window.slice(left + 1).every((bar) => current.h > bar.h);
    const lowPivot = window.slice(0, left).every((bar) => current.l < bar.l)
      && window.slice(left + 1).every((bar) => current.l < bar.l);
    const sourceCandleIds = window.map((bar) => bar.ts);
    if (highPivot) pivots.push(pivot("SWING_HIGH", instrument, timeframe, current, candles[i + right]!, sourceCandleIds, current.h));
    if (lowPivot) pivots.push(pivot("SWING_LOW", instrument, timeframe, current, candles[i + right]!, sourceCandleIds, current.l));
  }
  pivots.sort((a, b) => a.confirmedAt - b.confirmedAt || a.ts - b.ts || a.kind.localeCompare(b.kind));

  const events: StructureEvent[] = [];
  let previousHigh: ConfirmedPivot | undefined;
  let previousLow: ConfirmedPivot | undefined;
  for (const point of pivots) {
    if (point.kind === "SWING_HIGH") {
      if (previousHigh) events.push(event(point.price > previousHigh.price ? "HH" : "LH", instrument, timeframe, point,
        point.price > previousHigh.price ? "BULLISH" : "BEARISH", [previousHigh.ts, point.ts]));
      previousHigh = point;
    } else {
      if (previousLow) events.push(event(point.price > previousLow.price ? "HL" : "LL", instrument, timeframe, point,
        point.price > previousLow.price ? "BULLISH" : "BEARISH", [previousLow.ts, point.ts]));
      previousLow = point;
    }
  }

  const lastHigh = [...pivots].reverse().find((point) => point.kind === "SWING_HIGH");
  const lastLow = [...pivots].reverse().find((point) => point.kind === "SWING_LOW");
  const lastHighClassification = [...events].reverse().find((item) => item.kind === "HH" || item.kind === "LH")?.kind;
  const lastLowClassification = [...events].reverse().find((item) => item.kind === "HL" || item.kind === "LL")?.kind;
  const bias: StructureDirection = lastHighClassification === "HH" && lastLowClassification === "HL" ? "BULLISH"
    : lastHighClassification === "LH" && lastLowClassification === "LL" ? "BEARISH" : "NEUTRAL";

  let brokenLevel: ConfirmedPivot | undefined;
  let brokeAgainstBias = false;
  let priorClose: Candle | undefined;
  const pivotByTs = new Map(pivots.map((point) => [`${point.kind}:${point.ts}`, point]));
  for (const bar of candles) {
    if (priorClose) {
      for (const point of pivots) {
        if (bar.ts <= point.confirmedAt) continue;
        const crossed = point.kind === "SWING_HIGH" ? priorClose.c <= point.price && bar.c > point.price
          : priorClose.c >= point.price && bar.c < point.price;
        const key = `${point.kind}:${point.ts}`;
        if (!crossed || pivotByTs.get(key) !== point || events.some((item) => item.kind === "BREAK_OF_STRUCTURE" && item.sourceCandleIds[0] === point.ts)) continue;
        const direction = point.kind === "SWING_HIGH" ? "BULLISH" : "BEARISH";
        const kind = bias !== "NEUTRAL" && direction !== bias ? "CHANGE_OF_CHARACTER" : "BREAK_OF_STRUCTURE";
        events.push({ kind, instrument, timeframe, ts: bar.ts, confirmedAt: bar.ts, price: point.price, direction,
          sourceCandleIds: [point.ts, bar.ts], confirmationState: "CONFIRMED", algorithmVersion: "structure-v1" });
        brokenLevel = point;
        brokeAgainstBias = kind === "CHANGE_OF_CHARACTER";
      }
    }
    priorClose = bar;
  }
  events.sort((a, b) => a.confirmedAt - b.confirmedAt || a.ts - b.ts || a.kind.localeCompare(b.kind));
  return { instrument, timeframe, evaluatedAt: candles.at(-1)?.ts ?? null, pivots, events, bias,
    invalidationLevel: bias === "BULLISH" ? lastLow?.price ?? null : bias === "BEARISH" ? lastHigh?.price ?? null : brokenLevel?.price ?? null,
    invalidated: brokeAgainstBias, algorithmVersion: "structure-v1" };
}

function isConfirmedValid(candle: Candle): boolean {
  return candle.confirm === "1" && Number.isFinite(candle.ts) && [candle.o, candle.h, candle.l, candle.c, candle.vol].every(Number.isFinite)
    && candle.o > 0 && candle.h > 0 && candle.l > 0 && candle.c > 0 && candle.h >= Math.max(candle.o, candle.c)
    && candle.l <= Math.min(candle.o, candle.c) && candle.h >= candle.l;
}

function pivot(kind: StructurePivotKind, instrument: string, timeframe: string, source: Candle, confirmation: Candle,
  sourceCandleIds: number[], price: number): ConfirmedPivot {
  return { kind, instrument, timeframe, ts: source.ts, confirmedAt: confirmation.ts, price, sourceCandleIds,
    confirmationState: "CONFIRMED", algorithmVersion: "structure-v1" };
}

function event(kind: StructureEventKind, instrument: string, timeframe: string, point: ConfirmedPivot,
  direction: "BULLISH" | "BEARISH", sourceCandleIds: number[]): StructureEvent {
  return { kind, instrument, timeframe, ts: point.ts, confirmedAt: point.confirmedAt, price: point.price, direction,
    sourceCandleIds, confirmationState: "CONFIRMED", algorithmVersion: "structure-v1" };
}
