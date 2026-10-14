import type { Store } from "./db.ts";

export type LossAttributionDimension = "engine" | "strategy" | "setup" | "symbol" | "side" | "regime" |
  "gateDecision" | "entryHourUtc" | "exitHourUtc" | "exitReason";
export interface TrustedTradeMetrics {
  tradeCount: number;
  wins: number;
  losses: number;
  winRate: number | null;
  totalNetPnlUsdt: number;
  totalGrossPnlUsdt: number;
  totalTradingFeesUsdt: number;
  totalFundingUsdt: number;
  averageNetPnlUsdt: number | null;
  averageGrossPnlUsdt: number | null;
  averageWinUsdt: number | null;
  averageLossUsdt: number | null;
  profitFactor: number | null;
  expectancyR: number | null;
  averageMfe: number | null;
  averageMae: number | null;
  averageDurationSeconds: number | null;
}

interface TrustedTrade {
  engine: string; strategy: string; strategy_core_version: number; strategy_version: number;
  setup: string; instrument: string; side: string; regime: string; gate_decision: string;
  entry_hour_utc: string; exit_hour_utc: string; exit_reason: string | null;
  pnl: number; fees: number; funding: number; result_r: number; mfe: number; mae: number; duration_s: number;
}

function finite(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}
function rounded(value: number): number { return Math.round(value * 1_000_000) / 1_000_000; }
function utcHour(value: unknown): string {
  const timestamp = typeof value === "string" ? Date.parse(value) : Number.NaN;
  return Number.isFinite(timestamp) ? `${String(new Date(timestamp).getUTCHours()).padStart(2, "0")}:00 UTC` : "UNAVAILABLE";
}
function setupKey(strategy: string, entryConditions: unknown): string {
  try {
    const parsed: unknown = JSON.parse(String(entryConditions ?? "null"));
    if (!Array.isArray(parsed)) return `${strategy} · CONDITIONS_UNAVAILABLE`;
    const passed = parsed.flatMap(condition => {
      if (!condition || typeof condition !== "object") return [];
      const row = condition as { name?: unknown; passed?: unknown };
      return row.passed === true && typeof row.name === "string" && /^[A-Z0-9_.-]{1,48}$/i.test(row.name) ? [row.name] : [];
    }).slice(0, 8).sort();
    return passed.length ? `${strategy} · ${passed.join(",")}` : `${strategy} · CONDITIONS_UNAVAILABLE`;
  } catch { return `${strategy} · CONDITIONS_UNAVAILABLE`; }
}

function metrics(rows: readonly TrustedTrade[]): TrustedTradeMetrics {
  const wins = rows.filter(row => row.pnl > 0);
  const losses = rows.filter(row => row.pnl < 0);
  const positivePnl = wins.reduce((sum, row) => sum + row.pnl, 0);
  const negativePnl = losses.reduce((sum, row) => sum + Math.abs(row.pnl), 0);
  const netTotal = rows.reduce((sum, row) => sum + row.pnl, 0);
  const gross = rows.map(row => row.pnl + row.fees - row.funding);
  const average = (values: number[]): number | null => values.length ? rounded(values.reduce((sum, value) => sum + value, 0) / values.length) : null;
  return {
    tradeCount: rows.length, wins: wins.length, losses: losses.length,
    winRate: rows.length ? rounded(wins.length / rows.length) : null,
    totalNetPnlUsdt: rounded(netTotal), totalGrossPnlUsdt: rounded(gross.reduce((sum, value) => sum + value, 0)),
    totalTradingFeesUsdt: rounded(rows.reduce((sum, row) => sum + row.fees, 0)),
    totalFundingUsdt: rounded(rows.reduce((sum, row) => sum + row.funding, 0)),
    averageNetPnlUsdt: rows.length ? rounded(netTotal / rows.length) : null,
    averageGrossPnlUsdt: average(gross), averageWinUsdt: average(wins.map(row => row.pnl)),
    averageLossUsdt: average(losses.map(row => row.pnl)),
    profitFactor: negativePnl > 0 ? rounded(positivePnl / negativePnl) : null,
    expectancyR: average(rows.map(row => row.result_r)), averageMfe: average(rows.map(row => row.mfe)),
    averageMae: average(rows.map(row => row.mae)), averageDurationSeconds: average(rows.map(row => row.duration_s)),
  };
}

function grouped(rows: readonly TrustedTrade[], keyOf: (row: TrustedTrade) => string): Array<{ key: string; metrics: TrustedTradeMetrics }> {
  const groups = new Map<string, TrustedTrade[]>();
  for (const row of rows) {
    const key = keyOf(row);
    const entries = groups.get(key) ?? [];
    entries.push(row);
    groups.set(key, entries);
  }
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([key, entries]) => ({ key, metrics: metrics(entries) }));
}

