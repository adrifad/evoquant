import { createHash } from "node:crypto";
import type { Store } from "./db.ts";

export interface DecisionMemoryScope {
  engine: "SWING_15M" | "SCALP_5M";
  instrument: string;
  strategy: string;
  strategyCoreVersion: 1 | 2;
  strategyVersion: number;
  side: "LONG" | "SHORT";
  regime: string;
  regimeAxes?: unknown;
}

export interface DecisionMemoryStat {
  id: "S1" | "S2";
  scope: "exact" | "same_symbol_strategy_direction";
  trades: number;
  wins: number;
  losses: number;
  win_rate: number | null;
  expectancy_r: number | null;
}

export interface DecisionMemoryLesson {
  id: string;
  status: "VERIFIED" | "REINFORCED";
  n: number;
  confidence: number;
  statement: string;
}

export interface DecisionMemoryContext {
  window_days: 30;
  stats: [DecisionMemoryStat, DecisionMemoryStat];
  lessons: DecisionMemoryLesson[];
}

const DAY_MS = 86_400_000;
const STAT_ELIGIBILITY = `status='CLOSED' AND evidence_state='VALID' AND evolution_evidence_eligible=1
  AND result_r_basis='NET' AND result_r IS NOT NULL AND accounting_quality='COMPLETE'
  AND pnl IS NOT NULL AND fees IS NOT NULL AND funding IS NOT NULL AND exit_ts>=? AND exit_ts<?`;

function round(value: number, digits = 3): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function emptyStat(id: DecisionMemoryStat["id"], scope: DecisionMemoryStat["scope"]): DecisionMemoryStat {
  return { id, scope, trades: 0, wins: 0, losses: 0, win_rate: null, expectancy_r: null };
}

function queryStat(store: Store, id: DecisionMemoryStat["id"], label: DecisionMemoryStat["scope"],
  where: string, params: unknown[], from: string, until: string): DecisionMemoryStat {
  const rows = store.db.prepare(`SELECT result_r FROM trades WHERE ${STAT_ELIGIBILITY} AND ${where}`)
    .all(from, until, ...params) as Array<{ result_r: number | null }>;
  const rs = rows.map((row) => Number(row.result_r)).filter(Number.isFinite);
  if (!rs.length) return emptyStat(id, label);
  const wins = rs.filter((r) => r > 0).length;
  const losses = rs.filter((r) => r < 0).length;
  return { id, scope: label, trades: rs.length, wins, losses, win_rate: round(wins / rs.length),
    expectancy_r: round(rs.reduce((sum, r) => sum + r, 0) / rs.length) };
}

