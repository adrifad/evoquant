// M5 (§32) — regime memory: performance per strategy×regime×direction.
import type { Store } from "./db.ts";
import type { TradingEngine } from "./engines.ts";

export interface CellStats {
  trades: number; wins: number; losses: number;
  win_rate: number; expectancy_r: number; profit_factor: number | null;
}

export interface ScopedPerformanceRow {
  engine: string; strategy: string; strategy_core_version: number; strategy_version: number; instrument: string;
  regime: string; regime_axes: string | null; side: "LONG" | "SHORT"; trades: number; wins: number; losses: number;
  win_rate: number; expectancy_r: number; profit_factor: number | null;
}

/** Version/engine/instrument/side-aware closed-trade statistics; result_r is net R. */
export function scopedPerformance(store: Store, scope: {
  engine?: TradingEngine; strategyCoreVersion?: 1 | 2; strategy?: string; strategyVersion?: number; instrument?: string; regime?: string; side?: "LONG" | "SHORT";
} = {}): ScopedPerformanceRow[] {
  return store.db.prepare(`SELECT engine,strategy,strategy_core_version,strategy_version,instrument,regime,regime_axes,side,
      COUNT(*) trades, SUM(CASE WHEN result_r>0 THEN 1 ELSE 0 END) wins,
      SUM(CASE WHEN result_r<0 THEN 1 ELSE 0 END) losses,
      AVG(CASE WHEN result_r>0 THEN 1.0 ELSE 0.0 END) win_rate, AVG(result_r) expectancy_r,
      CASE WHEN SUM(CASE WHEN result_r<0 THEN ABS(result_r) ELSE 0 END)>0
        THEN SUM(CASE WHEN result_r>0 THEN result_r ELSE 0 END)/SUM(CASE WHEN result_r<0 THEN ABS(result_r) ELSE 0 END)
        WHEN SUM(CASE WHEN result_r>0 THEN result_r ELSE 0 END)>0 THEN NULL ELSE 0 END profit_factor
    FROM trades WHERE status='CLOSED' AND result_r_basis='NET' AND result_r IS NOT NULL
      AND (? IS NULL OR engine=?) AND strategy_core_version=? AND (? IS NULL OR strategy=?) AND (? IS NULL OR strategy_version=?)
      AND (? IS NULL OR instrument=?) AND (? IS NULL OR regime=?) AND (? IS NULL OR side=?)
    GROUP BY engine,strategy,strategy_core_version,strategy_version,instrument,regime,regime_axes,side
    ORDER BY engine,strategy,strategy_core_version,strategy_version,instrument,regime,regime_axes,side`)
    .all(scope.engine ?? null, scope.engine ?? null, scope.strategyCoreVersion ?? 1, scope.strategy ?? null, scope.strategy ?? null,
      scope.strategyVersion ?? null, scope.strategyVersion ?? null, scope.instrument ?? null, scope.instrument ?? null,
      scope.regime ?? null, scope.regime ?? null, scope.side ?? null, scope.side ?? null) as ScopedPerformanceRow[];
}

export function regimeStats(store: Store, engine: TradingEngine = "SWING_15M", coreVersion: 1 | 2 = 1): Record<string, Record<string, Record<string, CellStats>>> {
  const rows = store.db.prepare(`
    SELECT strategy, strategy_core_version, strategy_version, regime, side, result_r FROM trades
    WHERE status='CLOSED' AND result_r_basis='NET' AND engine=? AND strategy_core_version=? AND regime IS NOT NULL AND result_r IS NOT NULL`).all(engine, coreVersion) as
    Array<{ strategy: string; strategy_core_version: number; strategy_version: number; regime: string; side: "LONG" | "SHORT"; result_r: number }>;
  const out: Record<string, Record<string, Record<string, CellStats>>> = {};
  for (const r of rows) {
    const s = (out[r.regime] ??= {});
    const strategyVersion = `${r.strategy}_C${r.strategy_core_version}_V${r.strategy_version}`;
    const d = (s[strategyVersion] ??= {});
    const c = (d[r.side] ??= { trades: 0, wins: 0, losses: 0, win_rate: 0, expectancy_r: 0, profit_factor: 0 });
    c.trades += 1;
    if (r.result_r > 0) { c.wins += 1; } else if (r.result_r < 0) { c.losses += 1; }
    c.expectancy_r += r.result_r;
  }
  for (const reg of Object.values(out)) for (const str of Object.values(reg)) for (const c of Object.values(str)) {
    const sum = c.expectancy_r;
    c.expectancy_r = c.trades ? round2(sum / c.trades) : 0;
    c.win_rate = c.trades ? round2(c.wins / c.trades) : 0;
  }
  return out;
}

function round2(n: number): number { return Math.round(n * 100) / 100; }

export function getRegimeStatsBrief(store: Store, regime: string, engine: TradingEngine = "SWING_15M", coreVersion: 1 | 2 = 1): Record<string, { win_rate: number; expectancy_r: number; trades: number }> {
  const str = regimeStats(store, engine, coreVersion)[regime];
  if (!str) return {};
  const brief: Record<string, { win_rate: number; expectancy_r: number; trades: number }> = {};
  for (const [s, dirs] of Object.entries(str)) {
    let trades = 0, wins = 0, sumR = 0;
    for (const c of Object.values(dirs)) { trades += c.trades; wins += c.wins; sumR += c.expectancy_r * c.trades; }
    brief[s] = { trades, win_rate: trades ? round2(wins / trades) : 0, expectancy_r: trades ? round2(sumR / trades) : 0 };
  }
  return brief;
}
