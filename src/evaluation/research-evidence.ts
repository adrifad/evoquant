// M4 — reproducible research evidence. Every verdict is derived from supplied
// trades, never from LLM confidence. An insufficient sample is returned as
// INSUFFICIENT_EVIDENCE instead of being promoted or silently rejected.
import { summarize, type PerfSummary } from "./performance.ts";
import type { ResearchBacktestResult, ResearchTrade, ResearchValidationResult } from "./research-strategies.ts";
import type { ResearchFundingModel } from "./research-funding.ts";

export type ResearchEvidenceVerdict =
  | "ELIGIBLE_FOR_RESEARCH"
  | "UNPROVEN_EDGE"
  | "NO_TRADE_COST_DOMINATED"
  | "INSUFFICIENT_EVIDENCE";

export type FundingStressMode = "SIGNED" | "ADVERSE_ABSOLUTE";

export interface CostSensitivityPoint {
  costMultiplier: number;
  feesR: number;
  fundingR: number;
  totalCostR: number;
  fundingStress: FundingStressMode;
  summary: PerfSummary;
}

export interface ResearchEvidenceAssessment {
  verdict: ResearchEvidenceVerdict;
  reason: string;
  sample: number;
  minimumSample: number;
  netExpectancyR: number | null;
  grossExpectancyR: number | null;
  profitFactor: number | null;
  maxDrawdownPct: number | null;
  costSensitivity: CostSensitivityPoint[];
  outOfSample: {
    available: boolean;
    trades: number;
    expectancyR: number | null;
    positiveSymbols: number;
    evaluatedSymbols: number;
    positiveRollingFolds: number;
    rollingFolds: number;
  };
  excludedDataEnd: {
    backtest: number;
    legacyTrades: number;
    train: number;
    outOfSample: number;
    rolling: number;
  };
  fundingAssumption: ResearchFundingModel | null;
  promotionEligible: boolean;
  reasons: string[];
}

export interface ResearchEvidenceOptions {
  minimumSample?: number;
  minimumOutOfSampleSample?: number;
  costMultipliers?: readonly number[];
}

function realizedTrades(result: ResearchBacktestResult): ResearchTrade[] {
  return result.trades.filter((trade) => String(trade.exitReason) !== "DATA_END");
}

interface ScenarioCost { feesR: number; fundingR: number; totalCostR: number }

/**
 * Stress scenarios above 1x never improve a trade through a funding rebate:
 * the signed rebate is replaced by its absolute value as an adverse cost.
 * Fees remain strictly non-negative in every scenario.
 */
function scenarioCost(trade: ResearchTrade, multiplier: number): ScenarioCost {
  const feeCost = Math.max(0, trade.feesR) * multiplier;
  const fundingCost = multiplier > 1
    ? Math.abs(trade.fundingR) * multiplier
    : trade.fundingR * multiplier;
  return { feesR: feeCost, fundingR: fundingCost, totalCostR: feeCost + fundingCost };
}

/** Cost sensitivity removes, applies, or adversely doubles modeled costs. */
export function costSensitivity(trades: readonly ResearchTrade[], multipliers: readonly number[] = [0, 1, 2]): CostSensitivityPoint[] {
  const realized = trades.filter((trade) => String(trade.exitReason) !== "DATA_END");
  return multipliers.filter((value) => Number.isFinite(value) && value >= 0).sort((a, b) => a - b)
    .map((costMultiplier) => {
      const costs = realized.map((trade) => scenarioCost(trade, costMultiplier));
      const feesR = costs.reduce((sum, cost) => sum + cost.feesR, 0);
      const fundingR = costs.reduce((sum, cost) => sum + cost.fundingR, 0);
      const totalCostR = costs.reduce((sum, cost) => sum + cost.totalCostR, 0);
      const summary = summarize(realized.map((trade, index) => trade.grossR - costs[index]!.totalCostR));
      return { costMultiplier, fundingStress: costMultiplier > 1 ? "ADVERSE_ABSOLUTE" : "SIGNED",
        feesR: Math.round(feesR * 1_000_000) / 1_000_000,
        fundingR: Math.round(fundingR * 1_000_000) / 1_000_000,
        totalCostR: Math.round(totalCostR * 1_000_000) / 1_000_000,
        summary };
    });
}

