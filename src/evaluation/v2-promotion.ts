import type { Candle } from "../exchange/okx/types.ts";
import type { Store } from "../memory/db.ts";
import { logSystemEvent } from "../memory/db.ts";
import { backtestV2, walkForwardV2, type V2CostModel } from "./backtest.ts";
import { summarize, type PerfSummary } from "./performance.ts";
import { completeV2Params, getV2Champions, listV2Versions, transitionV2Version, type V2StrategyVersion } from "../strategy/v2-registry.ts";

export interface V2PromotionCriteria {
  historicalMinTrades: number;
  outOfSampleMinTrades: number;
  shadowForwardMinTrades: number;
  championForwardMinTrades: number;
  outOfSampleFraction: number;
  minimumSymbols: number;
  minPositiveSymbolFraction: number;
  minPositiveWalkForwardFraction: number;
  minimumWalkForwardFolds: number;
  maxDrawdownDegradationPct: number;
  requireOutOfSample: boolean;
  requireWalkForward: boolean;
  requireMultiSymbol: boolean;
  automaticPromotionEnabled: boolean;
}

export interface V2Comparison {
  strategy: string; championVersion: number; challengerVersion: number;
  historicalTrades: number; historicalExpectancyR: number; outOfSampleTrades: number;
  outOfSampleExpectancyR: number; walkForward: { folds: number; positive: number; mean: number; worst: number; dispersion: number };
  positiveSymbols: number; evaluatedSymbols: number; shadowTrades: number; shadowExpectancyR: number;
  championForwardTrades: number; championForwardExpectancyR: number; state: "AWAITING_EVIDENCE" | "SHADOW" | "PROMOTED" | "REJECTED";
  historicalBySymbol: Record<string, { trades: number; expectancyR: number; profitFactor: number; maxDrawdownPct: number }>;
  outOfSampleBySymbol: Record<string, { trades: number; expectancyR: number; profitFactor: number; maxDrawdownPct: number }>;
  reasons: string[];
}

interface Aggregate {
  summary: PerfSummary;
  trades: number;
  perSymbol: Map<string, number[]>;
  folds: number[];
  validFolds: number;
  positiveFolds: number;
}

