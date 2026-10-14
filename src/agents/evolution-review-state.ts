import type { Store } from "../memory/db.ts";
import type { TradingEngine } from "../memory/engines.ts";

const RETRY_BASE_MS = 60_000;
const RETRY_MAX_MS = 60 * 60_000;

export interface EvolutionReviewState {
  engine: TradingEngine;
  scope_key: string;
  last_attempt_ts: string | null;
  last_attempt_trade_count: number | null;
  last_success_ts: string | null;
  last_success_trade_count: number;
  last_no_change_ts: string | null;
  last_failure_ts: string | null;
  last_failure_reason: string | null;
  failure_count: number;
  next_retry_ts: string | null;
  last_outcome: string;
}

export function getEvolutionReviewState(store: Store, engine: TradingEngine, scope: string): EvolutionReviewState | null {
  return store.db.prepare("SELECT * FROM evolution_review_state WHERE engine=? AND scope_key=?")
    .get(engine, scope) as EvolutionReviewState | undefined ?? null;
}

export function evolutionReviewDue(state: EvolutionReviewState | null, sample: number, minimumSample: number,
  interval: number, now: number): boolean {
  if (sample < minimumSample || sample - (state?.last_success_trade_count ?? 0) < interval) return false;
  return !state?.next_retry_ts || Date.parse(state.next_retry_ts) <= now;
}

export function markEvolutionReviewAttempt(store: Store, engine: TradingEngine, scope: string, sample: number, now: number): void {
  store.db.prepare(`INSERT INTO evolution_review_state(engine,scope_key,last_attempt_ts,last_attempt_trade_count,next_retry_ts,last_outcome)
    VALUES(?,?,?,?,?,'ATTEMPTING') ON CONFLICT(engine,scope_key) DO UPDATE SET
      last_attempt_ts=excluded.last_attempt_ts,last_attempt_trade_count=excluded.last_attempt_trade_count,
      next_retry_ts=excluded.next_retry_ts,last_outcome='ATTEMPTING'`)
    .run(engine, scope, new Date(now).toISOString(), sample, new Date(now + RETRY_BASE_MS).toISOString());
}

export function markEvolutionReviewFailure(store: Store, engine: TradingEngine, scope: string, reason: string, now: number): void {
  const current = getEvolutionReviewState(store, engine, scope);
  const failureCount = (current?.failure_count ?? 0) + 1;
  const delay = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.min(20, failureCount - 1));
  store.db.prepare(`INSERT INTO evolution_review_state(engine,scope_key,last_failure_ts,last_failure_reason,failure_count,next_retry_ts,last_outcome)
    VALUES(?,?,?,?,?,?, 'FAILED') ON CONFLICT(engine,scope_key) DO UPDATE SET
      last_failure_ts=excluded.last_failure_ts,last_failure_reason=excluded.last_failure_reason,
      failure_count=excluded.failure_count,next_retry_ts=excluded.next_retry_ts,last_outcome='FAILED'`)
    .run(engine, scope, new Date(now).toISOString(), reason.slice(0, 300), failureCount, new Date(now + delay).toISOString());
}

export function markEvolutionReviewComplete(store: Store, engine: TradingEngine, scope: string, sample: number,
  outcome: "NO_CHANGE" | "REJECTED" | "CHALLENGER_CREATED", now: number): void {
  const timestamp = new Date(now).toISOString();
  store.db.prepare(`INSERT INTO evolution_review_state(engine,scope_key,last_attempt_ts,last_attempt_trade_count,last_success_ts,
      last_success_trade_count,last_no_change_ts,last_failure_ts,last_failure_reason,failure_count,next_retry_ts,last_outcome)
    VALUES(?,?,?,?,?,?,?,NULL,NULL,0,NULL,?) ON CONFLICT(engine,scope_key) DO UPDATE SET
      last_attempt_ts=COALESCE(evolution_review_state.last_attempt_ts,excluded.last_attempt_ts),
      last_attempt_trade_count=COALESCE(evolution_review_state.last_attempt_trade_count,excluded.last_attempt_trade_count),
      last_success_ts=excluded.last_success_ts,last_success_trade_count=excluded.last_success_trade_count,
      last_no_change_ts=CASE WHEN excluded.last_outcome='NO_CHANGE' THEN excluded.last_success_ts ELSE evolution_review_state.last_no_change_ts END,
      failure_count=0,next_retry_ts=NULL,last_outcome=excluded.last_outcome`)
    .run(engine, scope, timestamp, sample, timestamp, sample, outcome === "NO_CHANGE" ? timestamp : null, outcome);
}
