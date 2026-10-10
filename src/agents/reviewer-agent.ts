// M4 (§28/§53) — Trade Reviewer: LLM produces HYPOTHESES ONLY.
// Lesson candidates land as PROVISIONAL; only statistics validate (§30).
import { readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { RoleLlmService } from "../core/llm-role-service.ts";
import { upsertLesson } from "../memory/lessons.ts";
import { logSystemEvent } from "../memory/db.ts";
import type { Store } from "../memory/db.ts";

export const ReviewSchema = z.object({
  observations: z.array(z.object({
    factor: z.string(),
    effect: z.enum(["positive", "negative", "neutral"]),
    evidence: z.string(),
  })).default([]),
  assumptions_check: z.object({
    thesis_correct: z.array(z.number()).default([]),
    thesis_failed: z.array(z.number()).default([]),
  }).optional(),
  lesson_candidates: z.array(z.object({
    statement: z.string().min(8),
    confidence: z.number().min(0).max(1),
    scope: z.object({ strategy: z.string().optional(), regime: z.string().optional(), direction: z.string().optional() }).default({}),
  })).max(3).default([]),
}).strict();
export type Review = z.infer<typeof ReviewSchema>;

export async function reviewTrade(
  root: string,
  roles: RoleLlmService,
  store: Store,
  tradeId: string,
): Promise<Review | null> {
  const t = store.db.prepare("SELECT * FROM trades WHERE trade_id=?").get(tradeId) as Record<string, unknown> | undefined;
  if (!t || t.status !== "CLOSED" || t.evidence_state !== "VALID" || t.evolution_evidence_eligible !== 1 || t.result_r_basis !== "NET") return null;
  const prompt = readFileSync(path.join(root, "prompts/review.md"), "utf8");
  const initialRisk = Math.abs(Number(t.entry_px) - Number(t.initial_stop_px ?? t.stop_px));
  const input = {
    trade_id: t.trade_id,
    engine: t.engine ?? (t.timeframe === "scalp" ? "SCALP_5M" : "SWING_15M"),
    side: t.side, regime: t.regime, regime_axes: t.regime_axes,
    strategy: t.strategy, strategy_core_version: t.strategy_core_version, strategy_version: t.strategy_version,
    entry: { px: t.entry_px, ts: t.entry_ts, features: JSON.parse(String(t.entry_features ?? "{}")) },
    entry_conditions: (() => { try { return JSON.parse(String(t.entry_conditions ?? "[]")) as unknown[]; } catch { return []; } })(),
    exit: { px: t.exit_px, ts: t.exit_ts, reason: t.exit_reason },
    result: { pnl: t.pnl, pnl_pct: t.pnl_pct, gross_r: initialRisk > 0
      ? ((Number(t.exit_px) - Number(t.entry_px)) * (t.side === "LONG" ? 1 : -1)) / initialRisk : null,
      result_r: t.result_r, net_r: t.result_r, fees: t.fees, funding: t.funding, mfe: t.mfe, mae: t.mae,
      mfe_r: initialRisk > 0 ? Number(t.mfe) / initialRisk : null, mae_r: initialRisk > 0 ? Number(t.mae) / initialRisk : null,
      exit_reason: t.exit_reason },
    execution: { initial_stop_px: t.initial_stop_px, stop_px: t.stop_px, take_profit_px: t.take_profit_px },
    duration_s: t.duration_s,
    decision: { raw_confidence: t.raw_confidence, calibrated_confidence: t.calibrated_confidence },
  };
  const review = await roles.json("reviewer", prompt, JSON.stringify(input), ReviewSchema, "closed_trade_review");
  if (!review) {
    logSystemEvent(store, "REVIEW", { tradeId, result: "llm_invalid_no_review" });
    return null;
  }
  store.db.prepare(
    "INSERT OR REPLACE INTO trade_reviews(trade_id,ts,outcome,result_r,observations,lesson_candidates) VALUES(?,?,?,?,?,?)",
  ).run(tradeId, new Date().toISOString(), null, null, JSON.stringify(review.observations), JSON.stringify(review.lesson_candidates));
  // Lesson candidates stay provisional: natural-language claims cannot yet
  // be validated reliably against arbitrary trades without semantic leakage.
  for (const c of review.lesson_candidates) {
    const stmt = `${c.statement} (side=${t.side})`.slice(0, 400);
    const lessonId = upsertLesson(store, {
      statement: stmt,
      scope: {
        engine: String(t.engine ?? "SWING_15M") as "SWING_15M" | "SCALP_5M",
        strategy: String(t.strategy), strategyVersion: Number(t.strategy_version),
        instrument: String(t.instrument), regime: String(t.regime), direction: String(t.side),
        ...(typeof t.regime_axes === "string" ? { regimeAxes: t.regime_axes } : {}),
      },
      confidence: Math.min(c.confidence, 0.5), // §28 rule 3: single trade ≤0.5
    });
    logSystemEvent(store, "LESSON_CANDIDATE", { lessonId, engine: input.engine, strategy: t.strategy, version: t.strategy_version, state: "PROVISIONAL_NO_SEMANTIC_VALIDATION" });
  }
  logSystemEvent(store, "REVIEW", { tradeId, lessonCandidates: review.lesson_candidates.length });
  return review;
}
