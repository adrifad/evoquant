// M6 (§33) — confidence calibration: bucketed isotonic-style mapping from
// AI raw confidence to realized win-rate. Risk Engine uses CALIBRATED value.
import type { Store } from "../memory/db.ts";
import { kvGet, kvSet } from "../memory/db.ts";
import type { TradingEngine } from "../memory/engines.ts";
import type { LearningScope } from "./signal-weights.ts";

export interface CalibrationTable {
  updatedTs: string;
  sample: number;
  buckets: Array<{ lo: number; hi: number; winRate: number; n: number }>;
}

function calibrationKey(engine: TradingEngine, scope: LearningScope = {}): string {
  return `calibration:${engine}:${scope.strategy ?? "*"}:${scope.strategyVersion ?? "*"}:${scope.instrument ?? "*"}:${scope.regime ?? "*"}:${scope.side ?? "*"}`;
}
function scopeArgs(scope: LearningScope = {}): Array<string | number | null> {
  return [scope.strategy ?? null, scope.strategy ?? null, scope.strategyVersion ?? null, scope.strategyVersion ?? null,
    scope.instrument ?? null, scope.instrument ?? null, scope.regime ?? null, scope.regime ?? null, scope.side ?? null, scope.side ?? null];
}

export function calibrate(store: Store, rawConfidence: number, minSample = 30, engine: TradingEngine = "SWING_15M", scope: LearningScope = {}): number {
  const raw = kvGet(store, calibrationKey(engine, scope)) ??
    (engine === "SWING_15M" && Object.keys(scope).length === 0 ? kvGet(store, "calibration:SWING_15M") ?? kvGet(store, "calibration") : null);
  if (!raw) return rawConfidence;
  const table = JSON.parse(raw) as CalibrationTable;
  if (table.sample < minSample) return rawConfidence; // not enough evidence → identity map
  for (const b of table.buckets) {
    if (rawConfidence >= b.lo && (rawConfidence < b.hi || (b.hi === 1 && rawConfidence === 1))) {
      return b.n >= 5 ? (rawConfidence + b.winRate) / 2 : rawConfidence; // identity for thin buckets
    }
  }
  return rawConfidence;
}

export function recomputeCalibration(store: Store, engine: TradingEngine = "SWING_15M", scope: LearningScope = {}): CalibrationTable | null {
  const rows = store.db.prepare(
    `SELECT raw_confidence AS c, result_r AS r FROM trades WHERE status='CLOSED' AND result_r_basis='NET' AND engine=? AND result_r IS NOT NULL AND raw_confidence IS NOT NULL
      AND (? IS NULL OR strategy=?) AND (? IS NULL OR strategy_version=?)
      AND (? IS NULL OR instrument=?) AND (? IS NULL OR regime=?) AND (? IS NULL OR side=?)`,
  ).all(engine, ...scopeArgs(scope)) as Array<{ c: number; r: number }>;
  if (rows.length < 30) return null;
  const edges = [0, 0.5, 0.6, 0.7, 0.8, 0.9, 1.01];
  const buckets = [];
  for (let i = 0; i < edges.length - 1; i++) {
    const lo = edges[i]!, hi = edges[i + 1]!;
    const inB = rows.filter((x) => x.c >= lo && x.c < hi);
    buckets.push({
      lo, hi: Math.min(hi, 1),
      winRate: inB.length ? inB.filter((x) => x.r > 0).length / inB.length : 0,
      n: inB.length,
    });
  }
  const table: CalibrationTable = { updatedTs: new Date().toISOString(), sample: rows.length, buckets };
  kvSet(store, calibrationKey(engine, scope), JSON.stringify(table));
  return table;
}
