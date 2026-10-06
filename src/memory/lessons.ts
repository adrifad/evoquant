// M4/M5 (§28–§30) — lessons memory + evidence-based validation.
// AI review = hypothesis; this module only MOVES status on statistics (§53).
import type { Store } from "./db.ts";
import type { TradingEngine } from "./engines.ts";

export type LessonStatus = "PROVISIONAL" | "REINFORCED" | "VERIFIED" | "CONFLICTED" | "SUPERSEDED" | "REJECTED";

export interface LessonRow {
  lesson_id: string; statement: string; status: LessonStatus;
  scope_strategy: string | null; scope_instrument: string | null; scope_regime: string | null;
  scope_engine: TradingEngine | null; scope_strategy_version: number | null; scope_direction: string | null; scope_regime_axes: string | null;
  confidence: number | null; observations: number | null; wins: number | null;
  losses: number | null; expectancy_r: number | null;
  created_ts: string | null; updated_ts: string | null; first_evidence_ts: string | null;
}

let seq = 0;
export function upsertLesson(
  store: Store,
  l: { statement: string; scope: { engine?: TradingEngine; strategy?: string; strategyVersion?: number; instrument?: string; regime?: string; direction?: string; regimeAxes?: string }; confidence: number },
): string {
  const existing = store.db.prepare(
    `SELECT lesson_id FROM lessons WHERE statement=? AND scope_engine=?
     AND COALESCE(scope_strategy,'')=? AND COALESCE(scope_strategy_version,0)=?
     AND COALESCE(scope_instrument,'')=? AND COALESCE(scope_regime,'')=? AND COALESCE(scope_direction,'')=? AND COALESCE(scope_regime_axes,'')=?`,
  ).get(l.statement, l.scope.engine ?? "SWING_15M", l.scope.strategy ?? "", l.scope.strategyVersion ?? 0,
    l.scope.instrument ?? "", l.scope.regime ?? "", l.scope.direction ?? "", l.scope.regimeAxes ?? "") as { lesson_id: string } | undefined;
  if (existing) {
    store.db.prepare("UPDATE lessons SET confidence=MAX(confidence,?), updated_ts=? WHERE lesson_id=?")
      .run(l.confidence, new Date().toISOString(), existing.lesson_id);
    return existing.lesson_id;
  }
  seq += 1;
  const id = `LESSON-${Date.now().toString(36)}${seq}`;
  store.db.prepare(`INSERT INTO lessons(lesson_id,statement,status,scope_engine,scope_strategy,scope_strategy_version,scope_instrument,scope_regime,scope_direction,scope_regime_axes,confidence,created_ts,updated_ts)
    VALUES(?,?,'PROVISIONAL',?,?,?,?,?,?,?,?,?,?)`).run(
    id, l.statement, l.scope.engine ?? "SWING_15M", l.scope.strategy ?? null, l.scope.strategyVersion ?? null,
    l.scope.instrument ?? null, l.scope.regime ?? null, l.scope.direction ?? null, l.scope.regimeAxes ?? null,
    l.confidence, new Date().toISOString(), new Date().toISOString());
  return id;
}

export function addLessonEvidence(
  store: Store, lessonId: string, tradeId: string, aligned: boolean,
): void {
  store.db.prepare(
    `INSERT OR IGNORE INTO lesson_evidence(lesson_id,trade_id,aligned,ts)
     SELECT l.lesson_id,t.trade_id,?,? FROM lessons l JOIN trades t ON t.trade_id=?
     WHERE l.lesson_id=? AND l.scope_engine=t.engine
       AND (l.scope_strategy IS NULL OR l.scope_strategy=t.strategy)
       AND (l.scope_strategy_version IS NULL OR l.scope_strategy_version=t.strategy_version)
       AND (l.scope_instrument IS NULL OR l.scope_instrument=t.instrument)
       AND (l.scope_regime IS NULL OR l.scope_regime=t.regime)
       AND (l.scope_direction IS NULL OR l.scope_direction=t.side)
       AND (l.scope_regime_axes IS NULL OR l.scope_regime_axes=t.regime_axes)`,
  ).run(aligned ? 1 : 0, new Date().toISOString(), tradeId, lessonId);
  recomputeLesson(store, lessonId);
}

