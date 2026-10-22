// Research-first economic gate for entry candidates. This module is
// deterministic and observation-only: it can classify an idea as economically
// unviable, but it never authorizes, blocks, resizes, or sends an order.
import type { Store } from "../memory/db.ts";
import { calculateExecutionCostR, type V2CostModel } from "./backtest.ts";
import { normalizePriceToTick } from "../exchange/okx/algo.ts";
import type { RegimeAxes } from "../market/regime.ts";

export type CostGateVerdict =
  | "ELIGIBLE_FOR_RESEARCH"
  | "NO_TRADE_COST_DOMINATED"
  | "NO_TRADE_INVALID_GEOMETRY"
  | "NO_TRADE_UNSUPPORTED_REGIME"
  | "UNPROVEN_EDGE"
  | "INSUFFICIENT_DATA";

export type CostEvidenceQuality = "ESTIMATED_ONLY" | "INSUFFICIENT_SAMPLE" | "HISTORICAL_SAMPLE";

export interface CostGateCosts {
  entryFeePct: number;
  exitFeePct: number;
  slippageBps: number;
  spreadBps: number;
  /** Positive means expected funding paid over the modeled hold; negative is a rebate. */
  fundingBps?: number;
}

export interface ConditionalProbabilityEvidence {
  sampleSize: number;
  wins: number;
  source: "HISTORICAL_NET_EVIDENCE";
  scope?: string;
  observedAt?: string;
}

export interface CostGateInput {
  instrument: string;
  engine: "SWING_15M" | "SCALP_5M";
  strategy: string;
  strategyCoreVersion?: number;
  strategyVersion?: number;
  side: "LONG" | "SHORT";
  entryPrice: number;
  stopPrice: number;
  takeProfitPrice: number;
  tickSize: number;
  lotSize?: number;
  minSize?: number;
  contractValue?: number;
  atr: number;
  atrPct: number;
  regime?: RegimeAxes;
  costs: CostGateCosts;
  /** Optional research-only regime support. Omitted means no regime veto. */
  supportedRegimes?: readonly string[];
  /** Optional calibrated conditional win probability. Without it no expected R is reported. */
  probability?: ConditionalProbabilityEvidence;
  maxCostToRiskRatio?: number;
  minConditionalSample?: number;
}

export interface CostAssessment {
  instrument: string;
  engine: "SWING_15M" | "SCALP_5M";
  strategy: string;
  strategyCoreVersion: number | null;
  strategyVersion: number | null;
  side: "LONG" | "SHORT";
  regime: RegimeAxes | null;
  verdict: CostGateVerdict;
  reason: string;
  grossRewardR: number | null;
  grossLossR: number | null;
  executionCostR: number | null;
  fundingCostR: number | null;
  netPayoutAtTpR: number | null;
  netPayoutAtSlR: number | null;
  costToRiskRatio: number | null;
  breakevenWinRate: number | null;
  expectedNetR: number | null;
  evidenceQuality: CostEvidenceQuality;
  calibration: {
    status: "ABSENT" | "INSUFFICIENT" | "VALIDATED";
    sampleSize: number;
    winRate: number | null;
    source: ConditionalProbabilityEvidence["source"] | null;
  };
  metadata: {
    tickSize: number | null;
    lotSize: number | null;
    minSize: number | null;
    contractValue: number | null;
  };
  normalizedPrices: {
    entryPrice: number;
    stopPrice: number;
    takeProfitPrice: number;
  } | null;
  volatility: { atr: number | null; atrPct: number | null };
  mode: "SHADOW";
  authorizationImpact: "NONE";
}

const DEFAULT_MAX_COST_TO_RISK = 0.35;
const DEFAULT_MIN_CONDITIONAL_SAMPLE = 100;

