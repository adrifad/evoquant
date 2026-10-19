import type { Candle } from "../exchange/okx/types.ts";
import { buildFeatures } from "./features.ts";
import { classifyRegime } from "./regime.ts";
import { detectMarketStructure, normalizeConfirmedCandles } from "./market-structure.ts";
import { detectSupportResistance } from "./support-resistance.ts";
import { assessStructuralRange } from "./range-detector.ts";
import { describePriceAction } from "./price-action.ts";

export type MarketDataFreshnessStatus = "CURRENT" | "STALE" | "INSUFFICIENT_DATA" | "UNAVAILABLE";
export interface MarketDataFreshness {
  status: MarketDataFreshnessStatus;
  lastConfirmedCandleAt: number | null;
  evaluatedAt: number;
  ageMs: number | null;
  staleThresholdMs: number;
  dataSufficient: boolean;
  dataSource: "PERSISTED_CONFIRMED_CANDLES";
}

/** Read-only structural snapshot built exclusively from persisted confirmed candles. */
export function buildMarketIntelligence(instrument: string, timeframe: string, candles: readonly Candle[], now = Date.now()) {
  const confirmed = normalizeConfirmedCandles(candles);
  const freshness = marketDataFreshness(timeframe, confirmed, now);
  const features = buildFeatures(instrument, confirmed.slice().reverse());
  const structure = detectMarketStructure(instrument, timeframe, confirmed);
  const marketRegime = classifyRegime(features);
  if (!features.sufficientData || !Number.isFinite(features.atr14) || features.atr14 <= 0) {
    return { status: "INSUFFICIENT_CONFIRMED_DATA" as const, freshness, instrument, timeframe,
      candleCount: confirmed.length, evaluatedAt: confirmed.at(-1)?.ts ?? null, marketRegime,
      structure, supportResistance: null, range: null, priceAction: null };
  }
  const supportResistance = detectSupportResistance(instrument, timeframe, confirmed, features.atr14);
  const range = assessStructuralRange(instrument, timeframe, confirmed, features.atr14);
  const latest = confirmed.at(-1)!;
  const previous = confirmed.at(-2) ?? null;
  const prior = confirmed.slice(-21, -1);
  const priceAction = prior.length
    ? describePriceAction(latest, previous, { priorHigh: Math.max(...prior.map((candle) => candle.h)),
      priorLow: Math.min(...prior.map((candle) => candle.l)) })
    : null;
  return { status: "AVAILABLE" as const, freshness, instrument, timeframe, candleCount: confirmed.length,
    evaluatedAt: latest.ts, marketRegime, features: { price: features.price, atr14: features.atr14, atrPct: features.atrPct,
      adx14: features.adx14, ema20: features.ema20, ema50: features.ema50 }, structure, supportResistance, range, priceAction };
}

/** Candle timestamps are candle-open UTC milliseconds. A record is stale once
 * the following interval plus a 90s publication grace has elapsed.
 */
export function marketDataFreshness(timeframe: string, candles: readonly Candle[], now: number): MarketDataFreshness {
  const duration = timeframeMs(timeframe);
  const staleThresholdMs = duration + 90_000;
  const last = candles.at(-1)?.ts ?? null;
  const rawAgeMs = last === null ? null : now - last;
  const ageMs = rawAgeMs === null ? null : Math.max(0, rawAgeMs);
  const dataSufficient = candles.length >= 59;
  const status: MarketDataFreshnessStatus = last === null ? "UNAVAILABLE"
    : rawAgeMs === null || rawAgeMs < -90_000 || rawAgeMs > staleThresholdMs ? "STALE"
      : !dataSufficient ? "INSUFFICIENT_DATA" : "CURRENT";
  return { status, lastConfirmedCandleAt: last, evaluatedAt: now, ageMs,
    staleThresholdMs, dataSufficient, dataSource: "PERSISTED_CONFIRMED_CANDLES" };
}

function timeframeMs(timeframe: string): number {
  return ({ "1m": 60_000, "5m": 300_000, "15m": 900_000, "1H": 3_600_000 } as Record<string, number>)[timeframe] ?? 900_000;
}
