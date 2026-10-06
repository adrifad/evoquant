// M3 (§21/§37) — Decision Agent: LLM proposes; invalid output ⇒ HOLD.
// The agent NEVER sizes or executes — that is Risk Engine + executor (§2.1).
import { readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { FeatureSnapshot } from "../market/features.ts";
import type { Regime } from "../market/regime.ts";
import { llmJson, type LlmConfig } from "../core/llm.ts";
import type { StrategyDef } from "../strategy/library.ts";
import type { Store } from "../memory/db.ts";
import { getRegimeStatsBrief } from "../memory/regimes.ts";
import { getActiveLessons } from "../memory/lessons.ts";
import type { TradeCandidate } from "../strategy/core-v2.ts";

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
  reasoning: z.array(z.string().max(280)).max(5).default([]),
  risk_flags: z.array(z.string().max(120)).max(5).default([]),
});
export type CandidateGate = z.infer<typeof CandidateGateSchema>;

/** LLM may veto or allow only; candidate side, strategy and geometry are immutable. */
export async function gateCandidate(root: string, cfg: LlmConfig, candidate: TradeCandidate): Promise<CandidateGate | null> {
  const prompt = readFileSync(path.join(root, "prompts/candidate-gate.md"), "utf8");
  return llmJson(cfg, prompt, JSON.stringify({
    instrument: candidate.instrument, engine: candidate.engine, strategy: candidate.strategy,
    version: candidate.strategyVersion, side: candidate.side, setup_score: candidate.setupScore,
    entry: candidate.entryPrice, stop: candidate.stopPrice, take_profit: candidate.takeProfitPrice,
    regime: candidate.regime, conditions: candidate.conditions, reasoning: candidate.reasoning,
  }), CandidateGateSchema);
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
  cfg: LlmConfig,
  instrument: string,
  timeframe: string,
  f: FeatureSnapshot,
  regime: Regime,
  strategies: StrategyDef[],
  hasPosition: boolean,
  store: Store,
): Promise<Decision> {
  if (!f.sufficientData) return holdBecause("warm-up incomplete — HOLD (§17)");
  if (regime === "UNKNOWN") return holdBecause("regime UNKNOWN → HOLD (§50)");
  const prompt = readFileSync(path.join(root, "prompts/decision.md"), "utf8");
  const input = {
    instrument, timeframe,
    market: {
      regime, price: f.price,
      ema20: r2(f.ema20), ema50: r2(f.ema50), emaSpreadPct: r2(f.emaSpreadPct),
      rsi14: r2(f.rsi14), adx14: r2(f.adx14), atr14: r2(f.atr14), atrPct: r2(f.atrPct),
      volume_ratio: r2(f.volumeRatio),
    },
    open_position: hasPosition,
    enabled_strategies: strategies
      .filter((s) => s.status === "CHAMPION" && s.allowed_regimes.includes(regime))
      .map((s) => ({ id: `${s.name}_V${s.version}`, params: s.params })),
    strategy_memory: getRegimeStatsBrief(store, regime),   // §32
    lessons: getActiveLessons(store, instrument),          // §29
  };
  const out = await llmJson(cfg, prompt, JSON.stringify(input), DecisionSchema);
  if (!out) return holdBecause("decision LLM invalid output → safe HOLD");
  // §21: strategy must be one of the enabled+regime-valid set — clamp if not.
  const validIds = new Set(strategies.filter((s) => s.status === "CHAMPION" && s.allowed_regimes.includes(regime)).map((s) => `${s.name}_V${s.version}`));
  if (typeof out.strategy === "string" && !validIds.has(out.strategy)) {
    return { ...out, strategy: [...validIds][0] ?? null };
  }
  // 0 from the model means "use strategy defaults" (§21 fields are suggestions)
  let stop = out.suggested_stop_atr || 0, tp = out.suggested_take_profit_atr || 0;
  const chosen = strategies.find((s2) => `${s2.name}_V${s2.version}` === out.strategy);
  if (stop < 0.2 || tp < 0.2) {
    stop = chosen?.params.stop_atr ?? 1.5;
    tp = chosen?.params.take_profit_atr ?? 3.0;
  }
  const normalized = { ...out, suggested_stop_atr: stop, suggested_take_profit_atr: tp };
  if (hasPosition && out.decision !== "HOLD" && out.decision !== "CLOSE") {
    return { ...normalized, decision: "HOLD", thesis: [...out.thesis, "position already open — cannot add (§23)"] };
  }
  if (!hasPosition && out.decision === "CLOSE") {
    return { ...normalized, decision: "HOLD", thesis: [...out.thesis, "nothing to close — HOLD"] };
  }
  return normalized;
}

const r2 = (n: number): number => (Number.isFinite(n) ? Math.round(n * 100) / 100 : 0);