/** Evaluates persisted V2 versions only; no V1 scorer/backtester is reachable from this path. */
export function evaluateV2Lifecycle(store: Store, sourceHistories: ReadonlyMap<string, Candle[]>, timeframe: string,
  costs: V2CostModel, criteria: V2PromotionCriteria): V2Comparison[] {
  const histories = alignHistories(sourceHistories);
  const champions = getV2Champions(store);
  const comparisons: V2Comparison[] = [];
  for (const challenger of listV2Versions(store).filter((row) => row.status === "CHALLENGER" || row.status === "SHADOW")) {
    const champion = champions[challenger.strategy];
    const fullChampion = evaluateVersion(champion, histories, timeframe, costs);
    const fullChallenger = evaluateVersion(challenger, histories, timeframe, costs);
    const oos = trailingHistories(histories, criteria.outOfSampleFraction);
    const oosChampion = evaluateVersion(champion, oos, timeframe, costs);
    const oosChallenger = evaluateVersion(challenger, oos, timeframe, costs);
    const reasons: string[] = [];
    let comparison = makeComparison(champion, challenger, fullChallenger, oosChallenger, 0, 0, reasons, "AWAITING_EVIDENCE");

    if (challenger.status === "CHALLENGER") {
      const enough = fullChallenger.trades >= criteria.historicalMinTrades
        && fullChampion.trades >= criteria.historicalMinTrades
        && (!criteria.requireOutOfSample || (oosChallenger.trades >= criteria.outOfSampleMinTrades
          && oosChampion.trades >= criteria.outOfSampleMinTrades))
        && (!criteria.requireWalkForward || (fullChallenger.validFolds >= criteria.minimumWalkForwardFolds
          && fullChampion.validFolds >= criteria.minimumWalkForwardFolds))
        && (!criteria.requireMultiSymbol || histories.size >= criteria.minimumSymbols);
      if (!enough) {
        comparison.reasons.push(`awaiting comparable historical/OOS/walk-forward/cross-symbol evidence (challenger ${fullChallenger.trades}/${oosChallenger.trades} trades, Champion ${fullChampion.trades}/${oosChampion.trades}, ${histories.size} symbols)`);
        persistComparison(store, comparisons, comparison); continue;
      }
      const positiveSymbols = countPositiveSymbols(fullChallenger);
      const positiveSymbolFraction = fullChallenger.perSymbol.size ? positiveSymbols / fullChallenger.perSymbol.size : 0;
      const positiveFoldFraction = fullChallenger.validFolds ? fullChallenger.positiveFolds / fullChallenger.validFolds : 0;
      const failed = fullChallenger.summary.expectancy_r <= 0
        || (criteria.requireOutOfSample && (oosChallenger.summary.expectancy_r <= 0 || oosChallenger.summary.expectancy_r <= oosChampion.summary.expectancy_r))
        || fullChallenger.summary.expectancy_r <= fullChampion.summary.expectancy_r
        || fullChallenger.summary.max_drawdown_pct > fullChampion.summary.max_drawdown_pct + criteria.maxDrawdownDegradationPct
        || (criteria.requireMultiSymbol && positiveSymbolFraction < criteria.minPositiveSymbolFraction)
        || (criteria.requireWalkForward && (positiveFoldFraction < criteria.minPositiveWalkForwardFraction
          || meanOfValidFolds(fullChallenger) <= meanOfValidFolds(fullChampion)));
      if (failed) {
        reasons.push("historical gate failed: net expectancy/OOS/walk-forward/cross-symbol/drawdown criteria not met");
        transitionV2Version(store, challenger.strategy, challenger.version, "REJECTED", reasons[0]!, comparison);
        logSystemEvent(store, "CHALLENGER_HISTORICAL_FAIL", { strategy: challenger.strategy, version: challenger.version, comparison });
        comparison.state = "REJECTED"; comparison.reasons = reasons;
      } else {
        transitionV2Version(store, challenger.strategy, challenger.version, "SHADOW", "historical, OOS, walk-forward, and cross-symbol validation passed", comparison);
        logSystemEvent(store, "CHALLENGER_HISTORICAL_PASS", { strategy: challenger.strategy, version: challenger.version, comparison });
        logSystemEvent(store, "CHALLENGER_SHADOW_STARTED", { strategy: challenger.strategy, version: challenger.version });
        comparison.state = "SHADOW";
      }
        persistComparison(store, comparisons, comparison); continue;
    }

    const shadow = store.db.prepare(`SELECT net_r,instrument FROM shadow_trades WHERE engine='SWING_15M' AND strategy=?
      AND strategy_version=? AND status='CLOSED' ORDER BY exit_ts`)
      .all(challenger.strategy, challenger.version) as Array<{ net_r: number; instrument: string }>;
    const championForward = store.db.prepare(`SELECT result_r AS net_r FROM trades WHERE engine='SWING_15M' AND strategy=?
      AND strategy_version=? AND status='CLOSED' AND result_r_basis='NET' AND result_r IS NOT NULL ORDER BY exit_ts`)
      .all(champion.strategy, champion.version) as Array<{ net_r: number }>;
    const shadowSummary = summarize(shadow.map((row) => row.net_r));
    const champSummary = summarize(championForward.map((row) => row.net_r));
    const shadowBySymbol = new Map<string, number[]>();
    for (const row of shadow) shadowBySymbol.set(row.instrument, [...(shadowBySymbol.get(row.instrument) ?? []), row.net_r]);
    const positiveSymbols = [...shadowBySymbol.values()].filter((rs) => summarize(rs).expectancy_r > 0).length;
    comparison = makeComparison(champion, challenger, fullChallenger, oosChallenger,
      shadow.length, shadowSummary.expectancy_r, reasons, "SHADOW");
    comparison.championForwardTrades = championForward.length;
    comparison.championForwardExpectancyR = champSummary.expectancy_r;
    comparison.positiveSymbols = positiveSymbols;
    comparison.evaluatedSymbols = shadowBySymbol.size;
    if (!criteria.automaticPromotionEnabled) {
      comparison.reasons.push("automatic promotion is disabled by configuration");
      persistComparison(store, comparisons, comparison); continue;
    }
    if (shadow.length < criteria.shadowForwardMinTrades || championForward.length < criteria.championForwardMinTrades
      || (criteria.requireMultiSymbol && shadowBySymbol.size < criteria.minimumSymbols)) {
      comparison.reasons.push(`awaiting shadow/Champion forward evidence (${shadow.length}/${criteria.shadowForwardMinTrades} Challenger, ${championForward.length}/${criteria.championForwardMinTrades} Champion)`);
      persistComparison(store, comparisons, comparison); continue;
    }
    const robustSymbols = shadowBySymbol.size > 0 && positiveSymbols / shadowBySymbol.size >= criteria.minPositiveSymbolFraction;
    const promoted = shadowSummary.expectancy_r > 0 && shadowSummary.expectancy_r > champSummary.expectancy_r
      && shadowSummary.max_drawdown_pct <= champSummary.max_drawdown_pct + criteria.maxDrawdownDegradationPct
      && (!criteria.requireMultiSymbol || robustSymbols);
    if (promoted) {
      transitionV2Version(store, challenger.strategy, challenger.version, "PROMOTED", "shadow-forward net expectancy and risk gates passed", comparison);
      logSystemEvent(store, "PROMOTION", { engine: "SWING_15M", strategy: challenger.strategy, version: challenger.version, comparison });
      comparison.state = "PROMOTED";
    } else {
      comparison.reasons.push("shadow-forward gate failed: net expectancy, Champion comparison, symbol robustness, or drawdown");
      transitionV2Version(store, challenger.strategy, challenger.version, "REJECTED", comparison.reasons[0]!, comparison);
      logSystemEvent(store, "PROMOTION_REJECTED", { engine: "SWING_15M", strategy: challenger.strategy, version: challenger.version, comparison });
      comparison.state = "REJECTED";
    }
    persistComparison(store, comparisons, comparison);
  }
  return comparisons;
}

