export type ScalpEntryOutcome =
  | { kind: "OPENED"; reason?: string; riskResult?: string }
  | { kind: "CANDIDATE_REJECT"; reason: string; riskResult?: string }
  | { kind: "GLOBAL_STOP"; reason: string; riskResult?: string };

export interface ScalpQueueResult {
  result: "OPENED" | "GLOBAL_STOP" | "EXHAUSTED";
  attempted: number;
  reason?: string;
}

/** Try ranked Scalp signals until one opens, or a global safety/provider stop occurs. */
export async function runScalpCandidateQueue<T>(
  candidates: readonly T[],
  attempt: (candidate: T, rank: number) => Promise<ScalpEntryOutcome>,
): Promise<ScalpQueueResult> {
  let attempted = 0;
  for (let index = 0; index < candidates.length; index++) {
    attempted++;
    const outcome = await attempt(candidates[index]!, index + 1);
    if (outcome.kind === "OPENED") return { result: "OPENED", attempted, ...(outcome.reason ? { reason: outcome.reason } : {}) };
    if (outcome.kind === "GLOBAL_STOP") return { result: "GLOBAL_STOP", attempted, reason: outcome.reason };
  }
  return { result: "EXHAUSTED", attempted };
}
