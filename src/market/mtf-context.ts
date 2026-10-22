// Multi-timeframe context built only from source candles that had already
// closed at the decision timestamp. Aggregation never includes a partial
// bucket and never reads a future candle.
import type { Candle } from "../exchange/okx/types.ts";
import { buildFeatures } from "./features.ts";
import { classifyRegimeAxes, type RegimeAxes } from "./regime.ts";
import { detectMarketStructure, normalizeConfirmedCandles, type StructureDirection } from "./market-structure.ts";
import { assessStructuralRange, type StructuralRangeAssessment, type StructuralRangeOptions, type StructuralRangeState } from "./range-detector.ts";

export type MtfContextStatus = "ALIGNED" | "INSUFFICIENT_DATA" | "NO_CLOSED_HISTORY";

export interface MtfContext {
  instrument: string;
  sourceTimeframe: string;
  timeframe: string;
  status: MtfContextStatus;
  decisionTs: number;
  sourceCandlesUsed: number;
  higherTimeframeCandles: number;
  lastClosedAt: number | null;
  features: {
    price: number;
    atr14: number;
    atrPct: number;
    adx14: number;
    ema20: number;
    ema50: number;
    emaSpreadPct: number;
  } | null;
  regime: RegimeAxes | null;
  structureBias: StructureDirection | null;
  rangeState: StructuralRangeState | null;
  range: StructuralRangeAssessment | null;
  reason: string;
}

export interface MtfContextInput {
  instrument: string;
  sourceTimeframe: string;
  timeframe: string;
  candles: readonly Candle[];
  decisionTs: number;
  rangeOptions?: StructuralRangeOptions;
}

const TIMEFRAME_MS: Record<string, number> = {
  "1m": 60_000, "3m": 180_000, "5m": 300_000, "15m": 900_000, "30m": 1_800_000,
  "1H": 3_600_000, "2H": 7_200_000, "4H": 14_400_000, "6H": 21_600_000,
  "12H": 43_200_000, "1D": 86_400_000, "1W": 604_800_000,
};

export function timeframeMs(timeframe: string): number | null {
  return TIMEFRAME_MS[timeframe] ?? null;
}

/**
 * Aggregate fully formed buckets only. A missing source bar invalidates the
 * whole higher-timeframe bucket rather than producing a synthetic candle.
 */
export function aggregateConfirmedCandles(input: readonly Candle[], sourceTimeframe: string, targetTimeframe: string): Candle[] {
  const sourceMs = timeframeMs(sourceTimeframe);
  const targetMs = timeframeMs(targetTimeframe);
  if (sourceMs === null || targetMs === null || targetMs < sourceMs || targetMs % sourceMs !== 0) {
    throw new Error("target timeframe must be an integer multiple of the source timeframe");
  }
  const factor = targetMs / sourceMs;
  const byTs = new Map(normalizeConfirmedCandles(input).map((candle) => [candle.ts, candle]));
  const output: Candle[] = [];
  for (const [bucketStart, first] of byTs) {
    if (bucketStart % targetMs !== 0) continue;
    const bars: Candle[] = [];
    let complete = true;
    for (let index = 0; index < factor; index++) {
      const bar = byTs.get(bucketStart + index * sourceMs);
      if (!bar) { complete = false; break; }
      bars.push(bar);
    }
    if (!complete || bars.length !== factor) continue;
    output.push({
      ts: bucketStart,
      o: first.o,
      h: Math.max(...bars.map((bar) => bar.h)),
      l: Math.min(...bars.map((bar) => bar.l)),
      c: bars[bars.length - 1]!.c,
      vol: bars.reduce((sum, bar) => sum + bar.vol, 0),
      volCcy: bars.reduce((sum, bar) => sum + bar.volCcy, 0),
      confirm: "1",
    });
  }
  return output.sort((a, b) => a.ts - b.ts);
}

export function buildMtfContext(input: MtfContextInput): MtfContext {
  const sourceMs = timeframeMs(input.sourceTimeframe);
  const targetMs = timeframeMs(input.timeframe);
  const empty = (status: MtfContextStatus, reason: string, sourceCandlesUsed = 0): MtfContext => ({
    instrument: input.instrument, sourceTimeframe: input.sourceTimeframe, timeframe: input.timeframe,
    status, decisionTs: input.decisionTs, sourceCandlesUsed, higherTimeframeCandles: 0,
    lastClosedAt: null, features: null, regime: null, structureBias: null, rangeState: null, range: null, reason,
  });
  if (sourceMs === null || targetMs === null) return empty("INSUFFICIENT_DATA", "UNSUPPORTED_TIMEFRAME");
  if (!Number.isFinite(input.decisionTs)) return empty("INSUFFICIENT_DATA", "DECISION_TIMESTAMP_INVALID");

  const closedSource = normalizeConfirmedCandles(input.candles)
    .filter((candle) => candle.ts + sourceMs <= input.decisionTs);
  if (closedSource.length === 0) return empty("NO_CLOSED_HISTORY", "NO_SOURCE_CANDLE_CLOSED_BEFORE_DECISION");
  const higher = aggregateConfirmedCandles(closedSource, input.sourceTimeframe, input.timeframe);
  if (higher.length < 59) {
    return empty("INSUFFICIENT_DATA", "HIGHER_TIMEFRAME_HISTORY_INCOMPLETE", closedSource.length);
  }
  const features = buildFeatures(input.instrument, higher.slice().reverse());
  if (!features.sufficientData || !Number.isFinite(features.atr14) || features.atr14 <= 0) {
    return empty("INSUFFICIENT_DATA", "HIGHER_TIMEFRAME_FEATURES_UNAVAILABLE", closedSource.length);
  }
  const structure = detectMarketStructure(input.instrument, input.timeframe, higher);
  let range: StructuralRangeAssessment | null = null;
  try { range = assessStructuralRange(input.instrument, input.timeframe, higher, features.atr14, input.rangeOptions ?? {}); }
  catch { range = null; }
  return {
    instrument: input.instrument, sourceTimeframe: input.sourceTimeframe, timeframe: input.timeframe,
    status: "ALIGNED", decisionTs: input.decisionTs, sourceCandlesUsed: closedSource.length,
    higherTimeframeCandles: higher.length, lastClosedAt: higher[higher.length - 1]!.ts + targetMs,
    features: { price: features.price, atr14: features.atr14, atrPct: features.atrPct, adx14: features.adx14,
      ema20: features.ema20, ema50: features.ema50, emaSpreadPct: features.emaSpreadPct },
    regime: classifyRegimeAxes(features), structureBias: structure.bias,
    rangeState: range?.state ?? null, range, reason: "CLOSED_HIGHER_TIMEFRAME_CONTEXT",
  };
}

