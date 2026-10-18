import type { DecisionMemoryContext } from "../memory/decision-context.ts";
import { validateMemoryCitations } from "../memory/decision-context.ts";
import type { Regime } from "../market/regime.ts";
import type { TradeCandidate } from "../strategy/core-v2.ts";

export type GateDenyBasis = "MARKET" | "MEMORY" | "MIXED";
export type GatePolicyDisposition = "ACCEPT" | "IGNORE_UNSUPPORTED_MEMORY_VETO" | "UNSUPPORTED_DENY" | "MEMORY_CITATION_INVALID";

export interface GateVetoPolicyInput {
  verdict: "ALLOW" | "DENY";
  denyBasis?: GateDenyBasis;
  citedMemory: string[];
  marketEvidenceRefs: string[];
  memory: DecisionMemoryContext | null;
  /** Model prose is accepted as explanatory output only; the evaluator never reads it. */
  reasoning?: string[];
  /** IDs generated from deterministic facts in the exact request context. */
  verifiedMarketEvidence: ReadonlySet<string>;
}

export type GateVetoPolicyResult =
  | { kind: "ACCEPT"; verdict: "ALLOW" | "DENY"; basis?: GateDenyBasis }
  | { kind: "IGNORE_UNSUPPORTED_MEMORY_VETO"; reason: "INSUFFICIENT_EXACT_SAMPLE" | "NON_NEGATIVE_NET_EXPECTANCY" }
  | { kind: "UNSUPPORTED_DENY"; reason: "MISSING_ATTRIBUTION" | "UNVERIFIED_MARKET_EVIDENCE" | "NO_QUALIFYING_BASIS" }
  | { kind: "MEMORY_CITATION_INVALID"; reason: "CITATION_NOT_IN_REQUEST" };

function addRegimeEvidence(out: Set<string>, regime: Regime, side: "LONG" | "SHORT"): void {
  if ((regime === "TRENDING_BULLISH" && side === "SHORT")
    || (regime === "TRENDING_BEARISH" && side === "LONG")) out.add("regime_direction_conflict");
  if (regime === "HIGH_VOLATILITY") out.add("high_volatility_regime");
  if (regime === "LOW_VOLATILITY") out.add("low_volatility_regime");
  if (regime === "UNKNOWN") out.add("unknown_regime");
}

/** Market references are minted only for concrete request facts that meet the stated predicate. */
export function swingVerifiedMarketEvidence(candidate: TradeCandidate, regime: Regime): Set<string> {
  const refs = new Set<string>();
  // A counter-trend setup is an expected Mean Reversion condition, so only
  // trend-following families can use this directional conflict as a veto fact.
  if (candidate.strategy === "TREND_FOLLOWING_V2" || candidate.strategy === "BREAKOUT_V2") {
    addRegimeEvidence(refs, regime, candidate.side);
  } else {
    if (regime === "HIGH_VOLATILITY") refs.add("high_volatility_regime");
    if (regime === "LOW_VOLATILITY") refs.add("low_volatility_regime");
    if (regime === "UNKNOWN") refs.add("unknown_regime");
  }
  if (candidate.regime.volatility === "HIGH") refs.add("high_volatility_regime");
  if (candidate.regime.volatility === "LOW") refs.add("low_volatility_regime");
  if (candidate.regime.trend === "UNKNOWN") refs.add("unknown_regime");
  if (!candidate.features.sufficientData) refs.add("insufficient_features");
  for (const condition of candidate.conditions) {
    if (!condition.passed && /^[A-Za-z0-9_-]{1,50}$/.test(condition.name)) refs.add(`failed_condition:${condition.name}`);
  }
  return refs;
}

export function scalpVerifiedMarketEvidence(input: {
  side: "LONG" | "SHORT"; regime: Regime; atrPct15m: number; sufficientData?: boolean;
}): Set<string> {
  const refs = new Set<string>();
  addRegimeEvidence(refs, input.regime, input.side);
  if (input.atrPct15m < 0.08 || input.atrPct15m > 0.8) refs.add("atr15_outside_operating_band");
  if (input.sufficientData === false) refs.add("insufficient_features");
  return refs;
}

