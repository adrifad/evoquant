// LLM components of the scalp engine — BOTH fail-closed (§21):
//  • supervisor (every 15m): market-wide stance AGGRESSIVE/NEUTRAL/DEFENSIVE
//  • gate (per candidate, ≤ budget): ALLOW/DENY this exact scalp setup
// Prompts are deliberately tiny (tokens + latency); the heavy reasoning is
// deterministic in signals.ts — the LLM only approves or vetoes (§2.1).
import { z } from "zod";
import type { RoleLlmService } from "../core/llm-role-service.ts";
import type { ScalpCfg, ScalpSignal, Stance } from "../scalp/signals.ts";
import type { Regime } from "../market/regime.ts";
import { createLogger } from "../core/logger.ts";

const log = createLogger("scalp-llm");

export const StanceSchema = z.object({
  stance: z.enum(["AGGRESSIVE", "NEUTRAL", "DEFENSIVE"]),
  confidence: z.number().min(0).max(1),
  reason: z.string().max(500),
}).strict();

export const ScalpCandidateGateSchema = z.object({
  verdict: z.enum(["ALLOW", "DENY"]),
  confidence: z.number().min(0).max(1),
  reason: z.string().max(200),
}).strict();

export const DEFAULT_STANCE: Stance = "NEUTRAL";

export async function fetchStance(roles: RoleLlmService, ctx: {
  regimes: Record<string, Regime>; atrPcts: Record<string, number>; sessionPnlR: number; tradesToday: number;
}): Promise<{ stance: Stance; confidence: number; reason: string }> {
  const sys = `You are the risk supervisor of an automated crypto FUTURES SCALPER (1-5m, OKX demo).
Decide ONE stance for the next 15 minutes:
- AGGRESSIVE: trending and clean momentum; entries encouraged, minimum setup score 0.55
- NEUTRAL: mixed conditions; only strong setups, minimum setup score 0.72
- DEFENSIVE: choppy / false-breakout regime or drawdown stress; no new scalps

Use only the provided facts. Do not invent market data.

OUTPUT RULES:
- Return exactly one JSON object, with no markdown, code fences, or text before or after it.
- Use exactly these fields: stance, confidence, reason.
- stance must be AGGRESSIVE, NEUTRAL, or DEFENSIVE.
- confidence must be between 0 and 1.
- reason must be concise and no more than 250 characters.

Return:
{"stance":"AGGRESSIVE|NEUTRAL|DEFENSIVE","confidence":0.0,"reason":"<=250 characters"}`;
  const user = JSON.stringify(ctx);
  const out = await roles.json("scalp", sys, user, StanceSchema, "scalp_stance");
  if (!out) { log.warn({ event: "stance_fail_closed" }); return { stance: "DEFENSIVE", confidence: 0, reason: "LLM unavailable → scalp skipped" }; }
  return out;
}

export async function gateSignal(roles: RoleLlmService, signal: ScalpSignal, cfgp: ScalpCfg,
  ctx: { stance: Stance; regime: Regime; atrPct15m: number; spreadOk: boolean }): Promise<{ allow: boolean; confidence: number; reason: string }> {
  const sys = `You are a veto gate for ONE crypto-scalp setup (demo futures). The deterministic engine already passed all hard rules; your ONLY job is to deny setups that look like classic traps: chasing vertical blow-offs, RSI extreme against direction, entry against higher-timeframe trend, or news-like gaps. The scalper's stop distance is ${((Math.abs(signal.price - signal.stopPx) / signal.price) * 100).toFixed(2)}% (1m-ATR based), take-profit ${((Math.abs(signal.tpPx - signal.price) / signal.price) * 100).toFixed(2)}%. Reply JSON {"verdict":"ALLOW"|"DENY","confidence":0-1,"reason":"max 200 chars"}. When uncertain, ALLOW — policy is handled elsewhere.`;
  const user = JSON.stringify({ signal, stance: ctx.stance, regime: ctx.regime, atrPct15m: ctx.atrPct15m, maxHoldS: cfgp.max_hold_s });
const out = await roles.json("scalp", sys, user, ScalpCandidateGateSchema, "scalp_candidate_gate");
  if (!out) { log.warn({ event: "gate_fail_closed", instrument: signal.instrument }); return { allow: false, confidence: 0, reason: "LLM gate unavailable → DENY (fail-closed §21)" }; }
  return { allow: out.verdict === "ALLOW", confidence: out.confidence, reason: out.reason };
}