function finitePositive(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function round(value: number, digits = 6): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function assessmentBase(input: CostGateInput): Omit<CostAssessment,
  "verdict" | "reason" | "grossRewardR" | "grossLossR" | "executionCostR" | "fundingCostR" |
  "netPayoutAtTpR" | "netPayoutAtSlR" | "costToRiskRatio" | "breakevenWinRate" | "expectedNetR" |
  "evidenceQuality" | "calibration" | "normalizedPrices"> {
  return {
    instrument: input.instrument,
    engine: input.engine,
    strategy: input.strategy,
    strategyCoreVersion: Number.isFinite(input.strategyCoreVersion) ? Number(input.strategyCoreVersion) : null,
    strategyVersion: Number.isFinite(input.strategyVersion) ? Number(input.strategyVersion) : null,
    side: input.side,
    regime: input.regime ?? null,
    metadata: {
      tickSize: finitePositive(input.tickSize),
      lotSize: finitePositive(input.lotSize),
      minSize: finitePositive(input.minSize),
      contractValue: finitePositive(input.contractValue),
    },
    volatility: { atr: finitePositive(input.atr), atrPct: finitePositive(input.atrPct) },
    mode: "SHADOW",
    authorizationImpact: "NONE",
  };
}

function emptyCalibration(): CostAssessment["calibration"] {
  return { status: "ABSENT", sampleSize: 0, winRate: null, source: null };
}

function terminal(input: CostGateInput, verdict: CostGateVerdict, reason: string,
  extra: Partial<Pick<CostAssessment, "grossRewardR" | "grossLossR" | "executionCostR" | "fundingCostR" |
    "netPayoutAtTpR" | "netPayoutAtSlR" | "costToRiskRatio" | "breakevenWinRate" | "expectedNetR" |
    "normalizedPrices">> = {},
  calibration: CostAssessment["calibration"] = emptyCalibration(),
  evidenceQuality: CostEvidenceQuality = "ESTIMATED_ONLY"): CostAssessment {
  return {
    ...assessmentBase(input), verdict, reason,
    grossRewardR: extra.grossRewardR ?? null, grossLossR: extra.grossLossR ?? null,
    executionCostR: extra.executionCostR ?? null, fundingCostR: extra.fundingCostR ?? null,
    netPayoutAtTpR: extra.netPayoutAtTpR ?? null, netPayoutAtSlR: extra.netPayoutAtSlR ?? null,
    costToRiskRatio: extra.costToRiskRatio ?? null, breakevenWinRate: extra.breakevenWinRate ?? null,
    expectedNetR: extra.expectedNetR ?? null, evidenceQuality, calibration,
    normalizedPrices: extra.normalizedPrices ?? null,
  };
}

/**
 * Evaluate geometry, estimated execution costs, and optional calibrated
 * probability. The default answer is UNPROVEN_EDGE, never "profitable", until
 * a scoped historical probability with a sufficient sample is supplied.
 */
export function assessTradeEconomics(input: CostGateInput): CostAssessment {
  if (!input.instrument || !input.strategy || (input.side !== "LONG" && input.side !== "SHORT")) {
    return terminal(input, "INSUFFICIENT_DATA", "IDENTITY_UNAVAILABLE");
  }
  const tickSize = finitePositive(input.tickSize);
  const entry = finitePositive(input.entryPrice);
  const stop = finitePositive(input.stopPrice);
  const target = finitePositive(input.takeProfitPrice);
  const atr = finitePositive(input.atr);
  const atrPct = finitePositive(input.atrPct);
  if (tickSize === null || entry === null || stop === null || target === null || atr === null || atrPct === null) {
    return terminal(input, "INSUFFICIENT_DATA", "PRICE_OR_METADATA_UNAVAILABLE");
  }
  const costs = input.costs;
  if (![costs.entryFeePct, costs.exitFeePct, costs.slippageBps, costs.spreadBps].every((value) => Number.isFinite(value) && value >= 0)
    || !Number.isFinite(costs.fundingBps ?? 0)) {
    return terminal(input, "INSUFFICIENT_DATA", "COST_MODEL_INVALID");
  }
  const riskDistance = Math.abs(entry - stop);
  const longGeometry = stop < entry && entry < target;
  const shortGeometry = target < entry && entry < stop;
  if (!(riskDistance > 0) || (input.side === "LONG" ? !longGeometry : !shortGeometry)) {
    return terminal(input, "NO_TRADE_INVALID_GEOMETRY", input.side === "LONG" ? "LONG_GEOMETRY_INVALID" : "SHORT_GEOMETRY_INVALID");
  }
  // Match execution's conservative directional tick rounding: entry toward
  // the stop, stop away from entry, target toward entry. This never widens
  // intended stop risk. If normalization breaks geometry, reject explicitly.
  let normalizedPrices: CostAssessment["normalizedPrices"];
  try {
    const tick = String(tickSize);
    const executableEntry = Number(normalizePriceToTick(entry, tick, input.side === "LONG" ? "down" : "up"));
    const executableStop = Number(normalizePriceToTick(stop, tick, input.side === "LONG" ? "up" : "down"));
    const executableTarget = Number(normalizePriceToTick(target, tick, input.side === "LONG" ? "down" : "up"));
    normalizedPrices = { entryPrice: executableEntry, stopPrice: executableStop, takeProfitPrice: executableTarget };
  } catch {
    return terminal(input, "NO_TRADE_INVALID_GEOMETRY", "TICK_NORMALIZATION_FAILED");
  }
  const executableRisk = Math.abs(normalizedPrices.entryPrice - normalizedPrices.stopPrice);
  const executableLong = normalizedPrices.stopPrice < normalizedPrices.entryPrice
    && normalizedPrices.entryPrice < normalizedPrices.takeProfitPrice;
  const executableShort = normalizedPrices.takeProfitPrice < normalizedPrices.entryPrice
    && normalizedPrices.entryPrice < normalizedPrices.stopPrice;
  if (!(executableRisk > 0) || (input.side === "LONG" ? !executableLong : !executableShort)) {
    return terminal(input, "NO_TRADE_INVALID_GEOMETRY", "NORMALIZED_GEOMETRY_INVALID", { normalizedPrices });
  }
  if (input.supportedRegimes && input.supportedRegimes.length > 0) {
    const label = input.regime ? `${input.regime.trend}:${input.regime.volatility}` : "UNKNOWN";
    const allowed = input.supportedRegimes.includes(label)
      || (input.regime !== undefined && input.supportedRegimes.includes(input.regime.trend));
    if (!allowed) {
      return terminal(input, "NO_TRADE_UNSUPPORTED_REGIME", `REGIME_${label}_UNSUPPORTED`);
    }
  }

  const model: V2CostModel = {
    entryFeePct: costs.entryFeePct, exitFeePct: costs.exitFeePct,
    slippageBps: costs.slippageBps, spreadBps: costs.spreadBps,
    slPlus: { enabled: false, activationR: 1, lockInR: 0, minProfitBufferPct: 0 },
  };
  const executableEntry = normalizedPrices.entryPrice;
  const executableStop = normalizedPrices.stopPrice;
  const executableTarget = normalizedPrices.takeProfitPrice;
  const grossRewardR = Math.abs(executableTarget - executableEntry) / executableRisk;
  const grossLossR = 1;
  const costAtTpR = calculateExecutionCostR(executableEntry, executableTarget, executableRisk, model);
  const costAtSlR = calculateExecutionCostR(executableEntry, executableStop, executableRisk, model);
  const fundingCostR = executableEntry * (costs.fundingBps ?? 0) / 10_000 / executableRisk;
  const netPayoutAtTpR = grossRewardR - costAtTpR - fundingCostR;
  const netPayoutAtSlR = -grossLossR - costAtSlR - fundingCostR;
  const executionCostR = Math.max(costAtTpR, costAtSlR);
  const costToRiskRatio = executionCostR + Math.max(0, fundingCostR);
  const maxCost = input.maxCostToRiskRatio ?? DEFAULT_MAX_COST_TO_RISK;
  const breakevenWinRate = netPayoutAtTpR > netPayoutAtSlR
    ? Math.max(0, Math.min(1, -netPayoutAtSlR / (netPayoutAtTpR - netPayoutAtSlR)))
    : null;
  const base = {
    grossRewardR: round(grossRewardR), grossLossR, executionCostR: round(executionCostR),
    fundingCostR: round(fundingCostR), netPayoutAtTpR: round(netPayoutAtTpR),
    netPayoutAtSlR: round(netPayoutAtSlR), costToRiskRatio: round(costToRiskRatio),
    breakevenWinRate: breakevenWinRate === null ? null : round(breakevenWinRate),
    normalizedPrices,
  };

  if (!(maxCost > 0) || !Number.isFinite(maxCost)) {
    return terminal(input, "INSUFFICIENT_DATA", "COST_THRESHOLD_INVALID", base);
  }
  if (!(netPayoutAtTpR > 0) || costToRiskRatio >= maxCost) {
    return terminal(input, "NO_TRADE_COST_DOMINATED",
      !(netPayoutAtTpR > 0) ? "GROSS_REWARD_DOES_NOT_COVER_COSTS" : "COST_TO_RISK_EXCEEDS_LIMIT",
      base, emptyCalibration(), "ESTIMATED_ONLY");
  }

  const probability = input.probability;
  if (!probability) {
    return terminal(input, "UNPROVEN_EDGE", "NO_CALIBRATED_CONDITIONAL_PROBABILITY", base,
      emptyCalibration(), "ESTIMATED_ONLY");
  }
  const sampleSize = Number(probability.sampleSize);
  const wins = Number(probability.wins);
  const minSample = input.minConditionalSample ?? DEFAULT_MIN_CONDITIONAL_SAMPLE;
  if (!Number.isInteger(sampleSize) || !Number.isInteger(wins) || sampleSize < 1 || wins < 0 || wins > sampleSize
    || !Number.isInteger(minSample) || minSample < 1) {
    return terminal(input, "INSUFFICIENT_DATA", "CONDITIONAL_PROBABILITY_INVALID", base,
      emptyCalibration(), "INSUFFICIENT_SAMPLE");
  }
  const winRate = wins / sampleSize;
  const calibration: CostAssessment["calibration"] = {
    status: sampleSize < minSample ? "INSUFFICIENT" : "VALIDATED",
    sampleSize, winRate: round(winRate), source: probability.source,
  };
  if (calibration.status === "INSUFFICIENT") {
    return terminal(input, "UNPROVEN_EDGE", `CALIBRATION_SAMPLE_${sampleSize}_BELOW_${minSample}`, base,
      calibration, "INSUFFICIENT_SAMPLE");
  }
  const expectedNetR = winRate * netPayoutAtTpR + (1 - winRate) * netPayoutAtSlR;
  if (!(expectedNetR > 0)) {
    return terminal(input, "UNPROVEN_EDGE", "CALIBRATED_EXPECTANCY_NOT_POSITIVE",
      { ...base, expectedNetR: round(expectedNetR) }, calibration, "HISTORICAL_SAMPLE");
  }
  return terminal(input, "ELIGIBLE_FOR_RESEARCH", "POSITIVE_CALIBRATED_AFTER_COST_EXPECTANCY",
    { ...base, expectedNetR: round(expectedNetR) }, calibration, "HISTORICAL_SAMPLE");
}

export function recordCostAssessment(store: Store, assessment: CostAssessment): void {
  store.db.prepare(`INSERT INTO cost_gate_assessments
    (ts,instrument,engine,strategy,strategy_core_version,strategy_version,side,regime,verdict,
     net_payout_tp_r,net_payout_sl_r,cost_to_risk,evidence_quality,payload)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    new Date().toISOString(), assessment.instrument, assessment.engine, assessment.strategy,
    assessment.strategyCoreVersion, assessment.strategyVersion, assessment.side,
    assessment.regime ? `${assessment.regime.trend}:${assessment.regime.volatility}` : null,
    assessment.verdict, assessment.netPayoutAtTpR, assessment.netPayoutAtSlR,
    assessment.costToRiskRatio, assessment.evidenceQuality, JSON.stringify(assessment),
  );
}

export interface StoredCostAssessment {
  id: number;
  ts: string;
  instrument: string;
  engine: string;
  strategy: string;
  strategyCoreVersion: number | null;
  strategyVersion: number | null;
  side: string;
  regime: string | null;
  verdict: CostGateVerdict;
  netPayoutAtTpR: number | null;
  netPayoutAtSlR: number | null;
  costToRiskRatio: number | null;
  evidenceQuality: CostEvidenceQuality;
}

export function listCostAssessments(store: Store, limit = 100): StoredCostAssessment[] {
  const safeLimit = Math.max(1, Math.min(500, Math.floor(limit)));
  const rows = store.db.prepare(`SELECT id,ts,instrument,engine,strategy,strategy_core_version,strategy_version,
      side,regime,verdict,net_payout_tp_r,net_payout_sl_r,cost_to_risk,evidence_quality
    FROM cost_gate_assessments ORDER BY id DESC LIMIT ?`).all(safeLimit) as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    id: Number(row.id), ts: String(row.ts), instrument: String(row.instrument), engine: String(row.engine),
    strategy: String(row.strategy), strategyCoreVersion: row.strategy_core_version === null ? null : Number(row.strategy_core_version),
    strategyVersion: row.strategy_version === null ? null : Number(row.strategy_version),
    side: String(row.side), regime: row.regime === null ? null : String(row.regime),
    verdict: String(row.verdict) as CostGateVerdict,
    netPayoutAtTpR: row.net_payout_tp_r === null ? null : Number(row.net_payout_tp_r),
    netPayoutAtSlR: row.net_payout_sl_r === null ? null : Number(row.net_payout_sl_r),
    costToRiskRatio: row.cost_to_risk === null ? null : Number(row.cost_to_risk),
    evidenceQuality: String(row.evidence_quality) as CostEvidenceQuality,
  }));
}

export function summarizeCostAssessments(store: Store, sinceIso: string | null = null) {
  const rows = store.db.prepare(`SELECT verdict,COUNT(*) c FROM cost_gate_assessments
    WHERE (? IS NULL OR ts>=?) GROUP BY verdict`).all(sinceIso, sinceIso) as Array<{ verdict: string; c: number }>;
  const byVerdict = Object.fromEntries(rows.map((row) => [row.verdict, Number(row.c)]));
  const total = rows.reduce((sum, row) => sum + Number(row.c), 0);
  return { mode: "SHADOW" as const, authorizationImpact: "NONE" as const,
    total, byVerdict, recent: listCostAssessments(store, 60) };
}
