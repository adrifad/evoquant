import type { TradeCandidate } from "./core-v2.ts";
import type { ScanRow } from "./scanner.ts";

export type CandidateAttemptDisposition = "GATE_DENY" | "GATE_ERROR" | "CANDIDATE_REJECT" | "OPENED" | "GLOBAL_STOP";
export interface CandidateAttemptResult {
  disposition: CandidateAttemptDisposition;
  reason?: string;
  gateResult?: string | null;
  riskResult?: string | null;
}
export interface CandidateQueueOptions {
  entrySymbols: ReadonlySet<string>;
  occupiedSymbols: ReadonlySet<string>;
  metadataSymbols: ReadonlySet<string>;
  maxAttempts?: number;
}
export interface CandidateQueueOutcome {
  attempted: Array<{ rank: number; candidate: TradeCandidate; result: CandidateAttemptResult }>;
  opened: TradeCandidate | null;
  stoppedByGlobalCondition: boolean;
}

/** Run a finite score-ordered candidate queue; deterministic and independent of strategy conditions. */
export async function attemptRankedCandidates(
  rows: readonly ScanRow[],
  options: CandidateQueueOptions,
  attempt: (candidate: TradeCandidate) => Promise<CandidateAttemptResult>,
): Promise<CandidateQueueOutcome> {
  const maxAttempts = Math.max(0, Math.min(10, Math.floor(options.maxAttempts ?? 3)));
  const seen = new Set<string>();
  const candidates = rows.flatMap(row => row.candidate ? [row.candidate] : [])
    .filter(candidate => options.entrySymbols.has(candidate.instrument)
      && options.metadataSymbols.has(candidate.instrument)
      && !options.occupiedSymbols.has(candidate.instrument))
    .sort((a, b) => b.setupScore - a.setupScore || a.instrument.localeCompare(b.instrument));
  const attempted: CandidateQueueOutcome["attempted"] = [];
  for (const candidate of candidates) {
    // One Gate/Risk attempt per instrument per cycle, even if several enabled families pass.
    if (seen.has(candidate.instrument)) continue;
    seen.add(candidate.instrument);
    if (attempted.length >= maxAttempts) break;
    const result = await attempt(candidate);
    attempted.push({ rank: attempted.length + 1, candidate, result });
    if (result.disposition === "OPENED") return { attempted, opened: candidate, stoppedByGlobalCondition: false };
    if (result.disposition === "GLOBAL_STOP" || result.disposition === "GATE_ERROR") return { attempted, opened: null, stoppedByGlobalCondition: true };
  }
  return { attempted, opened: null, stoppedByGlobalCondition: false };
}
