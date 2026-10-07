import { readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { RoleLlmService } from "../core/llm-role-service.ts";

export const CriticSchema = z.object({
  verdict: z.enum(["ACCEPT", "REJECT", "REVISE"]),
  confidence: z.number().min(0).max(1),
  issues: z.array(z.string().max(300)).max(8).default([]),
  reasoning_summary: z.array(z.string().max(300)).max(6).default([]),
}).strict();
export type CriticVerdict = z.infer<typeof CriticSchema>;

export async function critiqueV2Proposal(root: string, roles: RoleLlmService, context: unknown): Promise<CriticVerdict | null> {
  const prompt = readFileSync(path.join(root, "prompts/critic-v2.md"), "utf8");
  return roles.json("critic", prompt, JSON.stringify(context), CriticSchema, "v2_proposal_critic");
}
