// M7 (§35/§48) — deterministic Champion-vs-Challenger promotion. The
// Evolution Agent never runs this; only the evaluation pipeline does, and
// its CRITERIA are fixed in config (not evolveable, §48).
import type { Store } from "../memory/db.ts";
import { logSystemEvent } from "../memory/db.ts";
import { loadStrategies, saveStrategy, setStrategyStatus, type StrategyDef } from "../strategy/library.ts";
import type { Regime } from "../market/regime.ts";
import { summarize, type PerfSummary } from "./performance.ts";
import { backtest, walkForward, backtestV2, walkForwardV2, DEFAULT_V2_COSTS, type V2BacktestResult, type V2CostModel } from "./backtest.ts";
import { DEFAULT_V2_PARAMS, type StrategyV2Id, type StrategyV2Params } from "../strategy/core-v2.ts";
import type { Candle } from "../exchange/okx/types.ts";

export interface PromotionCriteria {
  minSampleEachSide: number;
  requireOutOfSample: boolean;
  requireWalkForward: boolean;
  wfMinPositiveFolds: number;
  minPositiveSymbols?: number;
  requireDrawdownNonWorse?: boolean;
}

export const DEFAULT_CRITERIA: PromotionCriteria = {
  minSampleEachSide: 30, requireOutOfSample: true, requireWalkForward: true, wfMinPositiveFolds: 2,
};

export interface Comparison {
  champion: string; challenger: string;
  champ: PerfSummary & { wfMean?: number | undefined; symbolStats?: Record<string, PerfSummary> };
  chal: PerfSummary & { wfMean?: number | undefined; symbolStats?: Record<string, PerfSummary> };
  promoted: boolean;
  reasons: string[];
}

export function compareAndMaybePromote(
  store: Store,
  candles: Candle[] | ReadonlyMap<string, Candle[]>, // each symbol uses the identical window for both sides
  timeframe: string,
  criteria: PromotionCriteria = DEFAULT_CRITERIA,
  costs: V2CostModel = DEFAULT_V2_COSTS,
): Comparison[] {
  const strategies = loadStrategies(store);
  const results: Comparison[] = [];
  for (const champ of strategies.filter((s) => s.status === "CHAMPION")) {
    const chal = strategies.find((s) => s.name === champ.name && s.status === "CHALLENGER");
    if (!chal) continue;
    const histories = toHistories(candles);
    const btC = compareHistory(champ, histories, timeframe, costs);
    const btX = compareHistory(chal, histories, timeframe, costs);
    const wfC = criteria.requireWalkForward ? compareWalkForward(champ, histories, timeframe, costs) : undefined;
    const wfX = criteria.requireWalkForward ? compareWalkForward(chal, histories, timeframe, costs) : undefined;
    const champR = tradeRs(store, champ, "SWING_15M");
    const chalR = tradeRs(store, chal, "SWING_15M");
    const liveC = summarize(champR);
    const liveX = summarize(chalR);
    const reasons: string[] = [];
    // Insufficient evidence is not a rejection. Keep the challenger visible
    // and inert until it can be evaluated without manufacturing certainty.
    if (btX.sample < criteria.minSampleEachSide) {
      reasons.push(`awaiting historical sample: ${btX.sample}/${criteria.minSampleEachSide}`);
      results.push({
        champion: `${champ.name}_V${champ.version}`, challenger: `${chal.name}_V${chal.version}`,
        champ: { ...btC.summary, wfMean: wfC?.mean, symbolStats: btC.symbolStats }, chal: { ...btX.summary, wfMean: wfX?.mean, symbolStats: btX.symbolStats },
        promoted: false, reasons,
      });
      persistComparison(store, results[results.length - 1]!);
      continue;
    }
    const promoted = (() => {
      if (btX.summary.expectancy_r <= btC.summary.expectancy_r) reasons.push(`OOS expectancy ${btX.summary.expectancy_r} <= champion ${btC.summary.expectancy_r}`);
      if (wfX && wfC && (wfX.mean <= wfC.mean || wfX.positiveFolds < criteria.wfMinPositiveFolds)) reasons.push(`walk-forward challenger mean ${wfX?.mean} positiveFolds ${wfX?.positiveFolds}`);
      const requiredPositiveSymbols = criteria.minPositiveSymbols ?? (histories.size > 1 ? Math.ceil(histories.size / 2) : 1);
      const positiveSymbols = Object.values(btX.symbolStats).filter((s) => s.expectancy_r > 0).length;
      if (positiveSymbols < requiredPositiveSymbols) reasons.push(`cross-symbol expectancy positive on ${positiveSymbols}/${requiredPositiveSymbols} required symbols`);
      if ((criteria.requireDrawdownNonWorse ?? true) && btX.summary.max_drawdown_pct > btC.summary.max_drawdown_pct) reasons.push("challenger max drawdown exceeds champion");
      if (reasons.length > 0) return false;
      // live (demo-forward) evidence, when available, must not contradict
      if (liveC.trades >= criteria.minSampleEachSide && liveX.trades >= criteria.minSampleEachSide && liveX.expectancy_r <= liveC.expectancy_r) {
        reasons.push(`demo-forward expectancy ${liveX.expectancy_r} <= ${liveC.expectancy_r}`);
        return false;
      }
      return true;
    })();
    if (promoted) {
      setStrategyStatus(store, champ.name, champ.version, "SUPERSEDED");
      setStrategyStatus(store, chal.name, chal.version, "CHAMPION");
      logSystemEvent(store, "PROMOTION", { challenger: `${chal.name}_V${chal.version}`, champBt: btC.summary, chalBt: btX.summary });
    } else {
      setStrategyStatus(store, chal.name, chal.version, "REJECTED");
      logSystemEvent(store, "PROMOTION_REJECTED", { challenger: `${chal.name}_V${chal.version}`, reasons });
    }
    results.push({
      champion: `${champ.name}_V${champ.version}`, challenger: `${chal.name}_V${chal.version}`,
      champ: { ...btC.summary, wfMean: wfC?.mean, symbolStats: btC.symbolStats }, chal: { ...btX.summary, wfMean: wfX?.mean, symbolStats: btX.symbolStats },
      promoted, reasons,
    });
    persistComparison(store, results[results.length - 1]!);
  }
  void saveStrategy;
  return results;
}

