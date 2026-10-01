// M6 (§33) — confidence calibration: bucketed isotonic-style mapping from
// AI raw confidence to realized win-rate. Risk Engine uses CALIBRATED value.
import type { Store } from "../memory/db.ts";
import { kvGet, kvSet } from "../memory/db.ts";

export interface CalibrationTable {
  updatedTs: string;
  sample: number;
  buckets: Array<{ lo: number; hi: number; winRate: number; n: number }>;
}

export function calibrate(store: Store, rawConfidence: number, minSample = 30): number {
  const raw = kvGet(store, "calibration");
  if (!raw) return rawConfidence;
  const table = JSON.parse(raw) as CalibrationTable;
  if (table.sample < minSample) return rawConfidence; // not enough evidence → identity map
  for (const b of table.buckets) {
    if (rawConfidence >= b.lo && rawConfidence < b.hi) {
      return b.n > 0 ? (rawConfidence + b.winRate) / 2 : rawConfidence; // shrink toward empirical
    }
  }
  return rawConfidence;
}

export function recomputeCalibration(store: Store): CalibrationTable | null {
  const rows = store.db.prepare(
    "SELECT calibrated_confidence AS c, result_r AS r FROM trades WHERE status='CLOSED' AND result_r IS NOT NULL AND calibrated_confidence IS NOT NULL",
  ).all() as Array<{ c: number; r: number }>;
  if (rows.length < 10) return null;
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
  kvSet(store, "calibration", JSON.stringify(table));
  return table;
}
