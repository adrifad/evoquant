// Multi-coin scanner — DETERMINISTIC pre-rank (§37 Opportunity Agent + §50
// selection logic). The LLM is consulted only for the single best candidate,
// keeping free-tier budget at ~1 call per candle.
import type { FeatureSnapshot } from "../market/features.ts";
import { classifyRegime, type Regime } from "../market/regime.ts";
import { scoreStrategy, type StrategyDef } from "./library.ts";
import type { Candle } from "../exchange/okx/types.ts";
import { DEFAULT_V2_PARAMS, DEFAULT_V2_VERSIONS, evaluateAllV2Setups, type SetupEvaluation, type StrategyV2Params, type StrategyV2Versions, type TradeCandidate } from "./core-v2.ts";
import type { StrategyFamily } from "./identity.ts";
import { v2StrategyForFamily } from "./identity.ts";
import type { SignalWeights } from "../learning/signal-weights.ts";

export interface ScanRow {
  instrument: string;
  regime: Regime;
  price: number;
  score: number;             // signed [-1,1]; + = LONG bias, - = SHORT bias
  strategy: string | null;   // best-scoring enabled strategy id
  tradable: boolean;
  engine?: "SWING_15M" | "SCALP_5M";
  candidate?: TradeCandidate | null;
  conditions?: SetupEvaluation[];
}

/** Strategy Core V2 scanner: hard conditions decide tradability; score only ranks valid setups. */
export function scanCoreV2(
  snapshots: Array<{ instrument: string; features: FeatureSnapshot }>,
  candlesByInstrument: ReadonlyMap<string, Candle[]>,
  params: StrategyV2Params = DEFAULT_V2_PARAMS,
  versions: StrategyV2Versions = DEFAULT_V2_VERSIONS,
  weightsByStrategy: Partial<Record<keyof StrategyV2Params, SignalWeights>> = {},
  enabledFamilies: readonly StrategyFamily[] = ["TREND_FOLLOWING", "BREAKOUT", "MEAN_REVERSION"],
): ScanRow[] {
  const enabledStrategies = new Set(enabledFamilies.map(v2StrategyForFamily));
  const rows: ScanRow[] = snapshots.map(({ instrument, features }) => {
    const evaluations = evaluateAllV2Setups(features, candlesByInstrument.get(instrument) ?? [], params, versions)
      .filter((evaluation) => enabledStrategies.has(evaluation.strategy))
      .map((evaluation) => adjustPassedQuality(evaluation, weightsByStrategy[evaluation.strategy]));
    const candidates = evaluations.flatMap((e) => e.candidate ? [e.candidate] : []);
    candidates.sort((a, b) => b.setupScore - a.setupScore);
    const candidate = candidates[0] ?? null;
    const regime = classifyRegime(features);
    return {
      instrument, regime, price: round2(features.price), score: candidate ? round2((candidate.side === "LONG" ? 1 : -1) * candidate.setupScore) : 0,
      strategy: candidate?.strategy ?? null, tradable: candidate !== null, engine: "SWING_15M", candidate,
      conditions: evaluations,
    };
  });
  return rows.sort((a, b) => Number(b.tradable) - Number(a.tradable) || Math.abs(b.score) - Math.abs(a.score));
}

/** Learned weights may rank already-valid V2 setups; they cannot satisfy a failed hard condition. */
function adjustPassedQuality(evaluation: SetupEvaluation, weights?: SignalWeights): SetupEvaluation {
  if (!evaluation.candidate || !weights) return evaluation;
  const factor = evaluation.strategy === "TREND_FOLLOWING_V2"
    ? 0.45 * weights.trend + 0.35 * weights.momentum + 0.2 * weights.volume
    : evaluation.strategy === "BREAKOUT_V2"
      ? 0.45 * weights.trend + 0.35 * weights.volume + 0.2 * weights.volatility
      : 0.5 * weights.momentum + 0.5 * weights.volatility;
  const setupScore = Math.max(0, Math.min(1, evaluation.setupScore * factor));
  return { ...evaluation, setupScore, candidate: { ...evaluation.candidate, setupScore } };
}

const round2 = (n: number): number => (Number.isFinite(n) ? Math.round(n * 100) / 100 : 0);

export function scanInstruments(
  snapshots: Array<{ instrument: string; features: FeatureSnapshot }>,
  strategies: StrategyDef[],
  weights?: SignalWeights,
): ScanRow[] {
  const rows = snapshots.map(({ instrument, features: f }) => {
    const regime = classifyRegime(f);
    let best = { score: 0, strategy: null as string | null };
    for (const s of strategies) {
      if (s.status !== "CHAMPION" || !s.allowed_regimes.includes(regime)) continue;
      const sc = scoreStrategy(s, f, weights);
      if (Math.abs(sc) > Math.abs(best.score)) best = { score: sc, strategy: `${s.name}_V${s.version}` };
    }
    const tradable =
      f.sufficientData &&
      regime !== "UNKNOWN" && regime !== "LOW_VOLATILITY" &&
      Math.abs(best.score) >= 0.5 && Number.isFinite(f.price);
    return { instrument, regime, price: round2(f.price), score: round2(best.score), strategy: best.strategy, tradable };
  });
  return rows.sort((a, b) => Math.abs(b.score) - Math.abs(a.score));
}

// pick entry candidate = highest |score| tradable row
export function pickEntry(rows: ScanRow[]): ScanRow | null {
  return rows.find((r) => r.tradable) ?? null;
}
