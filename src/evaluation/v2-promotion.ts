import type { Candle } from "../exchange/okx/types.ts";
import type { Store } from "../memory/db.ts";
import { logSystemEvent, kvGet, kvSet } from "../memory/db.ts";
import { createHash } from "node:crypto";
import { backtestV2, rollingForwardRobustnessV2, type V2CostModel } from "./backtest.ts";
import { summarize, type PerfSummary } from "./performance.ts";
import { completeV2Params, getV2Champions, listV2Versions, transitionV2Version, type V2StrategyVersion } from "../strategy/v2-registry.ts";
import { familyForV2 } from "../strategy/identity.ts";

export interface V2PromotionCriteria {
  historicalMinTrades: number; outOfSampleMinTrades: number; shadowForwardMinTrades: number; championShadowMinTrades: number;
  outOfSampleFraction: number; minimumSymbols: number; minPositiveSymbolFraction: number; minPositiveWalkForwardFraction: number;
  minimumWalkForwardFolds: number; maxDrawdownDegradationPct: number; requireOutOfSample: boolean; requireWalkForward: boolean;
  requireMultiSymbol: boolean; automaticPromotionEnabled: boolean;
}
type SymbolMetric = { trades: number; expectancyR: number; profitFactor: number; maxDrawdownPct: number };
export interface V2Comparison {
  strategy: string; championVersion: number; challengerVersion: number; historicalTrades: number; historicalExpectancyR: number;
  outOfSampleTrades: number; outOfSampleExpectancyR: number; historicalBySymbol: Record<string, SymbolMetric>;
  outOfSampleBySymbol: Record<string, SymbolMetric>; rollingOos: { folds: number; positive: number; mean: number; worst: number; dispersion: number };
  positiveSymbols: number; evaluatedSymbols: number; shadowExperimentId: string | null; shadowStartedTs: string | null;
  championShadowTrades: number; championShadowExpectancyR: number; challengerShadowTrades: number; challengerShadowExpectancyR: number;
  championDemoTrades: number; championDemoExpectancyR: number; shadowBySymbol: Record<string, { champion: SymbolMetric; challenger: SymbolMetric }>;
  shadowMfeR: { champion: number; challenger: number }; shadowMaeR: { champion: number; challenger: number };
  shadowTrades: number; shadowExpectancyR: number; championForwardTrades: number; championForwardExpectancyR: number;
  state: "AWAITING_EVIDENCE" | "SHADOW" | "PROMOTED" | "REJECTED";
  validationCutoffTs: string | null; historicalEndTs: number | null; oosStartTs: number | null; oosEndTs: number | null; reasons: string[];
}
interface Aggregate { summary: PerfSummary; trades: number; bySymbol: Map<string, number[]>; folds: number[]; validFolds: number; positiveFolds: number }
interface ShadowEvidence { net_r: number; instrument: string; mfe_r: number; mae_r: number }

