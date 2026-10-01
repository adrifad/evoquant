// M2 — deterministic market regime classifier (§19).
// Baseline rules (spec §19): ADX high + EMA20>EMA50 → TRENDING_BULLISH, etc.
// Regimes may later evolve independently, but output enum is FIXED (§21 rule:
// no arbitrary strings).

import type { FeatureSnapshot } from "./features.ts";

export type Regime =
  | "TRENDING_BULLISH"
  | "TRENDING_BEARISH"
  | "SIDEWAYS"
  | "HIGH_VOLATILITY"
  | "LOW_VOLATILITY"
  | "UNKNOWN";

export const REGIMES: readonly Regime[] = [
  "TRENDING_BULLISH", "TRENDING_BEARISH", "SIDEWAYS", "HIGH_VOLATILITY", "LOW_VOLATILITY", "UNKNOWN",
];

export interface RegimeParams {
  adxTrendMin: number;    // default 25
  emaSpreadSidewaysMax: number; // % ; default 0.15
  atrPctHighVol: number;  // % ; default 1.5
  atrPctLowVol: number;   // % ; default 0.25
}

export const DEFAULT_REGIME_PARAMS: RegimeParams = {
  adxTrendMin: 25,
  emaSpreadSidewaysMax: 0.15,
  atrPctHighVol: 1.5,
  atrPctLowVol: 0.25,
};

export function classifyRegime(f: FeatureSnapshot, p: RegimeParams = DEFAULT_REGIME_PARAMS): Regime {
  if (!f.sufficientData || Number.isNaN(f.adx14) || Number.isNaN(f.emaSpreadPct) || Number.isNaN(f.atrPct)) {
    return "UNKNOWN"; // §50: UNKNOWN → HOLD downstream
  }
  if (f.atrPct >= p.atrPctHighVol) return "HIGH_VOLATILITY";
  const trending = f.adx14 >= p.adxTrendMin;
  if (trending && f.emaSpreadPct > 0) return "TRENDING_BULLISH";
  if (trending && f.emaSpreadPct < 0) return "TRENDING_BEARISH";
  if (Math.abs(f.emaSpreadPct) <= p.emaSpreadSidewaysMax) return "SIDEWAYS";
  if (f.atrPct <= p.atrPctLowVol) return "LOW_VOLATILITY";
  return "SIDEWAYS";
}

// §50 strategy-preference baseline (deterministic; AI reasons around it)
export function preferredDirections(regime: Regime): Array<"LONG" | "SHORT"> {
  switch (regime) {
    case "TRENDING_BULLISH": return ["LONG"];
    case "TRENDING_BEARISH": return ["SHORT"];
    case "SIDEWAYS": return ["LONG", "SHORT"];
    case "HIGH_VOLATILITY": return ["LONG", "SHORT"];
    default: return [];
  }
}
