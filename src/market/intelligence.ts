import type { Candle } from "../exchange/okx/types.ts";
import { buildFeatures } from "./features.ts";
import { classifyRegime } from "./regime.ts";
import { detectMarketStructure } from "./market-structure.ts";
import { detectSupportResistance } from "./support-resistance.ts";
import { assessStructuralRange } from "./range-detector.ts";
import { describePriceAction } from "./price-action.ts";

/** Read-only structural snapshot built exclusively from persisted confirmed candles. */
export function buildMarketIntelligence(instrument: string, timeframe: string, candles: readonly Candle[]) {
  const confirmed = candles.filter((candle) => candle.confirm === "1").slice().sort((a, b) => a.ts - b.ts);
  const features = buildFeatures(instrument, confirmed.slice().reverse());
  const structure = detectMarketStructure(instrument, timeframe, confirmed);
  const marketRegime = classifyRegime(features);
  if (!features.sufficientData || !Number.isFinite(features.atr14) || features.atr14 <= 0) {
    return { status: "INSUFFICIENT_CONFIRMED_DATA" as const, instrument, timeframe,
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
  return { status: "AVAILABLE" as const, instrument, timeframe, candleCount: confirmed.length,
    evaluatedAt: latest.ts, marketRegime, features: { price: features.price, atr14: features.atr14, atrPct: features.atrPct,
      adx14: features.adx14, ema20: features.ema20, ema50: features.ema50 }, structure, supportResistance, range, priceAction };
}
