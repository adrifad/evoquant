// M6 (§31) — signal weight evolution: bounded, evidence-driven, every N trades.
import type { Store } from "../memory/db.ts";
import { kvGet, kvSet, logSystemEvent } from "../memory/db.ts";
import type { TradingEngine } from "../memory/engines.ts";
import type { StrategyFamily } from "../strategy/identity.ts";

export interface SignalWeights {
  trend: number; momentum: number; volume: number; volatility: number;
}
export interface LearningScope {
  strategyCoreVersion?: 1 | 2; strategy?: StrategyFamily | "SCALP"; strategyVersion?: number;
  instrument?: string; regime?: string; side?: "LONG" | "SHORT";
}
export const INITIAL_WEIGHTS: SignalWeights = { trend: 1, momentum: 1, volume: 1, volatility: 1 };

function scopeKey(engine: TradingEngine, scope: LearningScope = {}): string {
  return `signal_weights:${engine}:core${scope.strategyCoreVersion ?? 1}:${scope.strategy ?? "*"}:${scope.strategyVersion ?? "*"}:${scope.instrument ?? "*"}:${scope.regime ?? "*"}:${scope.side ?? "*"}`;
}
function scopeArgs(scope: LearningScope = {}): Array<string | number | null> {
  return [scope.strategyCoreVersion ?? 1,
    scope.strategy ?? null, scope.strategy ?? null, scope.strategyVersion ?? null, scope.strategyVersion ?? null,
    scope.instrument ?? null, scope.instrument ?? null, scope.regime ?? null, scope.regime ?? null, scope.side ?? null, scope.side ?? null];
}

export function getWeights(store: Store, engine: TradingEngine = "SWING_15M", scope: LearningScope = {}): SignalWeights {
  const raw = kvGet(store, scopeKey(engine, scope));
  if (!raw) return { ...INITIAL_WEIGHTS };
  return JSON.parse(raw) as SignalWeights;
}

// contribution per signal group (from entry features vs outcome, §31/§32).
export function measureContributions(store: Store, engine: TradingEngine = "SWING_15M", scope: LearningScope = {}): Record<keyof SignalWeights, number> {
  const rows = store.db.prepare(`
    SELECT result_r, entry_features, entry_conditions, side FROM trades
    WHERE status='CLOSED' AND result_r IS NOT NULL AND result_r_basis='NET' AND engine=?
      AND strategy_core_version=?
      AND (? IS NULL OR strategy=?) AND (? IS NULL OR strategy_version=?)
      AND (? IS NULL OR instrument=?) AND (? IS NULL OR regime=?) AND (? IS NULL OR side=?)`).all(engine, ...scopeArgs(scope)) as
    Array<{ result_r: number; entry_features: string; entry_conditions: string | null; side: "LONG" | "SHORT" }>;
  const agg: Record<keyof SignalWeights, { sum: number; n: number }> = {
    trend: { sum: 0, n: 0 }, momentum: { sum: 0, n: 0 }, volume: { sum: 0, n: 0 }, volatility: { sum: 0, n: 0 },
  };
  for (const r of rows) {
    let f: Record<string, number>;
    try { f = JSON.parse(r.entry_features) as Record<string, number>; } catch { continue; }
    // Bounded R evidence preserves outcome magnitude without letting one tail trade dominate.
    const outcome = Math.tanh(r.result_r);
    const sideSign = r.side === "LONG" ? 1 : -1;
    const trend = clamp1((f.emaSpreadPct ?? 0) / 0.5) * sideSign;
    const mom = clamp1(((f.rsi14 ?? 50) - 50) / 25) * sideSign;
    const volu = clamp1(((f.volumeRatio ?? 1) - 1) / 0.5);
    const atrp = (f.atrPct ?? 0);
    const family = scope.strategy;
    const vola = family === "BREAKOUT" ? clamp01((atrp - 0.25) / 1.25)
      : 1 - clamp01((atrp - 0.25) / 1.25);
    const momentum = family === "MEAN_REVERSION" ? -mom : mom;
    const trendContribution = family === "MEAN_REVERSION" ? 0 : trend;
    // Breakout records are supported by range-break distance and candle expansion.
    let breakoutExpansion = 0;
    if (family === "BREAKOUT" && r.entry_conditions) {
      try {
        const conditions = JSON.parse(r.entry_conditions) as Array<{ name: string; value?: number; threshold?: number }>;
        const distance = conditions.find((entry) => entry.name === "breakout_distance_min");
        if (distance?.value !== undefined) breakoutExpansion = clamp01(distance.value / Math.max(distance.threshold ?? 0.1, 0.1));
      } catch { /* optional legacy snapshot */ }
    }
    agg.trend!.sum += outcome * trendContribution; agg.trend!.n += 1;
    agg.momentum!.sum += outcome * momentum; agg.momentum!.n += 1;
    agg.volume!.sum += outcome * volu; agg.volume!.n += 1;
    agg.volatility!.sum += outcome * (family === "BREAKOUT" ? Math.max(vola, breakoutExpansion) : vola); agg.volatility!.n += 1;
  }
  const out = {} as Record<keyof SignalWeights, number>;
  for (const k of Object.keys(agg) as Array<keyof SignalWeights>) out[k] = agg[k]!.n ? agg[k]!.sum / agg[k]!.n : 0;
  return out;
}

// §31: update only every N closed trades; ±10% max change per cycle; never below 0.5 / above 2.
export function maybeEvolveWeights(store: Store, interval: number, maxDeltaPct: number, engine: TradingEngine = "SWING_15M", minimumSample = 30, scope: LearningScope = {}): SignalWeights | null {
  const n = (store.db.prepare(`SELECT COUNT(*) c FROM trades WHERE status='CLOSED' AND result_r_basis='NET' AND engine=?
    AND strategy_core_version=?
    AND (? IS NULL OR strategy=?) AND (? IS NULL OR strategy_version=?)
    AND (? IS NULL OR instrument=?) AND (? IS NULL OR regime=?) AND (? IS NULL OR side=?)`).get(engine, ...scopeArgs(scope)) as { c: number }).c;
  const scopedKey = scopeKey(engine, scope);
  const key = `${scopedKey}:last_run`;
  const lastRun = Number(kvGet(store, key) ?? "0");
  if (n < Math.max(interval, minimumSample) || n - lastRun < interval) return null;
  const w = getWeights(store, engine, scope);
  const c = measureContributions(store, engine, scope);
  const next = { ...w };
  for (const k of Object.keys(next) as Array<keyof SignalWeights>) {
    const dir = Math.sign(c[k] ?? 0);
    const delta = dir * (maxDeltaPct / 100);
    next[k] = clampRange(w[k] + delta, 0.5, 2.0);
  }
  kvSet(store, scopedKey, JSON.stringify(next));
  kvSet(store, key, String(n));
  logSystemEvent(store, "WEIGHTS", { engine, scope, before: w, after: next, contributions: c, sample: n });
  return next;
}

function clamp1(n: number): number { return Math.max(-1, Math.min(1, n)); }
function clamp01(n: number): number { return Math.max(0, Math.min(1, n)); }
function clampRange(n: number, lo: number, hi: number): number { return Math.max(lo, Math.min(hi, Math.round(n * 100) / 100)); }
