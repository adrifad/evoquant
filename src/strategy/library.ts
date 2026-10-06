// M2/M3 (§20/§50) — immutable strategy registry + deterministic scorers.
// Versions are never mutated (§20); challengers are INSERTED as new versions.
import type { FeatureSnapshot } from "../market/features.ts";
import type { Regime } from "../market/regime.ts";
import type { Store } from "../memory/db.ts";
import type { SignalWeights } from "../learning/signal-weights.ts";

export interface StrategyParams {
  adx_min: number;
  volume_ratio_min: number;
  rsi_min: number;
  rsi_max: number;
  stop_atr: number;
  take_profit_atr: number;
  // mean-reversion / breakout variants reuse fields with their own meaning
}

export interface StrategyDef {
  name: string;          // TREND_FOLLOWING | BREAKOUT | MEAN_REVERSION
  version: number;
  status: "CHAMPION" | "CHALLENGER" | "REJECTED" | "SUPERSEDED" | "TESTING";
  params: StrategyParams;
  allowed_regimes: Regime[];
}

export const BASE_STRATEGIES: StrategyDef[] = [
  {
    name: "TREND_FOLLOWING", version: 1, status: "CHAMPION",
    allowed_regimes: ["TRENDING_BULLISH", "TRENDING_BEARISH"],
    params: { adx_min: 22, volume_ratio_min: 1.10, rsi_min: 48, rsi_max: 68, stop_atr: 1.5, take_profit_atr: 3.0 },
  },
  {
    name: "BREAKOUT", version: 1, status: "CHAMPION",
    allowed_regimes: ["TRENDING_BULLISH", "TRENDING_BEARISH", "HIGH_VOLATILITY"],
    params: { adx_min: 20, volume_ratio_min: 1.30, rsi_min: 40, rsi_max: 75, stop_atr: 1.2, take_profit_atr: 2.5 },
  },
  {
    name: "MEAN_REVERSION", version: 1, status: "CHAMPION",
    allowed_regimes: ["SIDEWAYS"],
    params: { adx_min: 0, volume_ratio_min: 0.6, rsi_min: 25, rsi_max: 75, stop_atr: 1.8, take_profit_atr: 1.2 },
  },
];

// deterministic signal score in [-1, +1]: positive → LONG bias (§50 baseline)
export function scoreStrategy(s: StrategyDef, f: FeatureSnapshot, weights?: SignalWeights): number {
  if (!f.sufficientData) return 0;
  const longSide = f.emaSpreadPct > 0;
  const bias = longSide ? 1 : -1;
  if (s.name === "MEAN_REVERSION") {
    // fade extremes when RSI leaves the neutral band
    if (f.rsi14 > s.params.rsi_max) return -1;
    if (f.rsi14 < s.params.rsi_min) return 1;
    return 0;
  }
  let score = 0;
  const w = weights ?? { trend: 1, momentum: 1, volume: 1, volatility: 1 };
  if (f.adx14 >= s.params.adx_min) score += 0.5 * w.trend;
  if (f.volumeRatio >= s.params.volume_ratio_min) score += 0.3 * w.volume;
  const inBand = longSide ? f.rsi14 >= s.params.rsi_min && f.rsi14 <= s.params.rsi_max
    : f.rsi14 <= 100 - s.params.rsi_min && f.rsi14 >= 100 - s.params.rsi_max;
  if (inBand) score += 0.2 * w.momentum;
  return Math.max(-1, Math.min(1, score * bias));
}

export function loadStrategies(store: Store): StrategyDef[] {
  const rows = store.db
    .prepare("SELECT name, version, params, status FROM strategy_versions")
    .all() as Array<{ name: string; version: number; params: string; status: StrategyDef["status"] }>;
  if (rows.length === 0) {
    for (const s of BASE_STRATEGIES) saveStrategy(store, s);
    return BASE_STRATEGIES;
  }
  return rows.map((r) => {
    const base = BASE_STRATEGIES.find((b) => b.name === r.name);
    return { name: r.name, version: r.version, status: r.status, params: JSON.parse(r.params), allowed_regimes: base?.allowed_regimes ?? ["SIDEWAYS"] };
  });
}

export function saveStrategy(store: Store, s: StrategyDef, parent?: number, hypothesis?: string): void {
  store.db
    .prepare(
      `INSERT INTO strategy_versions(name,version,parent_version,params,status,created_ts,hypothesis)
       VALUES(?,?,?,?,?,?,?)
       ON CONFLICT(name,version) DO NOTHING`,
    )
    .run(s.name, s.version, parent ?? null, JSON.stringify(s.params), s.status, new Date().toISOString(), hypothesis ?? null);
}

export function setStrategyStatus(store: Store, name: string, version: number, status: StrategyDef["status"]): void {
  store.db.prepare("UPDATE strategy_versions SET status=? WHERE name=? AND version=?").run(status, name, version);
}
