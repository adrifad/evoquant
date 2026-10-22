// Deterministic research funding model. Positive configured rates mean longs
// pay and shorts receive at each settlement; the model is applied once per
// settlement actually crossed by the holding interval.
export type ResearchFundingSource = "CONFIGURED_CONSERVATIVE_ESTIMATE" | "HISTORICAL" | "DISABLED";

export interface ResearchFundingModel {
  enabled: boolean;
  /** Signed rate in basis points per settlement; positive means longs pay. */
  rateBpsPerSettlement: number;
  settlementIntervalHours: number;
  source: ResearchFundingSource;
}

export const DEFAULT_RESEARCH_FUNDING: ResearchFundingModel = {
  enabled: true,
  rateBpsPerSettlement: 1,
  settlementIntervalHours: 8,
  source: "CONFIGURED_CONSERVATIVE_ESTIMATE",
};

export interface ResearchFundingCharge {
  settlements: number;
  rateBps: number;
  fundingR: number;
}

/** Count settlement timestamps in (entryTs, exitTs]. Intervals align to UTC. */
export function fundingSettlementCount(entryTs: number, exitTs: number, settlementIntervalHours: number): number {
  if (![entryTs, exitTs].every(Number.isFinite) || !(exitTs > entryTs)
    || !Number.isFinite(settlementIntervalHours) || settlementIntervalHours <= 0) return 0;
  const intervalMs = settlementIntervalHours * 3_600_000;
  const firstSettlement = Math.floor(entryTs / intervalMs) * intervalMs + intervalMs;
  if (exitTs < firstSettlement) return 0;
  return Math.floor((exitTs - firstSettlement) / intervalMs) + 1;
}

export function researchFundingCharge(input: {
  side: "LONG" | "SHORT";
  entryPrice: number;
  riskDistance: number;
  entryTs: number;
  exitTs: number;
  funding?: ResearchFundingModel;
}): ResearchFundingCharge {
  const funding = input.funding ?? DEFAULT_RESEARCH_FUNDING;
  if (!funding.enabled) return { settlements: 0, rateBps: 0, fundingR: 0 };
  if (!(input.entryPrice > 0) || !(input.riskDistance > 0) || !Number.isFinite(funding.rateBpsPerSettlement)
    || !Number.isFinite(funding.settlementIntervalHours) || funding.settlementIntervalHours <= 0) {
    return { settlements: 0, rateBps: 0, fundingR: 0 };
  }
  const settlements = fundingSettlementCount(input.entryTs, input.exitTs, funding.settlementIntervalHours);
  // Positive rate: longs pay, shorts receive. The signed R is a cost for LONG
  // and a rebate for SHORT, exactly once per settlement in the interval.
  const rateBps = funding.rateBpsPerSettlement * (input.side === "LONG" ? 1 : -1);
  const fundingR = input.entryPrice * rateBps / 10_000 * settlements / input.riskDistance;
  return { settlements, rateBps: Math.round(rateBps * 1_000_000) / 1_000_000,
    fundingR: Math.round(fundingR * 1_000_000) / 1_000_000 };
}

export function researchFundingFromConfig(input: unknown): ResearchFundingModel {
  const raw = input && typeof input === "object" ? input as { research_funding?: Record<string, unknown> } : {};
  const section = raw.research_funding;
  if (!section) return { ...DEFAULT_RESEARCH_FUNDING };
  const enabled = section.enabled === undefined ? true : section.enabled === true;
  const rate = Number(section.rate_bps_per_settlement ?? DEFAULT_RESEARCH_FUNDING.rateBpsPerSettlement);
  const interval = Number(section.settlement_interval_hours ?? DEFAULT_RESEARCH_FUNDING.settlementIntervalHours);
  if (!Number.isFinite(rate) || Math.abs(rate) > 1_000) throw new Error("invalid research funding rate");
  if (!Number.isFinite(interval) || interval <= 0 || interval > 168) throw new Error("invalid research funding settlement interval");
  const source = section.source === "HISTORICAL" || section.source === "DISABLED" || section.source === "CONFIGURED_CONSERVATIVE_ESTIMATE"
    ? section.source : DEFAULT_RESEARCH_FUNDING.source;
  return { enabled, rateBpsPerSettlement: rate, settlementIntervalHours: interval,
    source: enabled ? source : "DISABLED" };
}
