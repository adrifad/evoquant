// M5 (§32) — regime memory: performance per strategy×regime×direction.
import type { Store } from "./db.ts";

export interface CellStats {
  trades: number; wins: number; losses: number;
  win_rate: number; expectancy_r: number; profit_factor: number;
}

export function regimeStats(store: Store): Record<string, Record<string, Record<string, CellStats>>> {
  const rows = store.db.prepare(`
    SELECT strategy, regime, side, result_r FROM trades
    WHERE status='CLOSED' AND regime IS NOT NULL AND result_r IS NOT NULL`).all() as
    Array<{ strategy: string; regime: string; side: "LONG" | "SHORT"; result_r: number }>;
  const out: Record<string, Record<string, Record<string, CellStats>>> = {};
  for (const r of rows) {
    const s = (out[r.regime] ??= {});
    const d = (s[r.strategy] ??= {});
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

export function getRegimeStatsBrief(store: Store, regime: string): Record<string, { win_rate: number; expectancy_r: number; trades: number }> {
  const str = regimeStats(store)[regime];
  if (!str) return {};
  const brief: Record<string, { win_rate: number; expectancy_r: number; trades: number }> = {};
  for (const [s, dirs] of Object.entries(str)) {
    let trades = 0, wins = 0, sumR = 0;
    for (const c of Object.values(dirs)) { trades += c.trades; wins += c.wins; sumR += c.expectancy_r * c.trades; }
    brief[s] = { trades, win_rate: trades ? round2(wins / trades) : 0, expectancy_r: trades ? round2(sumR / trades) : 0 };
  }
  return brief;
}
