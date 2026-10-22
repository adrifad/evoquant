// M5 — observation-only strategy suitability. Decisions describe verified
// historical evidence by scope; they never alter entry authorization.
import type { Store } from "../memory/db.ts";

export type SuitabilityDecision = "ELIGIBLE" | "UNPROVEN" | "DISFAVORED" | "NO_TRADE" | "BLOCKED_BY_RISK";

export interface SuitabilityMetrics {
  trades: number;
  wins: number;
  losses: number;
  winRate: number | null;
  netExpectancyR: number | null;
  grossExpectancyR: number | null;
  averageFeeR: number | null;
  averageFundingR: number | null;
  profitFactor: number | null;
  netPnlUsdt: number;
}

export interface SuitabilityScope {
  engine: string;
  strategy: string;
  strategyCoreVersion: number;
  strategyVersion: number;
  instrument: string;
  regime: string;
  direction: string;
  metrics: SuitabilityMetrics;
  decision: SuitabilityDecision;
  reason: string;
}

export interface SuitabilityReport {
  generatedAt: string;
  observationOnly: true;
  authorizationImpact: "NONE";
  riskBlocked: boolean;
  minimumSample: number;
  minimumProfitFactor: number;
  summary: Record<SuitabilityDecision, number>;
  scopes: SuitabilityScope[];
  limitations: string[];
}

interface EvidenceRow {
  engine: string | null;
  strategy: string | null;
  strategy_core_version: number | null;
  strategy_version: number | null;
  instrument: string | null;
  regime: string | null;
  side: string | null;
  pnl: number | null;
  fees: number | null;
  funding: number | null;
  result_r: number | null;
}

function finite(value: unknown): number | null {
  const number = Number(value);
  return value === null || value === undefined || value === "" || !Number.isFinite(number) ? null : number;
}

