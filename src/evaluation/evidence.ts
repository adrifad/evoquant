// M1 — truthful performance evidence reconciliation. The only trades admitted
// to NET statistics are closed rows whose exchange accounting is complete and
// whose evidence state is VALID. Everything else is counted, never estimated
// into profitability. MFE/MAE remain raw price excursions, not R or USDT PnL.
import type { Store } from "../memory/db.ts";

export interface PerformanceMetrics {
  trades: number;
  wins: number;
  losses: number;
  breakeven: number;
  winRate: number | null;
  expectancyR: number | null;
  profitFactor: number | null;
  averageWinR: number | null;
  averageLossR: number | null;
  netPnlUsdt: number | null;
  grossPnlUsdt: number | null;
  feesUsdt: number | null;
  fundingUsdt: number | null;
  averageNetPnlUsdt: number | null;
  maxDrawdownUsdt: number | null;
  averageHoldingSeconds: number | null;
}

export interface EvidenceCohort {
  key: string;
  trades: number;
  metrics: PerformanceMetrics | null;
}

export interface PerformanceEvidenceReport {
  generatedAt: string;
  definitions: Record<string, string>;
  completeness: {
    closedTrades: number;
    verifiedNetTrades: number;
    evolutionEligibleTrades: number;
    evidenceCoveragePct: number | null;
    incompleteAccounting: number;
    evidencePending: number;
    invalidEvidence: number;
    reconciliationPending: number;
    uncertainExitAttribution: number;
    excursionCoverage: number;
    openTrades: number;
    simulatedResearchTrades: number;
  };
  overall: PerformanceMetrics | null;
  byEngine: EvidenceCohort[];
  byStrategy: EvidenceCohort[];
  bySymbol: EvidenceCohort[];
  byRegime: EvidenceCohort[];
  byDirection: EvidenceCohort[];
  cohorts: {
    verifiedNet: EvidenceCohort;
    evolutionEligible: EvidenceCohort;
    incompleteAccounting: EvidenceCohort;
    uncertainExit: EvidenceCohort;
    unrealized: EvidenceCohort;
    simulatedResearch: EvidenceCohort;
  };
  cohortReconciliation: {
    closedByEngine: Record<string, number>;
    financiallyVerifiedByEngine: Record<string, number>;
    evolutionEligibleByEngine: Record<string, number>;
    closedByCoreVersion: Record<string, number>;
    financiallyVerifiedByCoreVersion: Record<string, number>;
    evolutionEligibleByCoreVersion: Record<string, number>;
    note: string;
  };
  limitations: string[];
}

interface TradeRow {
  trade_id: string;
  engine: string | null;
  strategy: string | null;
  strategy_core_version: number | null;
  strategy_version: number | null;
  instrument: string | null;
  side: string | null;
  regime: string | null;
  exit_reason: string | null;
  exit_ts: string | null;
  pnl: number | null;
  fees: number | null;
  funding: number | null;
  result_r: number | null;
  mfe: number | null;
  mae: number | null;
  duration_s: number | null;
  status: string;
  evidence_state: string | null;
  evolution_evidence_eligible: number | null;
  result_r_basis: string | null;
  accounting_quality: string | null;
}

