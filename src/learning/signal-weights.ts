// M6 (§31) — signal weight evolution: bounded, evidence-driven, every N trades.
import type { Store } from "../memory/db.ts";
import { kvGet, kvSet, logSystemEvent } from "../memory/db.ts";

export interface SignalWeights {
  trend: number; momentum: number; volume: number; volatility: number;
}
export const INITIAL_WEIGHTS: SignalWeights = { trend: 1, momentum: 1, volume: 1, volatility: 1 };

export function getWeights(store: Store): SignalWeights {
  const raw = kvGet(store, "signal_weights");
  if (!raw) return { ...INITIAL_WEIGHTS };
  return JSON.parse(raw) as SignalWeights;
}

// contribution per signal group (from entry features vs outcome, §31/§32).
export function measureContributions(store: Store): Record<keyof SignalWeights, number> {
  const rows = store.db.prepare(`
    SELECT result_r, entry_features FROM trades WHERE status='CLOSED' AND result_r IS NOT NULL`).all() as
    Array<{ result_r: number; entry_features: string }>;
  const agg: Record<keyof SignalWeights, { sum: number; n: number }> = {
    trend: { sum: 0, n: 0 }, momentum: { sum: 0, n: 0 }, volume: { sum: 0, n: 0 }, volatility: { sum: 0, n: 0 },
  };
  for (const r of rows) {
    let f: Record<string, number>;
    try { f = JSON.parse(r.entry_features) as Record<string, number>; } catch { continue; }
    const win = r.result_r > 0 ? 1 : -1;
    const trend = clamp1((f.emaSpreadPct ?? 0) / 0.5);           // ±0.5% maps to ±1
    const mom = clamp1(((f.rsi14 ?? 50) - 50) / 25);
    const volu = clamp1(((f.volumeRatio ?? 1) - 1) / 0.5);
    const atrp = (f.atrPct ?? 0);
    const vola = 1 - clamp01((atrp - 0.25) / 1.25); // low vol favorable for entries
    agg.trend!.sum += win * trend; agg.trend!.n += 1;
    agg.momentum!.sum += win * mom; agg.momentum!.n += 1;
    agg.volume!.sum += win * volu; agg.volume!.n += 1;
    agg.volatility!.sum += win * vola; agg.volatility!.n += 1;
  }
  const out = {} as Record<keyof SignalWeights, number>;
  for (const k of Object.keys(agg) as Array<keyof SignalWeights>) out[k] = agg[k]!.n ? agg[k]!.sum / agg[k]!.n : 0;
  return out;
}

// §31: update only every N closed trades; ±10% max change per cycle; never below 0.5 / above 2.
export function maybeEvolveWeights(store: Store, interval: number, maxDeltaPct: number): SignalWeights | null {
  const n = (store.db.prepare("SELECT COUNT(*) c FROM trades WHERE status='CLOSED'").get() as { c: number }).c;
  const lastRun = Number(kvGet(store, "weights_last_run") ?? "0");
  if (n === 0 || n - lastRun < interval || n < interval) return null;
  const w = getWeights(store);
  const c = measureContributions(store);
  const next = { ...w };
  for (const k of Object.keys(next) as Array<keyof SignalWeights>) {
    const dir = Math.sign(c[k] ?? 0);
    const delta = dir * (maxDeltaPct / 100);
    next[k] = clampRange(w[k] + delta, 0.5, 2.0);
  }
  kvSet(store, "signal_weights", JSON.stringify(next));
  kvSet(store, "weights_last_run", String(n));
  logSystemEvent(store, "WEIGHTS", { before: w, after: next, contributions: c, trades: n });
  return next;
}

function clamp1(n: number): number { return Math.max(-1, Math.min(1, n)); }
function clamp01(n: number): number { return Math.max(0, Math.min(1, n)); }
function clampRange(n: number, lo: number, hi: number): number { return Math.max(lo, Math.min(hi, Math.round(n * 100) / 100)); }
