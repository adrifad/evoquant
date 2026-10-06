// Multi-coin scanner — DETERMINISTIC pre-rank (§37 Opportunity Agent + §50
// selection logic). The LLM is consulted only for the single best candidate,
// keeping free-tier budget at ~1 call per candle.
import type { FeatureSnapshot } from "../market/features.ts";
import { classifyRegime, type Regime } from "../market/regime.ts";
import { scoreStrategy, type StrategyDef } from "./library.ts";
import type { SignalWeights } from "../learning/signal-weights.ts";
import type { Candle } from "../exchange/okx/types.ts";
import { DEFAULT_V2_PARAMS, evaluateAllV2Setups, type SetupEvaluation, type StrategyV2Params, type TradeCandidate } from "./core-v2.ts";

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
): ScanRow[] {
  const rows: ScanRow[] = snapshots.map(({ instrument, features }) => {
    const evaluations = evaluateAllV2Setups(features, candlesByInstrument.get(instrument) ?? [], params);
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
