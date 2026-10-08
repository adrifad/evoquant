import type { Store } from "../memory/db.ts";
import { kvGet } from "../memory/db.ts";
import { getV2Champions, listV2Versions, V2_STRATEGIES } from "../strategy/v2-registry.ts";
import { getV2EvolutionEvidence, v2EvolutionStateKey } from "../agents/v2-evolution.ts";
import { summarize } from "../evaluation/performance.ts";
import { familyForV2 } from "../strategy/identity.ts";
import type { ScanRow } from "../strategy/scanner.ts";

export function scannerProjection(store: Store, rows: ScanRow[], updatedAt: string | null) {
  const opens = store.db.prepare("SELECT instrument,side,trade_id FROM trades WHERE status='OPEN'").all() as Array<Record<string, unknown>>;
  const events = updatedAt ? store.db.prepare("SELECT kind,payload,ts FROM system_events WHERE kind IN ('LLM_GATE_ALLOW','LLM_GATE_DENY','RISK_EVENT') AND ts>=? ORDER BY id DESC LIMIT 120")
    .all(updatedAt) as Array<{ kind: string; payload: string; ts: string }> : [];
  const payload = (raw: string): Record<string, unknown> => {
    try { const value: unknown = JSON.parse(raw); return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
    catch { return {}; }
  };
  return rows.map(row => {
    const position = opens.find(p => p.instrument === row.instrument);
    const decision = updatedAt ? store.db.prepare("SELECT * FROM decisions WHERE instrument=? AND ts>=? ORDER BY ts DESC LIMIT 1").get(row.instrument, updatedAt) as Record<string, unknown> | undefined : undefined;
    const gate = events.find(event => event.kind.startsWith("LLM_GATE_") && payload(event.payload).instrument === row.instrument);
    const rejection = events.find(event => {
      if (event.kind !== "RISK_EVENT" || event.ts < String(decision?.ts ?? updatedAt)) return false;
      const data = payload(event.payload);
      return data.instId === row.instrument && ["sizing_rejected", "entry_preparation_rejected", "race_guard", "sizing_rejected_after_refresh"].some(key => typeof data[key] === "string");
    });
    const rejected = rejection ? payload(rejection.payload) : null;
    const finalReason = rejected?.reason ?? rejected?.sizing_rejected ?? rejected?.entry_preparation_rejected ?? rejected?.sizing_rejected_after_refresh ?? rejected?.race_guard;
    const verdict = decision ? payload(String(decision.risk_verdict ?? "{}")) : null;
    const failed = row.conditions?.flatMap(e => e.conditions.filter(c => !c.passed).map(c => `${e.strategy}: ${c.name}`)) ?? [];
    const state = position ? "POSITION_OPEN" : !row.tradable ? failed.length ? "SETUP_FAILED" : "NO_SETUP"
      : gate?.kind === "LLM_GATE_DENY" ? "GATE_DENIED" : rejection || verdict?.approved === false ? "RISK_REJECTED"
      : gate?.kind === "LLM_GATE_ALLOW" && verdict?.approved && decision?.decision !== "HOLD" ? "READY" : "CANDIDATE";
    return { ...row, state, gate: gate ? gate.kind === "LLM_GATE_ALLOW" ? "ALLOW" : "DENY" : "NOT_EVALUATED",
      risk: rejection ? "REJECTED" : verdict && decision?.decision !== "HOLD" ? verdict.approved ? "APPROVED" : "REJECTED" : "NOT_EVALUATED",
      reason: state === "GATE_DENIED" ? payload(gate!.payload).reasoning ?? [] : rejection ? [finalReason] : verdict?.approved === false ? [verdict.reason] : failed,
      lastSignal: decision?.ts ?? gate?.ts ?? null, position: position ?? null, decision: decision ?? null };
  });
}

export function evolutionFamilies(store: Store, minimum: number, interval: number) {
  const champions = getV2Champions(store);
  return V2_STRATEGIES.map(strategy => {
    const champion = champions[strategy];
    const evidence = getV2EvolutionEvidence(store, strategy, champion.version);
    const last = Number(kvGet(store, v2EvolutionStateKey("SWING_15M", strategy, champion.version)) ?? 0);
    const versions = listV2Versions(store, strategy);
    const challenger = versions.find(v => v.status === "CHALLENGER" || v.status === "SHADOW") ?? null;
    const evaluation = challenger ? store.db.prepare("SELECT * FROM strategy_v2_evaluations WHERE strategy=? AND challenger_version=? ORDER BY id DESC LIMIT 1").get(strategy, challenger.version) : null;
    const target = Math.max(minimum, last + interval);
    return { family: familyForV2(strategy), champion, challenger, versions, sample: evidence.length,
      nextReview: target, remaining: Math.max(0, target - evidence.length), lastReviewed: last,
      performance: evidence.length ? summarize(evidence.map(row => row.result_r)) : null, evaluation };
  });
}