function persistComparison(store: Store, comparison: Comparison): void {
  store.db.prepare(`INSERT INTO evolution_comparisons(ts,champion,challenger,promoted,reasons,champion_metrics,challenger_metrics)
    VALUES(?,?,?,?,?,?,?)`).run(
    new Date().toISOString(), comparison.champion, comparison.challenger, comparison.promoted ? 1 : 0,
    JSON.stringify(comparison.reasons), JSON.stringify(comparison.champ), JSON.stringify(comparison.chal),
  );
}

function tradeRs(store: Store, s: StrategyDef, engine: string): number[] {
  // AI-managed V1 exits have no deterministic historical analogue; keep them
  // out of demo-forward comparisons rather than mixing exit policies.
  return (store.db.prepare("SELECT result_r r FROM trades WHERE status='CLOSED' AND result_r_basis='NET' AND engine=? AND strategy_core_version=1 AND strategy=? AND strategy_version=? AND result_r IS NOT NULL AND COALESCE(exit_reason,'')<>'AI_CLOSE'")
    .all(engine, s.name, s.version) as Array<{ r: number }>).map((x) => x.r);
}

function toHistories(candles: Candle[] | ReadonlyMap<string, Candle[]>): Map<string, Candle[]> {
  if (Array.isArray(candles)) return new Map([["ANCHOR", [...candles].sort((a, b) => a.ts - b.ts)]]);
  return new Map([...candles.entries()].map(([s, cs]) => [s, [...cs].sort((a, b) => a.ts - b.ts)]));
}
function compareHistory(def: StrategyDef, histories: Map<string, Candle[]>, timeframe: string, costs: V2CostModel): { summary: PerfSummary; symbolStats: Record<string, PerfSummary>; sample: number } {
  const symbolStats: Record<string, PerfSummary> = {};
  const rs: number[] = [];
  for (const [symbol, cs] of histories) {
    const bt = backtest(def, cs, timeframe, costs);
    symbolStats[symbol] = bt.summary;
    rs.push(...bt.trades.map((t) => t.resultR));
  }
  return { summary: summarize(rs), symbolStats, sample: rs.length };
}
function compareWalkForward(def: StrategyDef, histories: Map<string, Candle[]>, timeframe: string, costs: V2CostModel): { mean: number; positiveFolds: number; worstFold: number; dispersion: number } {
  const folds = [...histories.values()].flatMap((cs) => walkForward(def, cs, timeframe, 4, costs).foldExpectancies);
  const mean = folds.length ? folds.reduce((a, b) => a + b, 0) / folds.length : 0;
  const variance = folds.length ? folds.reduce((a, x) => a + (x - mean) ** 2, 0) / folds.length : 0;
  return { mean, positiveFolds: folds.filter((x) => x > 0).length, worstFold: folds.length ? Math.min(...folds) : 0, dispersion: Math.sqrt(variance) };
}

export function evaluateV2Portfolio(
  strategy: StrategyV2Id, histories: ReadonlyMap<string, Candle[]>, timeframe: string,
  params: StrategyV2Params = DEFAULT_V2_PARAMS, costs?: V2CostModel,
): { aggregate: PerfSummary; perSymbol: Record<string, V2BacktestResult>; perRegime: Record<string, PerfSummary>; walkForward: Record<string, ReturnType<typeof walkForwardV2>>; positiveSymbols: number } {
  const perSymbol: Record<string, V2BacktestResult> = {};
  const walkForwardBySymbol: Record<string, ReturnType<typeof walkForwardV2>> = {};
  const netRs: number[] = [];
  const regimeRs = new Map<string, number[]>();
  for (const [symbol, candles] of histories) {
    const result = backtestV2(strategy, candles, timeframe, params, costs, symbol);
    perSymbol[symbol] = result; netRs.push(...result.trades.map((t) => t.netR));
    for (const trade of result.trades) {
      const key = `${trade.regime.trend}+${trade.regime.volatility}`;
      regimeRs.set(key, [...(regimeRs.get(key) ?? []), trade.netR]);
    }
    walkForwardBySymbol[symbol] = walkForwardV2(strategy, candles, timeframe, 5, params, costs);
  }
  return { aggregate: summarize(netRs), perSymbol,
    perRegime: Object.fromEntries([...regimeRs.entries()].map(([key, rs]) => [key, summarize(rs)])),
    walkForward: walkForwardBySymbol,
    positiveSymbols: Object.values(perSymbol).filter((r) => r.netExpectancyR > 0).length };
}