// §30 — transitions from evidence only:
// PROVISIONAL → (≥10 obs, expectancy same sign) → REINFORCED →
// REINFORCED → (≥30 obs AND ≥20% out-of-sample agree) → VERIFIED
// contradictions ≥40% → CONFLICTED
export function recomputeLesson(store: Store, lessonId: string): void {
  const ev = store.db.prepare(
    "SELECT aligned, COUNT(*) n FROM lesson_evidence WHERE lesson_id=? GROUP BY aligned",
  ).all(lessonId) as Array<{ aligned: number; n: number }>;
  const total = ev.reduce((a, b) => a + b.n, 0);
  const agree = ev.find((e) => e.aligned === 1)?.n ?? 0;
  const stats = store.db.prepare(`
    SELECT COALESCE(SUM(CASE WHEN l.aligned=1 THEN t.result_r ELSE 0 END),0) AS agree_r,
           COALESCE(SUM(CASE WHEN l.aligned=1 THEN 1 ELSE 0 END),0) AS agree_n,
           COUNT(*) AS n
    FROM lesson_evidence l JOIN trades t ON t.trade_id=l.trade_id
    WHERE l.lesson_id=? AND t.status='CLOSED' AND t.result_r_basis='NET'`).get(lessonId) as { agree_r: number; agree_n: number; n: number };
  const expectAgree = stats.agree_n ? stats.agree_r / stats.agree_n : 0;
  const agreeRate = total ? agree / total : 0;
  const conflictRate = total ? 1 - agreeRate : 0;
  let status: LessonStatus = "PROVISIONAL";
  if (total === 0) status = "PROVISIONAL";
  else if (conflictRate >= 0.4) status = "CONFLICTED";
  else if (total >= 30 && agreeRate >= 0.65) status = "VERIFIED";
  else if (total >= 10 && agreeRate >= 0.6) status = "REINFORCED";
  const confidence = Math.round(agreeRate * Math.min(1, total / 30) * 100) / 100;
  store.db.prepare(`UPDATE lessons SET status=?, confidence=?, observations=?, wins=?, losses=?,
    expectancy_r=?, updated_ts=?, first_evidence_ts=COALESCE(first_evidence_ts,?)
    WHERE lesson_id=?`).run(
    status, confidence, total, agree, total - agree,
    Math.round(expectAgree * 100) / 100, new Date().toISOString(), new Date().toISOString(), lessonId);
}

export function getActiveLessons(store: Store, instrument: string, engine: TradingEngine = "SWING_15M"): Array<Record<string, unknown>> {
  return store.db.prepare(
    `SELECT lesson_id, statement, status, scope_engine, scope_strategy, scope_strategy_version, scope_regime, scope_regime_axes, scope_direction, confidence, observations, expectancy_r
     FROM lessons WHERE status IN ('REINFORCED','VERIFIED') AND scope_engine=?
       AND (scope_instrument IS NULL OR scope_instrument=?) ORDER BY confidence DESC LIMIT 20`,
  ).all(engine, instrument) as Array<Record<string, unknown>>;
}

// trades whose features SUPPORT a lesson's implied filter (for evidence attach)
export function tradesMatchingScope(store: Store, scope: { engine?: TradingEngine; strategy?: string; strategyVersion?: number; instrument?: string; regime?: string; direction?: string; regimeAxes?: string }, limit = 50): Array<Record<string, unknown>> {
  const rows = store.db.prepare(
    `SELECT trade_id, result_r, entry_features FROM trades WHERE status='CLOSED' AND result_r_basis='NET'
     AND engine=? AND (? IS NULL OR strategy=?) AND (? IS NULL OR strategy_version=?)
     AND (? IS NULL OR instrument=?) AND (? IS NULL OR regime=?) AND (? IS NULL OR side=?) AND (? IS NULL OR regime_axes=?)
     ORDER BY exit_ts DESC LIMIT ?`,
  ).all(scope.engine ?? "SWING_15M", scope.strategy ?? null, scope.strategy ?? null,
    scope.strategyVersion ?? null, scope.strategyVersion ?? null, scope.instrument ?? null, scope.instrument ?? null,
    scope.regime ?? null, scope.regime ?? null, scope.direction ?? null, scope.direction ?? null,
    scope.regimeAxes ?? null, scope.regimeAxes ?? null, limit) as Array<Record<string, unknown>>;
  return rows;
}
