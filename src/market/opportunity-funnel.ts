import type { Store } from "../memory/db.ts";

export type OpportunityEngine = "SWING_15M" | "SCALP_5M";

export interface CandidateAttempt {
  cycleId: string;
  engine: OpportunityEngine;
  rank: number;
  instrument: string;
  strategy: string;
  setupScore: number;
  gateResult?: string | null;
  riskResult?: string | null;
  finalResult: string;
  reason?: string | null;
  createdAt?: string;
}

/** Compact hourly counter. Dimensions are bounded domain labels, never raw model text. */
export function recordOpportunityMetric(store: Store, engine: OpportunityEngine, metric: string, dimension = "", at = new Date()): void {
  const bucket = new Date(Math.floor(at.getTime() / 3_600_000) * 3_600_000).toISOString();
  const safeMetric = metric.slice(0, 64);
  const safeDimension = dimension.slice(0, 120);
  store.db.prepare(`INSERT INTO opportunity_funnel_hourly(bucket_start,engine,metric,dimension,count)
    VALUES(?,?,?,?,1) ON CONFLICT(bucket_start,engine,metric,dimension)
    DO UPDATE SET count=opportunity_funnel_hourly.count+1`)
    .run(bucket, engine, safeMetric, safeDimension);
}

export function recordCandidateAttempt(store: Store, attempt: CandidateAttempt): void {
  store.db.prepare(`INSERT INTO opportunity_candidate_attempts(
      cycle_id,engine,candidate_rank,instrument,strategy,setup_score,gate_result,risk_result,final_result,reason,created_at
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(cycle_id,engine,candidate_rank) DO UPDATE SET
      gate_result=excluded.gate_result,risk_result=excluded.risk_result,
      final_result=excluded.final_result,reason=excluded.reason`)
    .run(attempt.cycleId, attempt.engine, attempt.rank, attempt.instrument, attempt.strategy,
      attempt.setupScore, attempt.gateResult ?? null, attempt.riskResult ?? null,
      attempt.finalResult, attempt.reason?.slice(0, 160) ?? null, attempt.createdAt ?? new Date().toISOString());
}

export interface FunnelBucket {
  bucketStart: string;
  engine: OpportunityEngine;
  metric: string;
  dimension: string;
  count: number;
}

export function getOpportunityFunnel(store: Store, windowHours: 24 | 168, now = new Date()): {
  windowHours: number;
  generatedAt: string;
  engines: Record<OpportunityEngine, { totals: Record<string, number>; blockers: Array<{ strategy: string; condition: string; count: number }>; hourly: FunnelBucket[] }>;
  confidenceBelowMinimum: { count: number; totalGateAllow: number; pct: number | null };
} {
  const since = new Date(now.getTime() - windowHours * 3_600_000).toISOString();
  const rows = store.db.prepare(`SELECT bucket_start,engine,metric,dimension,count
    FROM opportunity_funnel_hourly WHERE bucket_start>=? ORDER BY bucket_start,engine,metric,dimension`)
    .all(since) as Array<{ bucket_start: string; engine: OpportunityEngine; metric: string; dimension: string; count: number }>;
  const engines = Object.fromEntries(((["SWING_15M", "SCALP_5M"] as const).map(engine => {
    const selected = rows.filter(row => row.engine === engine);
    const totals: Record<string, number> = {};
    for (const row of selected) if (row.metric !== "HARD_CONDITION_FAILED") totals[row.metric] = (totals[row.metric] ?? 0) + row.count;
    const blockers = selected.filter(row => row.metric === "HARD_CONDITION_FAILED").map(row => {
      const [strategy, condition] = row.dimension.split(":", 2);
      return { strategy: strategy ?? "UNKNOWN", condition: condition ?? "UNKNOWN", count: row.count };
    }).sort((a, b) => b.count - a.count);
    return [engine, { totals, blockers, hourly: selected.map(row => ({ bucketStart: row.bucket_start,
      engine: row.engine, metric: row.metric, dimension: row.dimension, count: row.count })) }];
  }))) as Record<OpportunityEngine, { totals: Record<string, number>; blockers: Array<{ strategy: string; condition: string; count: number }>; hourly: FunnelBucket[] }>;
  const below = engines.SWING_15M.totals.CONFIDENCE_BELOW_MIN ?? 0;
  const gateAllow = engines.SWING_15M.totals.GATE_ALLOW ?? 0;
  return { windowHours, generatedAt: now.toISOString(), engines,
    confidenceBelowMinimum: { count: below, totalGateAllow: gateAllow,
      pct: gateAllow ? Math.round(below / gateAllow * 10_000) / 100 : null } };
}

/** Small operational trace, newest cycles first; no provider prompt/output is stored. */
export function getRecentCandidateAttempts(store: Store, limit = 100): Array<Record<string, unknown>> {
  return store.db.prepare(`SELECT cycle_id,engine,candidate_rank,instrument,strategy,setup_score,
      gate_result,risk_result,final_result,reason,created_at
    FROM opportunity_candidate_attempts ORDER BY created_at DESC,candidate_rank ASC LIMIT ?`).all(Math.max(1, Math.min(500, limit))) as Array<Record<string, unknown>>;
}

export function pruneOpportunityTelemetry(store: Store, now = new Date()): void {
  const cutoff = new Date(now.getTime() - 30 * 86_400_000).toISOString();
  store.db.prepare("DELETE FROM opportunity_funnel_hourly WHERE bucket_start<?").run(cutoff);
  store.db.prepare("DELETE FROM opportunity_candidate_attempts WHERE created_at<?").run(cutoff);
}
