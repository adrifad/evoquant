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
  algorithmVersion: "structure-v2";
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
  algorithmVersion: "structure-v2";
  sourcePivotTs: number;
  sourcePivotConfirmedAt: number;
  breakConfirmedAt?: number;
  biasBeforeBreak?: StructureDirection;
  biasAfterBreak?: StructureDirection;
  brokenLevel?: number;
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
  algorithmVersion: "structure-v2";
}

export interface MarketStructureOptions { leftBars?: number; rightBars?: number }

/**
 * Normalize confirmed candles into a timestamp-unique chronological history.
 * Conflicting duplicates are discarded rather than letting input order choose
 * market structure. This is shared by derived market-intelligence modules.
 */
export function normalizeConfirmedCandles(input: readonly Candle[]): Candle[] {
  const grouped = new Map<number, Candle[]>();
  for (const candle of input) {
    if (!isConfirmedValid(candle)) continue;
    const values = grouped.get(candle.ts) ?? [];
    values.push(candle);
    grouped.set(candle.ts, values);
  }
  const result: Candle[] = [];
  for (const [ts, values] of [...grouped].sort(([a], [b]) => a - b)) {
    const first = values[0]!;
    if (values.every((bar) => sameCandle(first, bar))) result.push(first);
    // A timestamp with conflicting confirmed records is not safe evidence.
  }
  return result;
}

/**
 * Incremental, non-repainting structure from confirmed candles only. Pivots
 * enter the state only at their right-bar confirmation timestamp. BOS/CHOCH
 * are classified from the bias known at the break close, never final history.
 */
export function detectMarketStructure(instrument: string, timeframe: string, input: readonly Candle[], options: MarketStructureOptions = {}): MarketStructureSnapshot {
  const left = options.leftBars ?? 2;
  const right = options.rightBars ?? 2;
  if (!Number.isInteger(left) || left < 1 || !Number.isInteger(right) || right < 1) throw new Error("pivot confirmation bars must be positive integers");
  const candles = normalizeConfirmedCandles(input);
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

  const pivotsByConfirmation = new Map<number, ConfirmedPivot[]>();
  for (const point of pivots) {
    const atTime = pivotsByConfirmation.get(point.confirmedAt) ?? [];
    atTime.push(point);
    pivotsByConfirmation.set(point.confirmedAt, atTime);
  }
  const events: StructureEvent[] = [];
  const brokenPivots = new Set<string>();
  let previousHigh: ConfirmedPivot | undefined;
  let previousLow: ConfirmedPivot | undefined;
  let highTrend: "HH" | "LH" | undefined;
  let lowTrend: "HL" | "LL" | undefined;
  let bias: StructureDirection = "NEUTRAL";
  let brokenLevel: ConfirmedPivot | undefined;
  let invalidated = false;
  let prior: Candle | undefined;

  for (const bar of candles) {
    // A pivot confirmed on this candle becomes available before this close is
    // evaluated; it cannot be used on any earlier candle.
    for (const point of pivotsByConfirmation.get(bar.ts) ?? []) {
      if (point.kind === "SWING_HIGH") {
        if (previousHigh) {
          highTrend = point.price > previousHigh.price ? "HH" : "LH";
          events.push(pivotEvent(highTrend, instrument, timeframe, point, highTrend === "HH" ? "BULLISH" : "BEARISH",
            [previousHigh.ts, point.ts]));
        }
        previousHigh = point;
      } else {
        if (previousLow) {
          lowTrend = point.price > previousLow.price ? "HL" : "LL";
          events.push(pivotEvent(lowTrend, instrument, timeframe, point, lowTrend === "HL" ? "BULLISH" : "BEARISH",
            [previousLow.ts, point.ts]));
        }
        previousLow = point;
      }
      bias = deriveBias(highTrend, lowTrend, bias);
    }

    if (prior) {
      // Only pivots confirmed before this close are breakable evidence.
      for (const point of pivots) {
        const key = `${point.kind}:${point.ts}`;
        if (point.confirmedAt >= bar.ts || brokenPivots.has(key)) continue;
        const crossed = point.kind === "SWING_HIGH" ? prior.c <= point.price && bar.c > point.price
          : prior.c >= point.price && bar.c < point.price;
        if (!crossed) continue;
        const direction = point.kind === "SWING_HIGH" ? "BULLISH" : "BEARISH";
        const before = bias;
        const kind: StructureEventKind = before !== "NEUTRAL" && direction !== before ? "CHANGE_OF_CHARACTER" : "BREAK_OF_STRUCTURE";
        const after: StructureDirection = kind === "CHANGE_OF_CHARACTER" ? direction : before;
        events.push({ kind, instrument, timeframe, ts: bar.ts, confirmedAt: bar.ts, price: point.price, direction,
          sourceCandleIds: [point.ts, bar.ts], confirmationState: "CONFIRMED", algorithmVersion: "structure-v2",
          sourcePivotTs: point.ts, sourcePivotConfirmedAt: point.confirmedAt, breakConfirmedAt: bar.ts,
          biasBeforeBreak: before, biasAfterBreak: after, brokenLevel: point.price });
        brokenPivots.add(key);
        brokenLevel = point;
        invalidated = kind === "CHANGE_OF_CHARACTER";
        if (kind === "CHANGE_OF_CHARACTER") {
          bias = after;
        }
      }
    }
    prior = bar;
  }

  events.sort((a, b) => a.confirmedAt - b.confirmedAt || a.ts - b.ts || a.kind.localeCompare(b.kind)
    || a.sourcePivotTs - b.sourcePivotTs);
  const lastHigh = [...pivots].reverse().find((point) => point.kind === "SWING_HIGH");
  const lastLow = [...pivots].reverse().find((point) => point.kind === "SWING_LOW");
  return { instrument, timeframe, evaluatedAt: candles.at(-1)?.ts ?? null, pivots, events, bias,
    invalidationLevel: bias === "BULLISH" ? lastLow?.price ?? brokenLevel?.price ?? null
      : bias === "BEARISH" ? lastHigh?.price ?? brokenLevel?.price ?? null : brokenLevel?.price ?? null,
    invalidated, algorithmVersion: "structure-v2" };
}