function marketEvidenceVerified(refs: string[], available: ReadonlySet<string>): boolean {
  return refs.length > 0 && new Set(refs).size === refs.length && refs.every((ref) => available.has(ref));
}

function exactMemoryHasStrongNegativeEvidence(citations: string[], memory: DecisionMemoryContext): boolean {
  if (!citations.includes("S1")) return false;
  const exact = memory.stats.find((stat) => stat.id === "S1");
  return exact !== undefined && exact.trades >= 30 && exact.expectancy_r !== null && exact.expectancy_r < 0;
}

/**
 * Validate a schema-valid model decision against request-bound evidence.
 * Free text and self-declared attribution never establish market evidence.
 */
export function evaluateGateVetoPolicy(input: GateVetoPolicyInput): GateVetoPolicyResult {
  // Supporting references have no veto authority on ALLOW and cannot turn it
  // into a rejection. Gate adapters omit such non-operative citations from audit.
  if (input.verdict === "ALLOW") return { kind: "ACCEPT", verdict: "ALLOW" };

  // Memory-disabled requests retain the pre-memory ALLOW/DENY contract.
  if (!input.memory) return { kind: "ACCEPT", verdict: "DENY" };
  if (!validateMemoryCitations(input.citedMemory, input.memory)) {
    return { kind: "MEMORY_CITATION_INVALID", reason: "CITATION_NOT_IN_REQUEST" };
  }

  const hasVerifiedMarket = marketEvidenceVerified(input.marketEvidenceRefs, input.verifiedMarketEvidence);
  const hasClaimedButUnverifiedMarket = input.marketEvidenceRefs.length > 0 && !hasVerifiedMarket;
  const strongMemory = exactMemoryHasStrongNegativeEvidence(input.citedMemory, input.memory);

  // The reference is accepted only after the runtime independently confirms
  // that its request-bound market fact satisfies the corresponding predicate.
  // A model label cannot weaken or strengthen that verification.
  if (hasVerifiedMarket) return { kind: "ACCEPT", verdict: "DENY",
    basis: strongMemory ? "MIXED" : "MARKET" };

  if (input.denyBasis === "MARKET") {
    return { kind: "UNSUPPORTED_DENY", reason: "UNVERIFIED_MARKET_EVIDENCE" };
  }
  if (input.denyBasis === "MIXED") {
    if (strongMemory) return { kind: "ACCEPT", verdict: "DENY", basis: "MEMORY" };
    return { kind: "UNSUPPORTED_DENY", reason: hasClaimedButUnverifiedMarket ? "UNVERIFIED_MARKET_EVIDENCE" : "NO_QUALIFYING_BASIS" };
  }
  if (input.denyBasis === "MEMORY") {
    if (input.marketEvidenceRefs.length > 0) {
      if (strongMemory) return { kind: "ACCEPT", verdict: "DENY", basis: "MEMORY" };
      return { kind: "UNSUPPORTED_DENY", reason: "UNVERIFIED_MARKET_EVIDENCE" };
    }
    if (strongMemory) return { kind: "ACCEPT", verdict: "DENY", basis: "MEMORY" };
    if (input.citedMemory.length > 0) {
      const exact = input.memory.stats.find((stat) => stat.id === "S1");
      return { kind: "IGNORE_UNSUPPORTED_MEMORY_VETO", reason: exact && exact.trades >= 30
        ? "NON_NEGATIVE_NET_EXPECTANCY" : "INSUFFICIENT_EXACT_SAMPLE" };
    }
    return { kind: "UNSUPPORTED_DENY", reason: "NO_QUALIFYING_BASIS" };
  }

  // Without explicit attribution, independently verified market evidence is
  // still sufficient. Memory-driven denial requires explicit attribution.
  if (hasVerifiedMarket) return { kind: "ACCEPT", verdict: "DENY", basis: "MARKET" };
  return { kind: "UNSUPPORTED_DENY", reason: input.marketEvidenceRefs.length > 0 || hasClaimedButUnverifiedMarket
    ? "UNVERIFIED_MARKET_EVIDENCE" : "MISSING_ATTRIBUTION" };
}
