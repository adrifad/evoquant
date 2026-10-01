// M3/M4 — opportunity filter (§37, cheap deterministic pre-gate before LLM).
import type { FeatureSnapshot } from "../market/features.ts";
import type { Regime } from "../market/regime.ts";

export interface Opportunity {
  worthEvaluating: boolean;
  reason: string;
}

// deterministic baseline (§50): UNKNOWN/LOW_VOL → skip; HIGH_VOL → strict.
export function filterOpportunity(f: FeatureSnapshot, regime: Regime, hasPosition: boolean, killActive: boolean): Opportunity {
  if (killActive) return { worthEvaluating: false, reason: "kill switch active — no new entries (§23)" };
  if (hasPosition) return { worthEvaluating: true, reason: "position open — evaluate CLOSE (§25)" };
  if (!f.sufficientData) return { worthEvaluating: false, reason: "warm-up incomplete" };
  if (regime === "UNKNOWN") return { worthEvaluating: false, reason: "regime UNKNOWN (§50)" };
  if (regime === "LOW_VOLATILITY") return { worthEvaluating: false, reason: "LOW_VOLATILITY — no edge (§50)" };
  if (regime === "SIDEWAYS" && f.volumeRatio < 0.5) return { worthEvaluating: false, reason: "dead sideways tape" };
  return { worthEvaluating: true, reason: `regime ${regime} tradable` };
}