export function assessResearchEvidence(result: ResearchBacktestResult,
  validation?: ResearchValidationResult, options: ResearchEvidenceOptions = {}): ResearchEvidenceAssessment {
  const minimumSample = options.minimumSample ?? 30;
  const minimumOos = options.minimumOutOfSampleSample ?? 15;
  const realized = realizedTrades(result);
  // Recompute from resolved trades so a legacy DATA_END row can never enter
  // expectancy, even if a caller supplied a stale summary.
  const summary = summarize(realized.map((trade) => trade.resultR));
  const sensitivity = costSensitivity(realized, options.costMultipliers ?? [0, 1, 2]);
  const gross = sensitivity.find((point) => point.costMultiplier === 0)?.summary.expectancy_r ?? null;
  const net = summary.expectancy_r;
  const oosSummary = validation?.outOfSample.summary;
  const oosTrades = oosSummary?.trades ?? 0;
  const oosExpectancy = oosSummary ? oosSummary.expectancy_r : null;
  const reasons: string[] = [];
  const legacyDataEnd = result.trades.filter((trade) => String(trade.exitReason) === "DATA_END").length;
  const excludedDataEnd = {
    backtest: (result.unresolvedTrades?.length ?? 0) + legacyDataEnd,
    legacyTrades: legacyDataEnd,
    train: validation?.counts.excludedDataEnd.train ?? 0,
    outOfSample: validation?.counts.excludedDataEnd.outOfSample ?? 0,
    rolling: validation?.counts.excludedDataEnd.rolling ?? 0,
  };
  if (excludedDataEnd.backtest > 0) reasons.push(`DATA_END_UNRESOLVED_EXCLUDED_${excludedDataEnd.backtest}`);
  let verdict: ResearchEvidenceVerdict = "ELIGIBLE_FOR_RESEARCH";
  let reason = "SYNTHETIC_AFTER_COST_EDGE";

  if (summary.trades < minimumSample) {
    verdict = "INSUFFICIENT_EVIDENCE";
    reason = `SAMPLE_${summary.trades}_BELOW_${minimumSample}`;
    reasons.push(reason);
  } else if (!(net > 0)) {
    if (gross !== null && gross > 0) {
      verdict = "NO_TRADE_COST_DOMINATED";
      reason = "GROSS_POSITIVE_AFTER_COST_NON_POSITIVE";
    } else {
      verdict = "UNPROVEN_EDGE";
      reason = "NON_POSITIVE_EXPECTANCY";
    }
    reasons.push(reason);
  }
  if (validation) {
    if (oosTrades < minimumOos) {
      reasons.push(`OUT_OF_SAMPLE_${oosTrades}_BELOW_${minimumOos}`);
      if (verdict === "ELIGIBLE_FOR_RESEARCH") {
        verdict = "INSUFFICIENT_EVIDENCE";
        reason = `OUT_OF_SAMPLE_${oosTrades}_BELOW_${minimumOos}`;
      }
    } else if (oosExpectancy !== null && !(oosExpectancy > 0)) {
      reasons.push("OUT_OF_SAMPLE_NOT_POSITIVE");
      if (verdict === "ELIGIBLE_FOR_RESEARCH") {
        verdict = "UNPROVEN_EDGE";
        reason = "OUT_OF_SAMPLE_NOT_POSITIVE";
      }
    }
    if (validation.rolling.folds > 0 && validation.rolling.positiveFolds / validation.rolling.folds < 0.5) {
      reasons.push("WALK_FORWARD_MAJORITY_NOT_POSITIVE");
      if (verdict === "ELIGIBLE_FOR_RESEARCH") {
        verdict = "UNPROVEN_EDGE";
        reason = "WALK_FORWARD_MAJORITY_NOT_POSITIVE";
      }
    }
    if (validation.train.summary.trades + validation.outOfSample.summary.trades < minimumSample) {
      reasons.push("COMBINED_TRAIN_AND_OUT_OF_SAMPLE_SAMPLE_INSUFFICIENT");
      if (verdict === "ELIGIBLE_FOR_RESEARCH") {
        verdict = "INSUFFICIENT_EVIDENCE";
        reason = "COMBINED_TRAIN_AND_OUT_OF_SAMPLE_SAMPLE_INSUFFICIENT";
      }
    }
  }
  const doubledCost = sensitivity.find((point) => point.costMultiplier === 2)?.summary.expectancy_r ?? null;
  const promotionEligible = verdict === "ELIGIBLE_FOR_RESEARCH"
    && oosTrades >= minimumOos && (oosExpectancy ?? -Infinity) > 0
    && doubledCost !== null && doubledCost > 0;
  return {
    verdict, reason,
    sample: summary.trades, minimumSample,
    netExpectancyR: net, grossExpectancyR: gross,
    profitFactor: Number.isFinite(summary.profit_factor) ? summary.profit_factor : null,
    maxDrawdownPct: summary.max_drawdown_pct,
    costSensitivity: sensitivity,
    outOfSample: {
      available: validation !== undefined,
      trades: oosTrades,
      expectancyR: oosExpectancy ?? null,
      positiveSymbols: validation?.metrics.positiveSymbols ?? 0,
      evaluatedSymbols: validation?.metrics.evaluatedSymbols ?? 0,
      positiveRollingFolds: validation?.rolling.positiveFolds ?? 0,
      rollingFolds: validation?.rolling.folds ?? 0,
    },
    excludedDataEnd,
    fundingAssumption: result.funding ?? validation?.funding ?? null,
    promotionEligible,
    reasons: [...new Set(reasons)],
  };
}

