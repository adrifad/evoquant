// M4 (§28/§53) — Trade Reviewer: LLM produces HYPOTHESES ONLY.
// Lesson candidates land as PROVISIONAL; only statistics validate (§30).
import { readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { llmJson, type LlmConfig } from "../core/llm.ts";
import { upsertLesson, addLessonEvidence, tradesMatchingScope } from "../memory/lessons.ts";
import { logSystemEvent } from "../memory/db.ts";
import type { Store } from "../memory/db.ts";

export const ReviewSchema = z.object({
  outcome: z.enum(["WIN", "LOSS", "BREAKEVEN"]),
  result_r: z.number(),
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
});
export type Review = z.infer<typeof ReviewSchema>;

export async function reviewTrade(
  root: string,
  cfg: LlmConfig,
  store: Store,
  tradeId: string,
): Promise<Review | null> {
  const t = store.db.prepare("SELECT * FROM trades WHERE trade_id=?").get(tradeId) as Record<string, unknown> | undefined;
  if (!t || t.status !== "CLOSED") return null;
  const prompt = readFileSync(path.join(root, "prompts/review.md"), "utf8");
  const input = {
    trade_id: t.trade_id,
    side: t.side, regime: t.regime,
    strategy: `${t.strategy}_V${t.strategy_version}`,
    entry: { px: t.entry_px, ts: t.entry_ts, features: JSON.parse(String(t.entry_features ?? "{}")) },
    exit: { px: t.exit_px, ts: t.exit_ts, reason: t.exit_reason },
    result: { pnl: t.pnl, pnl_pct: t.pnl_pct, result_r: t.result_r, mfe: t.mfe, mae: t.mae, fees: t.fees },
    duration_s: t.duration_s,
    decision: { raw_confidence: t.raw_confidence, calibrated_confidence: t.calibrated_confidence },
  };
  const review = await llmJson(cfg, prompt, JSON.stringify(input), ReviewSchema);
  if (!review) {
    logSystemEvent(store, "REVIEW", { tradeId, result: "llm_invalid_no_review" });
    return null;
  }
  store.db.prepare(
    "INSERT OR REPLACE INTO trade_reviews(trade_id,ts,outcome,result_r,observations,lesson_candidates) VALUES(?,?,?,?,?,?)",
  ).run(tradeId, new Date().toISOString(), review.outcome, review.result_r,
    JSON.stringify(review.observations), JSON.stringify(review.lesson_candidates));
  // lesson candidates → PROVISIONAL; evidence attached from matching scope
  for (const c of review.lesson_candidates) {
    const stmt = `${c.statement} (side=${t.side})`.slice(0, 400);
    const lessonId = upsertLesson(store, {
      statement: stmt,
      scope: { strategy: c.scope.strategy ?? String(t.strategy), instrument: String(t.instrument), regime: c.scope.regime ?? String(t.regime) },
      confidence: Math.min(c.confidence, 0.5), // §28 rule 3: single trade ≤0.5
    });
    const trades = tradesMatchingScope(store, { strategy: String(t.strategy), regime: String(t.regime) });
    // Evidence rule (§30): a lesson says "pattern X underperforms" → a trade in
    // scope is ALIGNED when it lost, CONTRADICTED when it won.
    for (const tr of trades) {
      addLessonEvidence(store, lessonId, String(tr.trade_id), Number(tr.result_r) < 0);
    }
  }
  logSystemEvent(store, "REVIEW", { tradeId, outcome: review.outcome, lessonCandidates: review.lesson_candidates.length });
  return review;
}