function deriveBias(high: "HH" | "LH" | undefined, low: "HL" | "LL" | undefined, current: StructureDirection): StructureDirection {
  if (high === "HH" && low === "HL") return "BULLISH";
  if (high === "LH" && low === "LL") return "BEARISH";
  return current;
}

function isConfirmedValid(candle: Candle): boolean {
  return candle.confirm === "1" && Number.isFinite(candle.ts) && [candle.o, candle.h, candle.l, candle.c, candle.vol].every(Number.isFinite)
    && candle.o > 0 && candle.h > 0 && candle.l > 0 && candle.c > 0 && candle.h >= Math.max(candle.o, candle.c)
    && candle.l <= Math.min(candle.o, candle.c) && candle.h >= candle.l;
}

function sameCandle(a: Candle, b: Candle): boolean {
  return a.o === b.o && a.h === b.h && a.l === b.l && a.c === b.c && a.vol === b.vol && a.volCcy === b.volCcy;
}

function pivot(kind: StructurePivotKind, instrument: string, timeframe: string, source: Candle, confirmation: Candle,
  sourceCandleIds: number[], price: number): ConfirmedPivot {
  return { kind, instrument, timeframe, ts: source.ts, confirmedAt: confirmation.ts, price, sourceCandleIds,
    confirmationState: "CONFIRMED", algorithmVersion: "structure-v2" };
}

function pivotEvent(kind: "HH" | "HL" | "LH" | "LL", instrument: string, timeframe: string, point: ConfirmedPivot,
  direction: "BULLISH" | "BEARISH", sourceCandleIds: number[]): StructureEvent {
  return { kind, instrument, timeframe, ts: point.ts, confirmedAt: point.confirmedAt, price: point.price, direction,
    sourceCandleIds, confirmationState: "CONFIRMED", algorithmVersion: "structure-v2", sourcePivotTs: point.ts,
    sourcePivotConfirmedAt: point.confirmedAt };
}