/** Fixed-parameter sequential OOS robustness folds are not rolling parameter fitting. */
export function evaluateV2Lifecycle(store: Store, source: ReadonlyMap<string, Candle[]>, timeframe: string,
  costs: V2CostModel, criteria: V2PromotionCriteria, tickSizes: ReadonlyMap<string, number> = new Map()): V2Comparison[] {
  const champions = getV2Champions(store), result: V2Comparison[] = [];
  for (const challenger of listV2Versions(store).filter((v) => v.status === "CHALLENGER" || v.status === "SHADOW")) {
    const champion = champions[challenger.strategy], cutoff = evidenceCutoff(challenger);
    const aligned = align(beforeCutoff(source, cutoff)), split = splitOos(aligned, criteria.outOfSampleFraction);
    const trainC = cachedEvaluate(store, champion, split.train, timeframe, costs, tickSizes, "train");
    const trainX = cachedEvaluate(store, challenger, split.train, timeframe, costs, tickSizes, "train");
    const oosC = cachedEvaluate(store, champion, split.oos, timeframe, costs, tickSizes, "oos");
    const oosX = cachedEvaluate(store, challenger, split.oos, timeframe, costs, tickSizes, "oos");
    let comparison = comparisonFor(champion, challenger, trainX, oosX, cutoff, split, "AWAITING_EVIDENCE");
    if (challenger.status === "CHALLENGER") {
      const enough = trainX.trades >= criteria.historicalMinTrades && trainC.trades >= criteria.historicalMinTrades
        && (!criteria.requireOutOfSample || (oosX.trades >= criteria.outOfSampleMinTrades && oosC.trades >= criteria.outOfSampleMinTrades))
        && (!criteria.requireWalkForward || (trainX.validFolds >= criteria.minimumWalkForwardFolds && trainC.validFolds >= criteria.minimumWalkForwardFolds))
        && (!criteria.requireMultiSymbol || aligned.size >= criteria.minimumSymbols);
      if (!enough) { comparison.reasons.push("awaiting separated historical/OOS/fold/symbol evidence"); save(store, result, comparison); continue; }
      const failed = trainX.summary.expectancy_r <= 0 || trainX.summary.expectancy_r <= trainC.summary.expectancy_r
        || (criteria.requireOutOfSample && (oosX.summary.expectancy_r <= 0 || oosX.summary.expectancy_r <= oosC.summary.expectancy_r))
        || trainX.summary.max_drawdown_pct > trainC.summary.max_drawdown_pct + criteria.maxDrawdownDegradationPct
        || (criteria.requireMultiSymbol && positiveFraction(trainX) < criteria.minPositiveSymbolFraction)
        || (criteria.requireWalkForward && (trainX.positiveFolds / trainX.validFolds < criteria.minPositiveWalkForwardFraction
          || mean(trainX.folds) <= mean(trainC.folds)));
      if (failed) {
        comparison.reasons.push("separated historical gate failed");
        transitionV2Version(store, challenger.strategy, challenger.version, "REJECTED", comparison.reasons[0]!, comparison);
        logSystemEvent(store, "CHALLENGER_HISTORICAL_FAIL", { comparison }); comparison.state = "REJECTED";
      } else {
        transitionV2Version(store, challenger.strategy, challenger.version, "SHADOW", "pre-evidence train/OOS/rolling-fold/symbol validation passed", comparison);
        const current = listV2Versions(store, challenger.strategy).find((v) => v.version === challenger.version)!;
        comparison.shadowStartedTs = current.shadow_started_ts;
        comparison.shadowExperimentId = current.shadow_started_ts ? experimentId(challenger, champion.version, current.shadow_started_ts) : null;
        comparison.state = "SHADOW";
        logSystemEvent(store, "CHALLENGER_HISTORICAL_PASS", { comparison });
        logSystemEvent(store, "CHALLENGER_SHADOW_STARTED", { strategy: challenger.strategy, version: challenger.version,
          experimentId: comparison.shadowExperimentId, shadowStartedTs: comparison.shadowStartedTs });
      }
      save(store, result, comparison); continue;
    }
    const started = challenger.shadow_started_ts;
    if (!started) { comparison.reasons.push("missing persisted shadow experiment boundary"); save(store, result, comparison); continue; }
    const expId = experimentId(challenger, champion.version, started), boundary = Date.parse(started), family = familyForV2(challenger.strategy);
    const read = (version: number, role: "CHAMPION" | "CHALLENGER") => store.db.prepare(
      `SELECT net_r,instrument,mfe_r,mae_r FROM shadow_trades WHERE engine='SWING_15M' AND strategy=? AND strategy_core_version=2
        AND strategy_version=? AND shadow_role=? AND shadow_experiment_id=? AND status='CLOSED' AND signal_ts>=? AND entry_ts>=? ORDER BY exit_ts`)
      .all(family, version, role, expId, boundary, boundary) as ShadowEvidence[];
    const cRows = read(champion.version, "CHAMPION"), xRows = read(challenger.version, "CHALLENGER");
    const c = summarize(cRows.map((r) => r.net_r)), x = summarize(xRows.map((r) => r.net_r));
    const symbol = pairedSymbols(cRows, xRows), quality = { pairs: Object.values(symbol).filter((p) => p.champion.trades && p.challenger.trades) };
    const demo = store.db.prepare(`SELECT result_r r FROM trades WHERE engine='SWING_15M' AND strategy=? AND strategy_core_version=2
      AND strategy_version=? AND status='CLOSED' AND evidence_state='VALID' AND evolution_evidence_eligible=1 AND result_r_basis='NET' AND result_r IS NOT NULL AND exit_ts>=?`)
      .all(family, champion.version, started) as Array<{ r: number }>;
    comparison = comparisonFor(champion, challenger, trainX, oosX, cutoff, split, "SHADOW");
    comparison.shadowExperimentId = expId; comparison.shadowStartedTs = started;
    comparison.championShadowTrades = cRows.length; comparison.championShadowExpectancyR = c.expectancy_r;
    comparison.challengerShadowTrades = xRows.length; comparison.challengerShadowExpectancyR = x.expectancy_r;
    comparison.championDemoTrades = demo.length; comparison.championDemoExpectancyR = summarize(demo.map((r) => r.r)).expectancy_r;
    comparison.shadowTrades = xRows.length; comparison.shadowExpectancyR = x.expectancy_r;
    comparison.championForwardTrades = cRows.length; comparison.championForwardExpectancyR = c.expectancy_r;
    comparison.shadowBySymbol = symbol; comparison.evaluatedSymbols = quality.pairs.length;
    comparison.positiveSymbols = quality.pairs.filter((p) => p.challenger.expectancyR > 0).length;
    comparison.shadowMfeR = { champion: mean(cRows.map((r) => r.mfe_r)), challenger: mean(xRows.map((r) => r.mfe_r)) };
    comparison.shadowMaeR = { champion: mean(cRows.map((r) => r.mae_r)), challenger: mean(xRows.map((r) => r.mae_r)) };
    if (!criteria.automaticPromotionEnabled) { comparison.reasons.push("automatic promotion disabled"); save(store, result, comparison); continue; }
    if (xRows.length < criteria.shadowForwardMinTrades || cRows.length < criteria.championShadowMinTrades
      || (criteria.requireMultiSymbol && quality.pairs.length < criteria.minimumSymbols)) {
      comparison.reasons.push(`awaiting matched-window evidence: Champion ${cRows.length}/${criteria.championShadowMinTrades}, Challenger ${xRows.length}/${criteria.shadowForwardMinTrades}`);
      save(store, result, comparison); continue;
    }
    const robust = quality.pairs.length > 0 && comparison.positiveSymbols / quality.pairs.length >= criteria.minPositiveSymbolFraction;
    const promote = x.expectancy_r > 0 && x.expectancy_r > c.expectancy_r && x.profit_factor >= c.profit_factor
      && x.max_drawdown_pct <= c.max_drawdown_pct + criteria.maxDrawdownDegradationPct
      && (!criteria.requireMultiSymbol || robust);
    if (promote) {
      transitionV2Version(store, challenger.strategy, challenger.version, "PROMOTED", "matched shadow expectancy/PF/robustness/drawdown gates passed", comparison);
      logSystemEvent(store, "PROMOTION", { comparison }); comparison.state = "PROMOTED";
    } else {
      comparison.reasons.push("matched shadow gate failed");
      transitionV2Version(store, challenger.strategy, challenger.version, "REJECTED", comparison.reasons[0]!, comparison);
      logSystemEvent(store, "PROMOTION_REJECTED", { comparison }); comparison.state = "REJECTED";
    }
    save(store, result, comparison);
  }
  return result;
}
function evidenceCutoff(v: V2StrategyVersion): number {
  try {
    const e = JSON.parse(String(v.evidence ?? "{}")) as { evidenceCutoffTs?: string; validationCutoffTs?: string };
    // Older lifecycle transitions replaced proposal context with validation.
    // Reuse its persisted cutoff when present; never extend it to newer candles.
    const ts = e.evidenceCutoffTs ?? e.validationCutoffTs;
    const n = ts ? Date.parse(ts) : NaN;
    if (Number.isFinite(n)) return n;
  }
  catch { /* legacy versions */ }
  return Date.parse(v.created_ts);
}
function beforeCutoff(h: ReadonlyMap<string, Candle[]>, t: number): Map<string, Candle[]> {
  return new Map([...h].map(([s, cs]) => [s, cs.filter((c) => c.confirm === "1" && c.ts < t)]));
}
function align(h: ReadonlyMap<string, Candle[]>): Map<string, Candle[]> {
  const valid = [...h].filter(([, cs]) => cs.length); if (valid.length < 2) return new Map(valid);
  const start = Math.max(...valid.map(([, cs]) => cs[0]!.ts)), end = Math.min(...valid.map(([, cs]) => cs.at(-1)!.ts));
  return new Map(valid.map(([s, cs]) => [s, cs.filter((c) => c.ts >= start && c.ts <= end)]));
}
function splitOos(h: ReadonlyMap<string, Candle[]>, fraction: number): {
  train: Map<string, Candle[]>; oos: Map<string, Candle[]>; historicalEndTs: number | null; oosStartTs: number | null; oosEndTs: number | null;
} {
  const all = [...h.values()].flat(); if (!all.length) return { train: new Map(), oos: new Map(), historicalEndTs: null, oosStartTs: null, oosEndTs: null };
  const start = all.reduce((n, c) => Math.min(n, c.ts), Infinity), end = all.reduce((n, c) => Math.max(n, c.ts), -Infinity), boundary = Math.floor(start + (end - start) * (1 - fraction));
  const train = new Map<string, Candle[]>(), oos = new Map<string, Candle[]>();
  for (const [s, cs] of h) { train.set(s, cs.filter((c) => c.ts < boundary)); oos.set(s, cs.filter((c) => c.ts >= boundary)); }
  return { train, oos, historicalEndTs: boundary - 1, oosStartTs: boundary, oosEndTs: end };
}
function evaluate(v: V2StrategyVersion, h: ReadonlyMap<string, Candle[]>, tf: string, costs: V2CostModel, ticks: ReadonlyMap<string, number>): Aggregate {
  const bySymbol = new Map<string, number[]>(), rs: number[] = [], folds: number[] = []; let validFolds = 0, positiveFolds = 0;
  for (const [symbol, candles] of h) {
    const p = completeV2Params(v.strategy, v.params), tick = ticks.get(symbol);
    const bt = backtestV2(v.strategy, candles, tf, p, costs, symbol, v.version, tick), r = bt.trades.map((t) => t.netR);
    bySymbol.set(symbol, r); rs.push(...r);
    const walk = rollingForwardRobustnessV2(v.strategy, candles, tf, 5, p, costs, v.version, tick);
    for (let i = 0; i < walk.foldExpectancies.length; i++) if (walk.foldTrades[i]! > 0) {
      validFolds++; folds.push(walk.foldExpectancies[i]!); if (walk.foldExpectancies[i]! > 0) positiveFolds++;
    }
  }
  return { summary: summarize(rs), trades: rs.length, bySymbol, folds, validFolds, positiveFolds };
}