function evaluateVersion(definition: V2StrategyVersion, histories: ReadonlyMap<string, Candle[]>, timeframe: string,
  costs: V2CostModel): Aggregate {
  const perSymbol = new Map<string, number[]>();
  const all: number[] = [];
  const folds: number[] = [];
  let validFolds = 0, positiveFolds = 0;
  for (const [symbol, candles] of histories) {
    const params = completeV2Params(definition.strategy, definition.params);
    const result = backtestV2(definition.strategy, candles, timeframe, params, costs, symbol, definition.version);
    const rs = result.trades.map((trade) => trade.netR);
    perSymbol.set(symbol, rs); all.push(...rs);
    const wf = walkForwardV2(definition.strategy, candles, timeframe, 5, params, costs, definition.version);
    for (let i = 0; i < wf.foldExpectancies.length; i++) if (wf.foldTrades[i]! > 0) {
      validFolds++; folds.push(wf.foldExpectancies[i]!); if (wf.foldExpectancies[i]! > 0) positiveFolds++;
    }
  }
  return { summary: summarize(all), trades: all.length, perSymbol, folds, validFolds, positiveFolds };
}

function alignHistories(histories: ReadonlyMap<string, Candle[]>): Map<string, Candle[]> {
  const valid = [...histories.entries()].filter(([, candles]) => candles.length > 0);
  if (valid.length < 2) return new Map(valid);
  const start = Math.max(...valid.map(([, candles]) => candles[0]!.ts));
  const end = Math.min(...valid.map(([, candles]) => candles.at(-1)!.ts));
  return new Map(valid.map(([symbol, candles]) => [symbol, candles.filter((c) => c.ts >= start && c.ts <= end)]));
}

function trailingHistories(histories: ReadonlyMap<string, Candle[]>, fraction: number): Map<string, Candle[]> {
  return new Map([...histories.entries()].map(([symbol, candles]) => {
    const start = Math.floor(candles.length * (1 - fraction));
    return [symbol, candles.slice(start)];
  }));
}

function countPositiveSymbols(metrics: Aggregate): number {
  return [...metrics.perSymbol.values()].filter((rs) => summarize(rs).expectancy_r > 0).length;
}
function meanOfValidFolds(metrics: Aggregate): number { return metrics.folds.length ? metrics.folds.reduce((a, b) => a + b, 0) / metrics.folds.length : 0; }
function makeComparison(champion: V2StrategyVersion, challenger: V2StrategyVersion, historical: Aggregate, oos: Aggregate,
  shadowTrades: number, shadowExpectancyR: number, reasons: string[], state: V2Comparison["state"]): V2Comparison {
  return { strategy: challenger.strategy, championVersion: champion.version, challengerVersion: challenger.version,
    historicalTrades: historical.trades, historicalExpectancyR: historical.summary.expectancy_r,
    outOfSampleTrades: oos.trades, outOfSampleExpectancyR: oos.summary.expectancy_r,
    walkForward: { folds: historical.validFolds, positive: historical.positiveFolds, mean: meanOfValidFolds(historical),
      worst: historical.folds.length ? Math.min(...historical.folds) : 0,
      dispersion: dispersion(historical.folds) },
    positiveSymbols: countPositiveSymbols(historical), evaluatedSymbols: historical.perSymbol.size,
    shadowTrades, shadowExpectancyR, championForwardTrades: 0, championForwardExpectancyR: 0, state,
    historicalBySymbol: bySymbol(historical), outOfSampleBySymbol: bySymbol(oos), reasons: [...reasons] };
}
function bySymbol(metrics: Aggregate): V2Comparison["historicalBySymbol"] {
  return Object.fromEntries([...metrics.perSymbol.entries()].map(([symbol, rs]) => [symbol, {
    trades: rs.length,
    expectancyR: summarize(rs).expectancy_r,
    profitFactor: summarize(rs).profit_factor,
    maxDrawdownPct: summarize(rs).max_drawdown_pct,
  }]));
}
function persistComparison(store: Store, out: V2Comparison[], comparison: V2Comparison): void {
  store.db.prepare(`INSERT INTO strategy_v2_evaluations
    (ts,strategy,champion_version,challenger_version,stage,metrics) VALUES(?,?,?,?,?,?)`)
    .run(new Date().toISOString(), comparison.strategy, comparison.championVersion, comparison.challengerVersion,
      comparison.state, JSON.stringify(comparison));
  out.push(comparison);
}
function dispersion(values: number[]): number {
  if (!values.length) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  return Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length);
}