function canonical(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "symbol") return `symbol:${String(value)}`;
  if (typeof value !== "object") return JSON.stringify(value) ?? null;
  if (Array.isArray(value)) return `[${value.map((entry) => canonical(entry) ?? "null").join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key]) ?? "null"}`).join(",")}}`;
}

function parseAxes(raw: unknown): unknown {
  if (raw === null || raw === undefined || raw === "") return null;
  if (typeof raw !== "string") return raw;
  try { return JSON.parse(raw) as unknown; } catch { return Symbol.for("invalid-json"); }
}

function validTrade(trade: LessonEvidenceRow, lesson: LessonRow): boolean {
  const exit = Date.parse(trade.exit_ts ?? "");
  const created = Date.parse(lesson.created_ts ?? "");
  return trade.status === "CLOSED" && trade.evidence_state === "VALID" && trade.evolution_evidence_eligible === 1
    && trade.result_r_basis === "NET" && trade.accounting_quality === "COMPLETE"
    && trade.pnl !== null && trade.fees !== null && trade.funding !== null
    && Number.isFinite(trade.result_r) && Number.isFinite(exit) && Number.isFinite(created) && exit > created
    && trade.trade_id !== lesson.source_trade_id
    && trade.engine === lesson.scope_engine
    && (lesson.scope_strategy === null || lesson.scope_strategy === trade.strategy)
    && (lesson.scope_strategy_version === null || lesson.scope_strategy_version === trade.strategy_version)
    && (lesson.scope_instrument === null || lesson.scope_instrument === trade.instrument)
    && (lesson.scope_regime === null || lesson.scope_regime === trade.regime)
    && (lesson.scope_direction === null || lesson.scope_direction === trade.side)
    && (lesson.scope_regime_axes === null || canonical(parseAxes(lesson.scope_regime_axes)) === canonical(parseAxes(trade.regime_axes)));
}

interface LessonRow {
  lesson_id: string; statement: string; status: string; scope_engine: string | null;
  scope_strategy: string | null; scope_strategy_version: number | null; scope_instrument: string | null;
  scope_regime: string | null; scope_direction: string | null; scope_regime_axes: string | null;
  source_trade_id: string | null; confidence: number | null; created_ts: string | null;
}
interface LessonEvidenceRow {
  trade_id: string; aligned: number; status: string; evidence_state: string; evolution_evidence_eligible: number;
  result_r_basis: string; result_r: number | null; accounting_quality: string; pnl: number | null; fees: number | null;
  funding: number | null; exit_ts: string | null; engine: string; strategy: string | null;
  strategy_version: number | null; instrument: string; regime: string | null; side: string | null; regime_axes: string | null;
}

function matchesCandidate(lesson: LessonRow, scope: DecisionMemoryScope): boolean {
  return lesson.scope_engine === scope.engine
    && (lesson.scope_strategy === null || lesson.scope_strategy === scope.strategy)
    && (lesson.scope_strategy_version === null || lesson.scope_strategy_version === scope.strategyVersion)
    && (lesson.scope_instrument === null || lesson.scope_instrument === scope.instrument)
    && (lesson.scope_regime === null || lesson.scope_regime === scope.regime)
    && (lesson.scope_direction === null || lesson.scope_direction === scope.side)
    && (lesson.scope_regime_axes === null || canonical(parseAxes(lesson.scope_regime_axes)) === canonical(scope.regimeAxes));
}

function readLessons(store: Store, scope: DecisionMemoryScope): DecisionMemoryLesson[] {
  const rows = store.db.prepare(`SELECT l.lesson_id,l.statement,l.status,l.scope_engine,l.scope_strategy,
    l.scope_strategy_version,l.scope_instrument,l.scope_regime,l.scope_direction,l.scope_regime_axes,
    l.source_trade_id,l.confidence,l.created_ts,le.trade_id,le.aligned,t.status AS trade_status,
    t.evidence_state,t.evolution_evidence_eligible,t.result_r_basis,t.result_r,t.accounting_quality,
    t.pnl,t.fees,t.funding,t.exit_ts,t.engine,t.strategy,t.strategy_version,t.instrument,t.regime,t.side,t.regime_axes
    FROM lessons l LEFT JOIN lesson_evidence le ON le.lesson_id=l.lesson_id
    LEFT JOIN trades t ON t.trade_id=le.trade_id
    WHERE l.status IN ('VERIFIED','REINFORCED') AND l.scope_engine=?
    AND (l.scope_strategy IS NULL OR l.scope_strategy=?) AND (l.scope_strategy_version IS NULL OR l.scope_strategy_version=?)
    AND (l.scope_instrument IS NULL OR l.scope_instrument=?) AND (l.scope_regime IS NULL OR l.scope_regime=?)
    AND (l.scope_direction IS NULL OR l.scope_direction=?) ORDER BY l.lesson_id`)
    .all(scope.engine, scope.strategy, scope.strategyVersion, scope.instrument, scope.regime, scope.side) as Array<LessonRow & {
      trade_id: string | null; aligned: number | null; trade_status: string | null;
      evidence_state: string | null; evolution_evidence_eligible: number | null; result_r_basis: string | null;
      result_r: number | null; accounting_quality: string | null; pnl: number | null; fees: number | null;
      funding: number | null; exit_ts: string | null; engine: string | null; strategy: string | null;
      strategy_version: number | null; instrument: string | null; regime: string | null; side: string | null;
      regime_axes: string | null;
    }>;
  const grouped = new Map<string, { lesson: LessonRow; evidence: LessonEvidenceRow[] }>();
  for (const row of rows) {
    let group = grouped.get(row.lesson_id);
    if (!group) {
      const { lesson_id, statement, status, scope_engine, scope_strategy, scope_strategy_version, scope_instrument,
        scope_regime, scope_direction, scope_regime_axes, source_trade_id, confidence, created_ts } = row;
      group = { lesson: { lesson_id, statement, status, scope_engine, scope_strategy, scope_strategy_version,
        scope_instrument, scope_regime, scope_direction, scope_regime_axes, source_trade_id, confidence, created_ts }, evidence: [] };
      grouped.set(lesson_id, group);
    }
    if (row.trade_id === null || (row.aligned !== 0 && row.aligned !== 1)) continue;
    group.evidence.push({ trade_id: row.trade_id, aligned: row.aligned,
      status: row.trade_status ?? "", evidence_state: row.evidence_state ?? "",
      evolution_evidence_eligible: row.evolution_evidence_eligible ?? 0, result_r_basis: row.result_r_basis ?? "",
      result_r: row.result_r, accounting_quality: row.accounting_quality ?? "", pnl: row.pnl, fees: row.fees,
      funding: row.funding, exit_ts: row.exit_ts, engine: row.engine ?? "", strategy: row.strategy,
      strategy_version: row.strategy_version, instrument: row.instrument ?? "", regime: row.regime, side: row.side,
      regime_axes: row.regime_axes });
  }
  const result: Array<{ lesson: DecisionMemoryLesson; specificity: number; agreement: number }> = [];
  for (const { lesson, evidence: allEvidence } of grouped.values()) {
    if (!matchesCandidate(lesson, scope)) continue;
    const evidence = allEvidence.filter((trade) => validTrade(trade, lesson));
    const n = evidence.length;
    const agree = evidence.filter((entry) => entry.aligned === 1).length;
    const agreement = n ? agree / n : 0;
    const threshold = lesson.status === "VERIFIED" ? n >= 30 && agreement >= 0.65 : n >= 10 && agreement >= 0.6;
    if (!threshold || (lesson.status !== "VERIFIED" && lesson.status !== "REINFORCED")) continue;
    const statement = String(lesson.statement ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 120);
    if (!statement || lesson.lesson_id.length > 64) continue;
    const rawConfidence = Number(lesson.confidence);
    result.push({ lesson: { id: lesson.lesson_id, status: lesson.status, n,
      confidence: round(Number.isFinite(rawConfidence) ? Math.max(0, Math.min(1, rawConfidence)) : 0), statement },
      specificity: [lesson.scope_strategy, lesson.scope_strategy_version, lesson.scope_instrument,
        lesson.scope_regime, lesson.scope_direction, lesson.scope_regime_axes].filter((v) => v !== null).length,
      agreement });
  }
  result.sort((a, b) => b.specificity - a.specificity
    || Number(b.lesson.status === "VERIFIED") - Number(a.lesson.status === "VERIFIED")
    || b.agreement - a.agreement || b.lesson.n - a.lesson.n || b.lesson.confidence - a.lesson.confidence
    || a.lesson.id.localeCompare(b.lesson.id));
  const seen = new Set<string>();
  return result.map((entry) => entry.lesson).filter((lesson) => {
    if (seen.has(lesson.id)) return false;
    seen.add(lesson.id);
    return true;
  }).slice(0, 5);
}

export function buildDecisionContext(store: Store, scope: DecisionMemoryScope, now = new Date()): DecisionMemoryContext {
  const until = now.toISOString();
  const from = new Date(now.getTime() - 30 * DAY_MS).toISOString();
  const shared = `engine=? AND strategy=? AND strategy_core_version=? AND strategy_version=? AND instrument=? AND side=?`;
  const base = [scope.engine, scope.strategy, scope.strategyCoreVersion, scope.strategyVersion, scope.instrument, scope.side];
  const stats: [DecisionMemoryStat, DecisionMemoryStat] = [
    queryStat(store, "S1", "exact", `${shared} AND regime=?`, [...base, scope.regime], from, until),
    queryStat(store, "S2", "same_symbol_strategy_direction", shared, base, from, until),
  ];
  return { window_days: 30, stats, lessons: readLessons(store, scope) };
}

export function serializeDecisionContext(context: DecisionMemoryContext, maxChars = 2_400): string {
  const copy: DecisionMemoryContext = { window_days: 30, stats: context.stats, lessons: context.lessons.map((lesson) => ({ ...lesson })) };
  let encoded = JSON.stringify({ trade_memory: copy });
  while (encoded.length > maxChars && copy.lessons.length) {
    const last = copy.lessons.at(-1)!;
    if (last.statement.length > 24) last.statement = last.statement.slice(0, Math.max(24, last.statement.length - Math.max(16, encoded.length - maxChars)));
    else copy.lessons.pop();
    encoded = JSON.stringify({ trade_memory: copy });
  }
  // If unusual identifiers make the fixed statistics exceed the limit, retain those primary metrics.
  return encoded;
}

export function decisionMemoryFingerprint(serialized: string): string {
  return createHash("sha256").update(serialized).digest("hex").slice(0, 16);
}

export function validateMemoryCitations(citations: string[], context: DecisionMemoryContext | null): boolean {
  if (!context) return citations.length === 0;
  const allowed = new Set([...context.stats.map((stat) => stat.id), ...context.lessons.map((lesson) => lesson.id)]);
  return citations.every((citation) => allowed.has(citation));
}

export function memoryDenyRequiresCitation(text: string): boolean {
  const historical = /\b(?:trade memory|historical|expectancy|sample size|matched trades|underperform(?:ed|s)?|similar setup|lesson|S[12]|LESSON-[A-Z0-9_-]+)\b/i.test(text);
  if (historical) return true;
  return !/\b(?:market|event|stale|contradict(?:ory|s)?|trap|blow.?off|RSI|trend|news|gap|volatility|spread|candle|price|liquidity)\b/i.test(text);
}