// Revision must change when evaluator, feature, fill or metric semantics change.
// One replaceable slot per immutable version/stage bounds storage growth.
export const HISTORICAL_CACHE_REVISION = 4;
function cacheJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => item === Infinity ? "__POSITIVE_INFINITY__" : item);
}
function cacheDigest(value: unknown): string {
  return createHash("sha256").update(cacheJson(value)).digest("hex");
}
export function historicalFingerprint(v: Pick<V2StrategyVersion, "strategy" | "version" | "params">,
  h: ReadonlyMap<string, Candle[]>, tf: string, costs: V2CostModel, ticks: ReadonlyMap<string, number>): string {
  const hash = createHash("sha256").update(JSON.stringify({ revision: HISTORICAL_CACHE_REVISION, strategy: v.strategy, version: v.version, params: v.params, tf, costs }));
  for (const [symbol, candles] of h) {
    hash.update(JSON.stringify([symbol, ticks.get(symbol) ?? null]));
    for (const c of candles) hash.update(JSON.stringify([c.ts, c.o, c.h, c.l, c.c, c.vol, c.volCcy, c.confirm]));
  }
  return hash.digest("hex");
}
function cachedEvaluate(store: Store, v: V2StrategyVersion, h: ReadonlyMap<string, Candle[]>, tf: string, costs: V2CostModel,
  ticks: ReadonlyMap<string, number>, stage: string): Aggregate {
  const key = `historical_validation:${v.strategy}:${v.version}:${stage}`;
  const fingerprint = historicalFingerprint(v, h, tf, costs, ticks);
  try {
    const cached = JSON.parse(kvGet(store, key) ?? "null", (_key, value: unknown) => value === "__POSITIVE_INFINITY__" ? Infinity : value) as { fingerprint: string; valueDigest: string; value: Omit<Aggregate, "bySymbol"> & { bySymbol: Array<[string, number[]]> } } | null;
    if (cached?.fingerprint === fingerprint && cached.valueDigest === cacheDigest(cached.value) && validCachedAggregate(cached.value, h)) {
      return { ...cached.value, bySymbol: new Map(cached.value.bySymbol) };
    }
  } catch { /* Invalid caches are recomputed from source evidence. */ }
  const value = evaluate(v, h, tf, costs, ticks);
  const encoded = { ...value, bySymbol: [...value.bySymbol] };
  kvSet(store, key, cacheJson({ fingerprint, valueDigest: cacheDigest(encoded), value: encoded }));
  return value;
}
function validCachedAggregate(value: unknown, source: ReadonlyMap<string, Candle[]>): value is Omit<Aggregate, "bySymbol"> & { bySymbol: Array<[string, number[]]> } {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  const finiteArray = (v: unknown): v is number[] => Array.isArray(v) && v.every(n => typeof n === "number" && Number.isFinite(n));
  if (!Array.isArray(row.bySymbol) || !finiteArray(row.folds)) return false;
  const returns: number[] = [], symbols = new Set<string>();
  for (const pair of row.bySymbol) {
    if (!Array.isArray(pair) || pair.length !== 2 || typeof pair[0] !== "string" || !source.has(pair[0]) || symbols.has(pair[0]) || !finiteArray(pair[1])) return false;
    symbols.add(pair[0]); returns.push(...pair[1]);
  }
  if (symbols.size !== source.size || row.trades !== returns.length || row.validFolds !== row.folds.length
    || row.positiveFolds !== row.folds.filter(n => n > 0).length || !row.summary || typeof row.summary !== "object") return false;
  const summary = row.summary as Record<string, unknown>;
  return Object.entries(summarize(returns)).every(([key, number]) => summary[key] === number);
}
function positiveFraction(a: Aggregate): number {
  const values = [...a.bySymbol.values()].filter((rs) => rs.length); return values.length ? values.filter((rs) => summarize(rs).expectancy_r > 0).length / values.length : 0;
}
function mean(xs: number[]): number { return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0; }
function bySymbol(a: Aggregate): Record<string, SymbolMetric> {
  return Object.fromEntries([...a.bySymbol].map(([s, rs]) => { const m = summarize(rs); return [s, { trades: rs.length, expectancyR: m.expectancy_r, profitFactor: m.profit_factor, maxDrawdownPct: m.max_drawdown_pct }]; }));
}
function pairedSymbols(c: ShadowEvidence[], x: ShadowEvidence[]): V2Comparison["shadowBySymbol"] {
  const symbols = new Set([...c.map((r) => r.instrument), ...x.map((r) => r.instrument)]);
  const metric = (rows: ShadowEvidence[], s: string): SymbolMetric => {
    const selected = rows.filter((r) => r.instrument === s), m = summarize(selected.map((r) => r.net_r));
    return { trades: selected.length, expectancyR: m.expectancy_r, profitFactor: m.profit_factor, maxDrawdownPct: m.max_drawdown_pct };
  };
  return Object.fromEntries([...symbols].map((s) => [s, { champion: metric(c, s), challenger: metric(x, s) }]));
}
function comparisonFor(c: V2StrategyVersion, x: V2StrategyVersion, hist: Aggregate, oos: Aggregate, cutoff: number,
  split: { historicalEndTs: number | null; oosStartTs: number | null; oosEndTs: number | null }, state: V2Comparison["state"]): V2Comparison {
  return { strategy: x.strategy, championVersion: c.version, challengerVersion: x.version,
    historicalTrades: hist.trades, historicalExpectancyR: hist.summary.expectancy_r, outOfSampleTrades: oos.trades,
    outOfSampleExpectancyR: oos.summary.expectancy_r, historicalBySymbol: bySymbol(hist), outOfSampleBySymbol: bySymbol(oos),
    rollingOos: { folds: hist.validFolds, positive: hist.positiveFolds, mean: mean(hist.folds),
      worst: hist.folds.length ? Math.min(...hist.folds) : 0,
      dispersion: hist.folds.length ? Math.sqrt(mean(hist.folds.map((v) => (v - mean(hist.folds)) ** 2))) : 0 },
    positiveSymbols: [...hist.bySymbol.values()].filter((rs) => rs.length && summarize(rs).expectancy_r > 0).length,
    evaluatedSymbols: hist.bySymbol.size, shadowExperimentId: null, shadowStartedTs: x.shadow_started_ts,
    championShadowTrades: 0, championShadowExpectancyR: 0, challengerShadowTrades: 0, challengerShadowExpectancyR: 0,
    championDemoTrades: 0, championDemoExpectancyR: 0, shadowBySymbol: {}, shadowMfeR: { champion: 0, challenger: 0 },
    shadowMaeR: { champion: 0, challenger: 0 }, shadowTrades: 0, shadowExpectancyR: 0,
    championForwardTrades: 0, championForwardExpectancyR: 0, state,
    validationCutoffTs: Number.isFinite(cutoff) ? new Date(cutoff).toISOString() : null, ...split, reasons: [] };
}
function experimentId(chal: V2StrategyVersion, parent: number, started: string): string {
  return `SWING_15M:${familyForV2(chal.strategy)}:core2:v${parent}-v${chal.version}:${started}`;
}
function save(store: Store, result: V2Comparison[], row: V2Comparison): void {
  store.db.prepare(`INSERT INTO strategy_v2_evaluations(ts,strategy,champion_version,challenger_version,stage,metrics) VALUES(?,?,?,?,?,?)`)
    .run(new Date().toISOString(), row.strategy, row.championVersion, row.challengerVersion, row.state, JSON.stringify(row));
  result.push(row);
}