function finite(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function round(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

/** Financial validity is independent of whether Evolution may consume the row. */
function financiallyVerified(row: TradeRow): boolean {
  return row.status === "CLOSED" && row.evidence_state === "VALID"
    && row.result_r_basis === "NET" && row.accounting_quality === "COMPLETE"
    && finite(row.pnl) !== null && finite(row.fees) !== null && finite(row.funding) !== null
    && finite(row.result_r) !== null;
}

function evolutionEligible(row: TradeRow): boolean {
  return financiallyVerified(row) && row.evolution_evidence_eligible === 1;
}

function average(values: number[]): number | null {
  return values.length ? round(values.reduce((sum, value) => sum + value, 0) / values.length) : null;
}

function metrics(rows: TradeRow[]): PerformanceMetrics | null {
  if (!rows.length) return null;
  const values = rows.map((row) => ({
    pnl: finite(row.pnl)!, fees: finite(row.fees)!, funding: finite(row.funding)!, r: finite(row.result_r)!,
    duration: finite(row.duration_s), exitTs: row.exit_ts ?? "",
  }));
  const wins = values.filter((value) => value.pnl > 0);
  const losses = values.filter((value) => value.pnl < 0);
  const breakeven = values.length - wins.length - losses.length;
  const positive = wins.reduce((sum, value) => sum + value.pnl, 0);
  const negative = losses.reduce((sum, value) => sum + Math.abs(value.pnl), 0);
  const net = values.reduce((sum, value) => sum + value.pnl, 0);
  const fees = values.reduce((sum, value) => sum + value.fees, 0);
  const funding = values.reduce((sum, value) => sum + value.funding, 0);
  const gross = values.reduce((sum, value) => sum + value.pnl + value.fees - value.funding, 0);
  let cumulative = 0;
  let peak = 0;
  let maxDrawdown = 0;
  for (const value of [...values].sort((a, b) => a.exitTs.localeCompare(b.exitTs))) {
    cumulative += value.pnl;
    peak = Math.max(peak, cumulative);
    maxDrawdown = Math.max(maxDrawdown, peak - cumulative);
  }
  return {
    trades: values.length,
    wins: wins.length,
    losses: losses.length,
    breakeven,
    winRate: round(wins.length / values.length),
    expectancyR: average(values.map((value) => value.r)),
    profitFactor: negative > 0 ? round(positive / negative) : null,
    averageWinR: average(wins.map((value) => value.r)),
    averageLossR: average(losses.map((value) => value.r)),
    netPnlUsdt: round(net),
    grossPnlUsdt: round(gross),
    feesUsdt: round(fees),
    fundingUsdt: round(funding),
    averageNetPnlUsdt: round(net / values.length),
    maxDrawdownUsdt: round(maxDrawdown),
    averageHoldingSeconds: average(values.flatMap((value) => value.duration === null ? [] : [value.duration])),
  };
}

function cohorts(rows: TradeRow[], keyOf: (row: TradeRow) => string): EvidenceCohort[] {
  const groups = new Map<string, TradeRow[]>();
  for (const row of rows) {
    const key = keyOf(row);
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))
    .map(([key, entries]) => ({ key, trades: entries.length, metrics: metrics(entries) }));
}

function strategyKey(row: TradeRow): string {
  return `${row.strategy ?? "UNKNOWN"} C${Number(row.strategy_core_version) || 1} V${Number(row.strategy_version) || 0}`;
}

function countBy(rows: TradeRow[], keyOf: (row: TradeRow) => string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const row of rows) {
    const key = keyOf(row);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return counts;
}

export function reconcilePerformanceEvidence(store: Store): PerformanceEvidenceReport {
  const all = store.db.prepare(`SELECT trade_id,engine,strategy,strategy_core_version,strategy_version,instrument,side,
      regime,exit_reason,exit_ts,pnl,fees,funding,result_r,mfe,mae,duration_s,status,evidence_state,
      evolution_evidence_eligible,result_r_basis,accounting_quality
    FROM trades ORDER BY COALESCE(exit_ts,entry_ts) ASC`).all() as TradeRow[];
  const closed = all.filter((row) => row.status === "CLOSED");
  const verified = closed.filter(financiallyVerified);
  const evolutionCohort = closed.filter(evolutionEligible);
  const open = all.filter((row) => row.status === "OPEN");
  const reconciliationPending = all.filter((row) => row.status === "RECONCILIATION_PENDING");
  const incomplete = closed.filter((row) => !financiallyVerified(row));
  const uncertainExit = closed.filter((row) => row.exit_reason === "EXCHANGE_CLOSE_UNCLASSIFIED");
  const shadow = store.db.prepare(`SELECT status,shadow_role,strategy,COALESCE(net_r,0) net_r FROM shadow_trades`).all() as
    Array<{ status: string; shadow_role: string; strategy: string; net_r: number }>;
  const shadowClosed = shadow.filter((row) => row.status === "CLOSED");
  const excursionCoverage = verified.filter((row) => finite(row.mfe) !== null && finite(row.mae) !== null).length;
  const stateCounts = countBy(closed, (row) => row.evidence_state ?? "UNKNOWN");
  const overall = metrics(verified);

  return {
    generatedAt: new Date().toISOString(),
    definitions: {
      verifiedNet: "closed trade with VALID evidence, NET basis, COMPLETE accounting and finite pnl/fees/funding/result_r",
      evolutionEligible: "financially verified trade that additionally has evolution_evidence_eligible=1",
      netPnlUsdt: "exchange-derived gross price PnL minus proven fees plus signed funding",
      expectancyR: "arithmetic mean of NET result_r over verified trades; null without verified trades",
      profitFactor: "sum of positive NET USDT PnL divided by absolute sum of negative NET USDT PnL; null without losses",
      maxDrawdownUsdt: "peak-to-trough drawdown of cumulative verified NET trade PnL, not account-equity drawdown",
      excursion: "MFE/MAE are raw favorable/adverse price movement; they are never treated as realized R or USDT profit",
      simulated: "shadow_trades are counterfactual research results and never included in live NET statistics",
      uncertainExit: "EXCHANGE_CLOSE_UNCLASSIFIED is uncertain attribution, not proof of a failed take-profit",
    },
    completeness: {
      closedTrades: closed.length,
      verifiedNetTrades: verified.length,
      evolutionEligibleTrades: evolutionCohort.length,
      evidenceCoveragePct: closed.length ? round(verified.length / closed.length * 100) : null,
      incompleteAccounting: incomplete.length,
      evidencePending: Number(stateCounts.EVIDENCE_PENDING ?? 0) + Number(stateCounts.ACCOUNTING_INCOMPLETE ?? 0),
      invalidEvidence: Number(stateCounts.INVALID ?? 0),
      reconciliationPending: reconciliationPending.length,
      uncertainExitAttribution: uncertainExit.length,
      excursionCoverage,
      openTrades: open.length,
      simulatedResearchTrades: shadow.length,
    },
    overall,
    byEngine: cohorts(verified, (row) => row.engine ?? "UNKNOWN"),
    byStrategy: cohorts(verified, strategyKey),
    bySymbol: cohorts(verified, (row) => row.instrument ?? "UNKNOWN"),
    byRegime: cohorts(verified, (row) => row.regime ?? "UNKNOWN"),
    byDirection: cohorts(verified, (row) => row.side ?? "UNKNOWN"),
    cohorts: {
      verifiedNet: { key: "VERIFIED_NET", trades: verified.length, metrics: overall },
      evolutionEligible: { key: "EVOLUTION_ELIGIBLE", trades: evolutionCohort.length, metrics: metrics(evolutionCohort) },
      incompleteAccounting: { key: "INCOMPLETE_ACCOUNTING", trades: incomplete.length, metrics: null },
      uncertainExit: { key: "EXCHANGE_CLOSE_UNCLASSIFIED", trades: uncertainExit.length, metrics: null },
      unrealized: { key: "UNREALIZED", trades: open.length + reconciliationPending.length, metrics: null },
      simulatedResearch: { key: "SIMULATED_SHADOW", trades: shadowClosed.length, metrics: shadowClosed.length ? {
        trades: shadowClosed.length,
        wins: shadowClosed.filter((row) => row.net_r > 0).length,
        losses: shadowClosed.filter((row) => row.net_r < 0).length,
        breakeven: shadowClosed.filter((row) => row.net_r === 0).length,
        winRate: round(shadowClosed.filter((row) => row.net_r > 0).length / shadowClosed.length),
        expectancyR: average(shadowClosed.map((row) => Number(row.net_r))),
        profitFactor: null, averageWinR: null, averageLossR: null,
        netPnlUsdt: null, grossPnlUsdt: null, feesUsdt: null, fundingUsdt: null,
        averageNetPnlUsdt: null, maxDrawdownUsdt: null, averageHoldingSeconds: null,
      } : null },
    },
    cohortReconciliation: {
      closedByEngine: countBy(closed, (row) => row.engine ?? "UNKNOWN"),
      financiallyVerifiedByEngine: countBy(verified, (row) => row.engine ?? "UNKNOWN"),
      evolutionEligibleByEngine: countBy(evolutionCohort, (row) => row.engine ?? "UNKNOWN"),
      closedByCoreVersion: countBy(closed, (row) => `CORE_${Number(row.strategy_core_version) || 1}`),
      financiallyVerifiedByCoreVersion: countBy(verified, (row) => `CORE_${Number(row.strategy_core_version) || 1}`),
      evolutionEligibleByCoreVersion: countBy(evolutionCohort, (row) => `CORE_${Number(row.strategy_core_version) || 1}`),
      note: "Financially verified NET rows contribute to expectancy, profit factor, fees, funding and drawdown even when Evolution eligibility is absent. Evolution eligibility is reported separately.",
    },
    limitations: [
      "MFE/MAE are price excursions and are not converted to R or USDT without a proven exit path.",
      "Unrealized PnL is excluded from all realized statistics.",
      "Shadow results are simulated research evidence and are never exchange fills.",
      "A small or incomplete cohort returns unavailable metrics instead of estimated profit.",
    ],
  };
}