export interface ResearchComparison {
  verdict: ResearchEvidenceVerdict;
  promoted: boolean;
  reasons: string[];
  champion: ResearchEvidenceAssessment;
  challenger: ResearchEvidenceAssessment;
}

/**
 * A challenger must be independently eligible, survive doubled costs, and have
 * a positive out-of-sample cohort. Beating a losing champion is not enough.
 */
export function compareResearchEvidence(champion: ResearchBacktestResult, challenger: ResearchBacktestResult,
  championValidation?: ResearchValidationResult, challengerValidation?: ResearchValidationResult,
  options: ResearchEvidenceOptions = {}): ResearchComparison {
  const championAssessment = assessResearchEvidence(champion, championValidation, options);
  const challengerAssessment = assessResearchEvidence(challenger, challengerValidation, options);
  const reasons: string[] = [];
  if (championAssessment.verdict === "INSUFFICIENT_EVIDENCE" || challengerAssessment.verdict === "INSUFFICIENT_EVIDENCE") {
    return { verdict: "INSUFFICIENT_EVIDENCE", promoted: false,
      reasons: ["MATCHED_SAMPLE_INSUFFICIENT"], champion: championAssessment, challenger: challengerAssessment };
  }
  if (challengerAssessment.verdict !== "ELIGIBLE_FOR_RESEARCH") {
    reasons.push(`CHALLENGER_${challengerAssessment.verdict}`);
    return { verdict: challengerAssessment.verdict, promoted: false, reasons, champion: championAssessment, challenger: challengerAssessment };
  }
  if (!challengerAssessment.promotionEligible) {
    reasons.push("CHALLENGER_NOT_INDEPENDENTLY_VALIDATED");
    return { verdict: "UNPROVEN_EDGE", promoted: false, reasons, champion: championAssessment, challenger: challengerAssessment };
  }
  const championExpectancy = championAssessment.netExpectancyR ?? -Infinity;
  const challengerExpectancy = challengerAssessment.netExpectancyR ?? -Infinity;
  if (!(challengerExpectancy > championExpectancy)) {
    reasons.push("CHALLENGER_EXPECTANCY_NOT_BETTER");
    return { verdict: "UNPROVEN_EDGE", promoted: false, reasons, champion: championAssessment, challenger: challengerAssessment };
  }
  return { verdict: "ELIGIBLE_FOR_RESEARCH", promoted: true,
    reasons: ["CHALLENGER_INDEPENDENTLY_ELIGIBLE", "OUT_OF_SAMPLE_POSITIVE", "DOUBLED_COST_SURVIVAL", "EXPECTANCY_BETTER"],
    champion: championAssessment, challenger: challengerAssessment };
}