/** Only complete deterministic NET evidence contributes to trusted loss statistics. */
export function buildLossAttribution(store: Store, sinceIso: string | null = null) {
  const all = store.db.prepare(`SELECT t.engine,t.strategy,t.strategy_core_version,t.strategy_version,t.instrument,t.side,t.regime,t.exit_reason,
      t.entry_ts,t.exit_ts,t.entry_conditions,t.pnl,t.fees,t.funding,t.result_r,t.mfe,t.mae,t.duration_s,
      t.evidence_state,t.evolution_evidence_eligible,t.result_r_basis,t.accounting_quality,d.gate_result
    FROM trades t LEFT JOIN decisions d ON d.decision_id=t.decision_id
    WHERE t.status='CLOSED' AND (? IS NULL OR t.exit_ts>=?) ORDER BY t.exit_ts DESC`)
    .all(sinceIso, sinceIso) as Array<Record<string, unknown>>;
  const stateCounts: Record<string, number> = {};
  const eligible: TrustedTrade[] = [];
  let corruptEligibleCount = 0;
  for (const row of all) {
    const state = String(row.evidence_state ?? "UNKNOWN");
    stateCounts[state] = (stateCounts[state] ?? 0) + 1;
    if (state !== "VALID" || row.evolution_evidence_eligible !== 1 || row.result_r_basis !== "NET") continue;
    const nums = [row.pnl, row.fees, row.funding, row.result_r, row.mfe, row.mae, row.duration_s].map(finite);
    if (row.accounting_quality !== "COMPLETE" || nums.some(value => value === null)) { corruptEligibleCount++; continue; }
    const pnl = nums[0]!; const fees = nums[1]!; const funding = nums[2]!; const resultR = nums[3]!;
    const mfe = nums[4]!; const mae = nums[5]!; const duration = nums[6]!;
    eligible.push({
      engine: String(row.engine ?? "UNKNOWN"), strategy: `${String(row.strategy ?? "UNKNOWN")} V${Number(row.strategy_core_version) || 1}.${Number(row.strategy_version) || 0}`,
      strategy_core_version: Number(row.strategy_core_version) || 1, strategy_version: Number(row.strategy_version) || 0,
      setup: setupKey(`${String(row.strategy ?? "UNKNOWN")} V${Number(row.strategy_core_version) || 1}.${Number(row.strategy_version) || 0}`, row.entry_conditions),
      instrument: String(row.instrument ?? "UNKNOWN"), side: String(row.side ?? "UNKNOWN"), regime: String(row.regime ?? "UNKNOWN"),
      gate_decision: String(row.gate_result ?? "UNKNOWN"), entry_hour_utc: utcHour(row.entry_ts), exit_hour_utc: utcHour(row.exit_ts),
      exit_reason: row.exit_reason === null ? null : String(row.exit_reason), pnl, fees, funding, result_r: resultR, mfe, mae, duration_s: duration,
    });
  }
  const dimensions: Record<LossAttributionDimension, Array<{ key: string; metrics: TrustedTradeMetrics }>> = {
    engine: grouped(eligible, row => row.engine), strategy: grouped(eligible, row => row.strategy),
    setup: grouped(eligible, row => row.setup), gateDecision: grouped(eligible, row => row.gate_decision),
    entryHourUtc: grouped(eligible, row => row.entry_hour_utc), exitHourUtc: grouped(eligible, row => row.exit_hour_utc),
    symbol: grouped(eligible, row => row.instrument), side: grouped(eligible, row => row.side),
    regime: grouped(eligible, row => row.regime), exitReason: grouped(eligible, row => row.exit_reason ?? "UNKNOWN"),
  };
  return {
    currency: "USDT" as const,
    generatedAt: new Date().toISOString(),
    windowStart: sinceIso,
    formulas: {
      netPnl: "exchange-confirmed trade pnl after fees and signed funding",
      grossPnl: "net pnl + fees - funding; reported only for complete valid NET evidence",
      expectancyR: "arithmetic mean of deterministic NET result_r",
      winRate: "trades with net pnl > 0 divided by complete valid NET trades",
      profitFactor: "sum of positive net pnl divided by absolute sum of negative net pnl; unavailable without losses",
    },
    accounting: {
      closedTrades: all.length, completeValidNetTrades: eligible.length,
      validButCorrupt: corruptEligibleCount,
      excludedByState: all.length - (stateCounts.VALID ?? 0),
      byEvidenceState: stateCounts,
    },
    overall: metrics(eligible),
    by: dimensions,
    unavailable: ["gate_decision_causality", "exchange_reported_spread", "exchange_reported_slippage"],
  };
}