function round(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function metrics(rows: EvidenceRow[]): SuitabilityMetrics {
  const values = rows.map((row) => ({ pnl: finite(row.pnl) ?? 0, fees: finite(row.fees) ?? 0,
    funding: finite(row.funding) ?? 0, r: finite(row.result_r) ?? 0 }));
  const wins = values.filter((value) => value.pnl > 0);
  const losses = values.filter((value) => value.pnl < 0);
  const positive = wins.reduce((sum, value) => sum + value.pnl, 0);
  const negative = losses.reduce((sum, value) => sum + Math.abs(value.pnl), 0);
  const average = (items: number[]): number | null => items.length
    ? round(items.reduce((sum, value) => sum + value, 0) / items.length) : null;
  return {
    trades: values.length,
    wins: wins.length,
    losses: losses.length,
    winRate: values.length ? round(wins.length / values.length) : null,
    netExpectancyR: average(values.map((value) => value.r)),
    grossExpectancyR: null,
    averageFeeR: null,
    averageFundingR: null,
    profitFactor: negative > 0 ? round(positive / negative) : null,
    netPnlUsdt: round(values.reduce((sum, value) => sum + value.pnl, 0)),
  };
}

function scopeMetrics(rows: EvidenceRow[]): SuitabilityMetrics {
  const base = metrics(rows);
  const rs = rows.map((row) => finite(row.result_r) ?? 0);
  const grossRs = rows.map((row, index) => {
    const pnl = finite(row.pnl) ?? 0;
    const fees = finite(row.fees) ?? 0;
    const funding = finite(row.funding) ?? 0;
    const r = rs[index] ?? 0;
    // result_r is NET cash PnL divided by initial cash risk. Allocation of
    // cost R is only valid when the trade actually has a net R observation.
    const cash = pnl + fees - funding;
    return r !== 0 && pnl !== 0 ? cash / (pnl / r) : 0;
  });
  const average = (items: number[]): number | null => items.length
    ? round(items.reduce((sum, value) => sum + value, 0) / items.length) : null;
  const grossSum = grossRs.reduce((sum, value) => sum + value, 0);
  return {
    ...base,
    grossExpectancyR: grossRs.length ? round(grossSum / grossRs.length) : null,
    averageFeeR: average(rows.map((row) => {
      const fees = finite(row.fees) ?? 0;
      const pnl = finite(row.pnl) ?? 0;
      const r = finite(row.result_r) ?? 0;
      return r !== 0 && pnl !== 0 ? fees / (pnl / r) : 0;
    })),
    averageFundingR: average(rows.map((row) => {
      const funding = finite(row.funding) ?? 0;
      const pnl = finite(row.pnl) ?? 0;
      const r = finite(row.result_r) ?? 0;
      return r !== 0 && pnl !== 0 ? Math.abs(funding) / (pnl / r) : 0;
    })),
  };
}

export function deriveSuitability(m: SuitabilityMetrics, input: {
  riskBlocked: boolean;
  minimumSample: number;
  minimumProfitFactor: number;
}): { decision: SuitabilityDecision; reason: string } {
  if (input.riskBlocked) return { decision: "BLOCKED_BY_RISK", reason: "ACCOUNT_OR_RISK_HALT_ACTIVE" };
  if (m.trades < input.minimumSample) return { decision: "UNPROVEN", reason: `SAMPLE_${m.trades}_BELOW_${input.minimumSample}` };
  if (!(m.netExpectancyR !== null && m.netExpectancyR > 0)) {
    if (m.grossExpectancyR !== null && m.grossExpectancyR > 0) {
      return { decision: "NO_TRADE", reason: "AFTER_COST_EXPECTANCY_NON_POSITIVE" };
    }
    return { decision: "DISFAVORED", reason: "NON_POSITIVE_GROSS_AND_NET_EXPECTANCY" };
  }
  if (m.profitFactor === null) return { decision: "UNPROVEN", reason: "NO_LOSS_SAMPLE_FOR_PROFIT_FACTOR" };
  if (m.profitFactor < input.minimumProfitFactor) {
    return { decision: "DISFAVORED", reason: `PROFIT_FACTOR_${m.profitFactor}_BELOW_${input.minimumProfitFactor}` };
  }
  return { decision: "ELIGIBLE", reason: "POSITIVE_NET_EXPECTANCY_AND_SUFFICIENT_SAMPLE" };
}

export function buildSuitabilityReport(store: Store, options: {
  riskBlocked: boolean;
  minimumSample?: number;
  minimumProfitFactor?: number;
}): SuitabilityReport {
  const minimumSample = Math.max(1, Math.floor(options.minimumSample ?? 20));
  const minimumProfitFactor = options.minimumProfitFactor ?? 1.05;
  const rows = store.db.prepare(`SELECT engine,strategy,strategy_core_version,strategy_version,instrument,regime,side,
      pnl,fees,funding,result_r
    FROM trades WHERE status='CLOSED' AND evidence_state='VALID' AND evolution_evidence_eligible=1
      AND result_r_basis='NET' AND accounting_quality='COMPLETE' AND pnl IS NOT NULL
      AND fees IS NOT NULL AND funding IS NOT NULL AND result_r IS NOT NULL`).all() as EvidenceRow[];
  const groups = new Map<string, EvidenceRow[]>();
  for (const row of rows) {
    const key = [row.engine ?? "UNKNOWN", row.strategy ?? "UNKNOWN", Number(row.strategy_core_version) || 1,
      Number(row.strategy_version) || 0, row.instrument ?? "UNKNOWN", row.regime ?? "UNKNOWN", row.side ?? "UNKNOWN"].join("|");
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  const summary: Record<SuitabilityDecision, number> = { ELIGIBLE: 0, UNPROVEN: 0, DISFAVORED: 0, NO_TRADE: 0, BLOCKED_BY_RISK: 0 };
  const scopes = [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, entries]) => {
    const [engine, strategy, core, version, instrument, regime, direction] = key.split("|");
    const m = scopeMetrics(entries);
    const decision = deriveSuitability(m, { riskBlocked: options.riskBlocked, minimumSample, minimumProfitFactor });
    summary[decision.decision] += 1;
    return {
      engine: engine!, strategy: strategy!, strategyCoreVersion: Number(core), strategyVersion: Number(version),
      instrument: instrument!, regime: regime!, direction: direction!, metrics: m,
      decision: decision.decision, reason: decision.reason,
    } satisfies SuitabilityScope;
  });
  return {
    generatedAt: new Date().toISOString(), observationOnly: true, authorizationImpact: "NONE",
    riskBlocked: options.riskBlocked, minimumSample, minimumProfitFactor, summary, scopes,
    limitations: [
      "Suitability is observation-only and cannot authorize or block an order.",
      "A scope below the sample floor is UNPROVEN, not profitable by implication.",
      "Historical scope evidence does not guarantee forward performance.",
    ],
  };
}
