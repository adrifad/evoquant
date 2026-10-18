// M3 (§21/§37) — Decision Agent: LLM proposes; invalid output ⇒ HOLD.
// The agent NEVER sizes or executes — that is Risk Engine + executor (§2.1).
import { readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { FeatureSnapshot } from "../market/features.ts";
import type { Regime } from "../market/regime.ts";
import type { RoleLlmService } from "../core/llm-role-service.ts";
import type { StrategyDef } from "../strategy/library.ts";
import type { Store } from "../memory/db.ts";
import type { TradeCandidate } from "../strategy/core-v2.ts";
import { identityForV2 } from "../strategy/identity.ts";
import { buildDecisionContext, decisionMemoryFingerprint, serializeDecisionContext, type DecisionMemoryContext } from "../memory/decision-context.ts";
import { gateMemoryEnabled } from "../core/gate-memory.ts";
import { createLogger } from "../core/logger.ts";
import { evaluateGateVetoPolicy, swingVerifiedMarketEvidence, type GateDenyBasis, type GatePolicyDisposition } from "./gate-veto-policy.ts";

export const DecisionSchema = z.object({
  decision: z.enum(["LONG", "SHORT", "HOLD", "CLOSE"]),
  strategy: z.string().nullable().optional(),
  confidence: z.number().min(0).max(1),
  thesis: z.array(z.string()).default([]),
  invalidations: z.array(z.string()).default([]),
  suggested_stop_atr: z.number().min(0).max(5).default(1.5),
  suggested_take_profit_atr: z.number().min(0).max(10).default(3.0),
});
export type Decision = z.infer<typeof DecisionSchema>;

export const CandidateGateSchema = z.object({
  verdict: z.enum(["ALLOW", "DENY"]),
  confidence: z.number().min(0).max(1),
  reasoning: z.array(z.string().max(500)).max(5).default([]),
  risk_flags: z.array(z.string().max(250)).max(5).default([]),
  cited_memory: z.array(z.string().max(64)).max(3).default([]),
  deny_basis: z.enum(["MARKET", "MEMORY", "MIXED"]).optional(),
  market_evidence_refs: z.array(z.string().max(80)).max(5).optional(),
}).strict();
export type CandidateGate = z.infer<typeof CandidateGateSchema>;
export type CandidateGateResult = CandidateGate & { contextRef: string; memoryFingerprint: string | null;
  policyDisposition: GatePolicyDisposition; effectiveVerdict: "ALLOW" | "DENY";
  memorySampleCounts: { s1: number; s2: number } | null; policyReason?: string };
const gateLog = createLogger("candidate-gate");

/** LLM may veto or allow only; candidate side, strategy and geometry are immutable. */
export async function gateCandidate(root: string, roles: RoleLlmService, candidate: TradeCandidate, store?: Store,
  marketRegime?: Regime, onContextRef?: (contextRef: string) => void): Promise<CandidateGateResult | null> {
  let prompt = readFileSync(path.join(root, "prompts/candidate-gate.md"), "utf8");
  const payload: Record<string, unknown> = {
    instrument: candidate.instrument, engine: candidate.engine, strategy: candidate.strategy,
    version: candidate.strategyVersion, side: candidate.side, setup_score: candidate.setupScore,
    entry: candidate.entryPrice, stop: candidate.stopPrice, take_profit: candidate.takeProfitPrice,
    regime: candidate.regime, conditions: candidate.conditions, reasoning: candidate.reasoning,
  };
  let memory: DecisionMemoryContext | null = null;
  let verifiedMarketEvidence = new Set<string>();
  let fingerprint: string | null = null;
  let contextRef = "candidate_gate";
  const memoryEnabled = store !== undefined && marketRegime !== undefined && gateMemoryEnabled(root);
  if (memoryEnabled && store && marketRegime) {
    try {
      const identity = identityForV2(candidate.strategy, candidate.strategyVersion);
      memory = buildDecisionContext(store, { engine: "SWING_15M", instrument: candidate.instrument,
        strategy: identity.family, strategyCoreVersion: identity.coreVersion, strategyVersion: identity.strategyVersion,
        side: candidate.side, regime: marketRegime, regimeAxes: candidate.regime });
      const serialized = serializeDecisionContext(memory);
      memory = (JSON.parse(serialized) as { trade_memory: DecisionMemoryContext }).trade_memory;
      fingerprint = decisionMemoryFingerprint(serialized);
      payload.trade_memory = memory;
      payload.market_regime = marketRegime;
      payload.feature_data_sufficient = candidate.features.sufficientData;
      verifiedMarketEvidence = swingVerifiedMarketEvidence(candidate, marketRegime);
      payload.verified_market_evidence = [...verifiedMarketEvidence];
      contextRef = `candidate_gate:mem:${fingerprint}`;
    } catch (error) {
      memory = null; fingerprint = null;
      gateLog.warn({ event: "trade_memory_unavailable", role: "gate", reason: error instanceof Error ? error.name : "UNKNOWN" });
    }
  }
  if (!memory) prompt = prompt.replace(/\n?<!-- TRADE_MEMORY_RULES_START -->[\s\S]*?<!-- TRADE_MEMORY_RULES_END -->\n?/g, "\n");
  onContextRef?.(contextRef);
  const result = await roles.json("gate", prompt, JSON.stringify(payload), CandidateGateSchema, contextRef);
  if (!result) return null;
  if (!memory) {
    return { ...result, contextRef, memoryFingerprint: fingerprint, policyDisposition: "ACCEPT",
      cited_memory: [], deny_basis: undefined, market_evidence_refs: [],
      effectiveVerdict: result.verdict, memorySampleCounts: null };
  }
  const policy = evaluateGateVetoPolicy({ verdict: result.verdict,
    ...(result.deny_basis ? { denyBasis: result.deny_basis as GateDenyBasis } : {}),
    citedMemory: result.verdict === "DENY" ? result.cited_memory : [],
    marketEvidenceRefs: result.verdict === "DENY" ? result.market_evidence_refs ?? [] : [],
    reasoning: [...result.reasoning, ...result.risk_flags], memory, verifiedMarketEvidence });
  if (policy.kind !== "ACCEPT") {
    gateLog.warn({ event: policy.kind === "MEMORY_CITATION_INVALID" ? "GATE_MEMORY_VETO_REJECTED" : "GATE_POLICY_UNSUPPORTED",
      role: "gate", instrument: candidate.instrument, engine: candidate.engine, strategy: candidate.strategy,
      side: candidate.side, contextRef, denyBasis: result.deny_basis ?? null, citedMemory: result.cited_memory,
      marketEvidenceRefs: result.market_evidence_refs ?? [], s1Trades: memory.stats[0].trades, s2Trades: memory.stats[1].trades,
      policyReason: policy.reason });
  }
  return { ...result, ...(result.verdict === "ALLOW" ? { cited_memory: [], deny_basis: undefined, market_evidence_refs: [] } : {}),
    ...(policy.kind === "ACCEPT" && policy.basis ? { deny_basis: policy.basis } : {}),
    contextRef, memoryFingerprint: fingerprint, policyDisposition: policy.kind,
    memorySampleCounts: { s1: memory.stats[0].trades, s2: memory.stats[1].trades },
    effectiveVerdict: policy.kind === "IGNORE_UNSUPPORTED_MEMORY_VETO" ? "ALLOW"
      : policy.kind === "ACCEPT" ? policy.verdict : "DENY",
    ...(policy.kind !== "ACCEPT" ? { policyReason: policy.reason } : {}) };
}


export const HOLD: Decision = {
  decision: "HOLD", strategy: null, confidence: 0,
  thesis: ["llm_unavailable_or_invalid — safe HOLD (§21)"], invalidations: [],
  suggested_stop_atr: 1.5, suggested_take_profit_atr: 3.0,
};

export function holdBecause(reason: string): Decision {
  return { ...HOLD, thesis: [reason] };
}

export async function decide(
  root: string,
  roles: RoleLlmService,
  instrument: string,
  timeframe: string,
  f: FeatureSnapshot,
  regime: Regime,
  strategies: StrategyDef[],
  hasPosition: boolean,
  store: Store,
): Promise<Decision> {
  // Legacy Core 1 has no deterministic candidate contract in this repository.
  // Do not let the Gate role invent direction, strategy, or exit geometry.
  void root; void roles; void instrument; void timeframe; void f; void regime; void strategies; void hasPosition; void store;
  return holdBecause("Core 1 directional LLM path disabled; no deterministic candidate available");
}
