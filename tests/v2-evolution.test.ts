import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { openStore } from "../src/memory/db.ts";
import { DEFAULT_V2_PARAMS, type StrategyV2Id } from "../src/strategy/core-v2.ts";
import { evaluateV2Setup } from "../src/strategy/core-v2.ts";
import { identityForV2 } from "../src/strategy/identity.ts";
import { closeTrade, openTrade } from "../src/memory/trades.ts";
import { createV2Challenger, ensureV2Registry, getV2Champions, listV2Versions, transitionV2Version } from "../src/strategy/v2-registry.ts";
import { evolutionReviewEligible, getV2EvolutionEvidence, validateV2Proposal, v2EvolutionStateKey } from "../src/agents/v2-evolution.ts";
import { measureContributions } from "../src/learning/signal-weights.ts";
import { calculateExecutionCostR, DEFAULT_V2_COSTS } from "../src/evaluation/backtest.ts";
import { evaluateV2Lifecycle } from "../src/evaluation/v2-promotion.ts";
import { processShadowCycle, shadowExperimentId } from "../src/evaluation/shadow-challenger.ts";
import { resolveRuntimePolicy } from "../src/core/runtime-policy.ts";
import { runOncePerGlobalCycle } from "../src/core/global-cycle.ts";
import type { Candle } from "../src/exchange/okx/types.ts";
import type { FeatureSnapshot } from "../src/market/features.ts";
import type { V2PromotionCriteria } from "../src/evaluation/v2-promotion.ts";

function store() { return openStore(mkdtempSync(path.join(os.tmpdir(), "evoq-v2-evolution-"))); }
function candle(ts: number, o: number, h: number, l: number, c: number): Candle {
  return { ts, o, h, l, c, vol: 130, volCcy: 130, confirm: "1" };
}
function feature(ts: number, price = 101): FeatureSnapshot {
  return { ts, instrument: "BTC-USDT-SWAP", price, ema20: 100, ema50: 99,
    emaSpreadPct: 1, ema20SlopePct: 0.2, distanceFromEma20Pct: 1,
    rsi14: 60, adx14: 30, atr14: 1, atrPct: 1, volume: 130, volumeSma20: 100,
    volumeRatio: 1.3, sufficientData: true };
}
function proposalParams(strategy: StrategyV2Id) { return DEFAULT_V2_PARAMS[strategy]; }
const promotionCriteria: V2PromotionCriteria = {
  historicalMinTrades: 50, outOfSampleMinTrades: 15, shadowForwardMinTrades: 15,
  championShadowMinTrades: 15, outOfSampleFraction: 0.3, minimumSymbols: 2,
  minPositiveSymbolFraction: 0.5, minPositiveWalkForwardFraction: 0.5,
  minimumWalkForwardFolds: 2, maxDrawdownDegradationPct: 0.5,
  requireOutOfSample: true, requireWalkForward: true, requireMultiSymbol: true,
  automaticPromotionEnabled: true,
};

test("V2 selection and baseline overlay are independent; normal V2 keeps evolution, scalp and configured cap", () => {
  const normal = resolveRuntimePolicy({ strategyCoreVersion: 2, baselineMode: false,
    evolutionConfiguredEnabled: true, scalpConfiguredEnabled: true, configuredMaxPositions: 3 });
  assert.deepEqual(normal, { strategyCoreVersion: 2, evolutionEnabled: true, scalpEnabled: true, maxConcurrentPositions: 3 });
  const baseline = resolveRuntimePolicy({ strategyCoreVersion: 2, baselineMode: true,
    evolutionConfiguredEnabled: true, scalpConfiguredEnabled: true, configuredMaxPositions: 3 });
  assert.deepEqual(baseline, { strategyCoreVersion: 2, evolutionEnabled: false, scalpEnabled: false, maxConcurrentPositions: 1 });
  assert.equal(resolveRuntimePolicy({ strategyCoreVersion: 1, baselineMode: true,
    evolutionConfiguredEnabled: true, scalpConfiguredEnabled: false, configuredMaxPositions: 2 }).strategyCoreVersion, 1);
});

test("V2 registry imports valid historical V2 params, isolates V1 rows, and prevents parameter mutation", () => {
  const db = store();
  db.db.prepare(`INSERT INTO strategy_versions(name,version,params,status,created_ts,hypothesis)
    VALUES('TREND_FOLLOWING',2,?,'TESTING','2026-10-01T00:00:00Z','legacy V2')`)
    .run(JSON.stringify(DEFAULT_V2_PARAMS.TREND_FOLLOWING_V2));
  ensureV2Registry(db);
  const champion = getV2Champions(db).TREND_FOLLOWING_V2;
  assert.equal(champion.version, 2);
  assert.deepEqual(champion.params, DEFAULT_V2_PARAMS.TREND_FOLLOWING_V2);
  assert.equal((db.db.prepare("SELECT status FROM strategy_versions WHERE name='TREND_FOLLOWING' AND version=2").get() as { status: string }).status, "TESTING");
  assert.throws(() => db.db.prepare("UPDATE strategy_v2_versions SET params='{}' WHERE strategy='TREND_FOLLOWING_V2' AND version=2").run(), /immutable/);
  assert.equal(listV2Versions(db).filter((row) => row.status === "CHAMPION").length, 3);
  db.close();
});

test("V2 proposals validate each family schema and only permit one bounded parameter", () => {
  const cases: Array<{ strategy: StrategyV2Id; changedParameter: string; oldValue: number; newValue: number }> = [
    { strategy: "TREND_FOLLOWING_V2", changedParameter: "max_extension_atr", oldValue: 1.2, newValue: 1.1 },
    { strategy: "BREAKOUT_V2", changedParameter: "min_breakout_atr", oldValue: 0.1, newValue: 0.11 },
    { strategy: "MEAN_REVERSION_V2", changedParameter: "rsi_high", oldValue: 70, newValue: 70.2 },
  ];
  for (const item of cases) {
    const valid = validateV2Proposal({ ...item, parentVersion: 2 }, { version: 2, params: proposalParams(item.strategy) }, 1, 10);
    assert.equal(valid.ok, true, `${item.strategy}: ${valid.reason ?? ""}`);
  }
  const trend = proposalParams("TREND_FOLLOWING_V2");
  assert.equal(validateV2Proposal({ strategy: "TREND_FOLLOWING_V2", parentVersion: 2,
    changedParameter: "lookback_bars", oldValue: 20, newValue: 19 }, { version: 2, params: trend }, 1, 10).ok, false);
  assert.equal(validateV2Proposal({ strategy: "TREND_FOLLOWING_V2", parentVersion: 2,
    changedParameter: "max_extension_atr", oldValue: 1.2, newValue: 1.5 }, { version: 2, params: trend }, 1, 10).ok, false);
  assert.equal(validateV2Proposal({ strategy: "TREND_FOLLOWING_V2", parentVersion: 2,
    changedParameter: "max_extension_atr", oldValue: 1.2, newValue: 1.1 }, { version: 2, params: trend }, 2, 10).ok, false);
});

test("V2 candidate persistence flows into isolated net evidence, learning, and version-scoped evolution cadence", () => {
  const db = store();
  const strategy = "TREND_FOLLOWING_V2" as const;
  const strategyVersion = 3;
  const snapshot = feature(Date.now());
  const evaluated = evaluateV2Setup(strategy, snapshot, [], DEFAULT_V2_PARAMS, strategyVersion);
  assert.ok(evaluated.candidate, "deterministic setup produces the persisted V2 candidate");
  const candidate = evaluated.candidate!;
  for (let i = 0; i < 20; i++) {
    const tradeId = `V2-E2E-${i}`;
    const entryTs = new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString();
    openTrade(db, { tradeId, instrument: candidate.instrument, timeframe: "15m", side: candidate.side,
      strategy: candidate.strategy, strategyVersion, identity: identityForV2(candidate.strategy, strategyVersion),
      regime: candidate.regime.trend, regimeAxes: candidate.regime, contracts: "1", entryPx: candidate.entryPrice,
      entryTs, stopPx: candidate.stopPrice, takeProfitPx: candidate.takeProfitPrice, clOpenId: `cl-${i}`,
      ordOpenId: `ord-${i}`, rawConfidence: 0.75, calibratedConfidence: 0.75, plannedRiskPct: 0.5,
      leverage: 2, maxHoldBars: candidate.maxHoldBars, entryFeatures: candidate.features, entryConditions: candidate.conditions });
    closeTrade(db, tradeId, { exitPx: candidate.takeProfitPrice, exitTs: new Date(Date.UTC(2026, 0, 1, 0, i + 1)).toISOString(),
      exitReason: "TP", fees: 0.1, funding: 0, pnl: 1, pnlPct: 1, resultR: 1.5,
      mfe: 1.5, mae: 0.1, durationS: 60 });
  }
  // A same-family, same-version-number Core 1 row must stay outside V2 evidence.
  openTrade(db, { tradeId: "V1-SAME-FAMILY", instrument: candidate.instrument, timeframe: "15m", side: "LONG",
    strategy: "TREND_FOLLOWING", strategyVersion, regime: "BULL_TREND", contracts: "1", entryPx: 100,
    entryTs: "2026-01-02T00:00:00.000Z", stopPx: 98, takeProfitPx: 104, clOpenId: "v1-cl", ordOpenId: "v1-ord",
    rawConfidence: 0.5, calibratedConfidence: 0.5, plannedRiskPct: 0.5, leverage: 2, entryFeatures: snapshot });
  closeTrade(db, "V1-SAME-FAMILY", { exitPx: 96, exitTs: "2026-01-02T00:01:00.000Z", exitReason: "SL",
    fees: 0, funding: 0, pnl: -1, pnlPct: -4, resultR: -1, mfe: 0, mae: 4, durationS: 60 });
  const saved = db.db.prepare("SELECT strategy,strategy_core_version,strategy_version FROM trades WHERE trade_id='V2-E2E-0'")
    .get() as { strategy: string; strategy_core_version: number; strategy_version: number };
  assert.deepEqual(saved, { strategy: "TREND_FOLLOWING", strategy_core_version: 2, strategy_version: 3 });
  assert.equal(getV2EvolutionEvidence(db, strategy, 3).length, 20);
  assert.equal(getV2EvolutionEvidence(db, strategy, 3, "SCALP_5M").length, 0);
  assert.ok(measureContributions(db, "SWING_15M", { strategy: "TREND_FOLLOWING", strategyCoreVersion: 2, strategyVersion: 3 }).trend > 0.9);
  assert.ok(measureContributions(db, "SWING_15M", { strategy: "TREND_FOLLOWING", strategyCoreVersion: 1, strategyVersion: 3 }).trend < -0.5);
  assert.equal(evolutionReviewEligible(19, 0, 20, 15), false);
  assert.equal(evolutionReviewEligible(20, 0, 20, 15), true);
  assert.equal(evolutionReviewEligible(34, 20, 20, 15), false);
  assert.equal(evolutionReviewEligible(35, 20, 20, 15), true);
  assert.equal(evolutionReviewEligible(50, 35, 20, 15), true);
  assert.notEqual(v2EvolutionStateKey("SWING_15M", strategy, 2), v2EvolutionStateKey("SWING_15M", strategy, 3));
  db.close();
});

test("cost R charges entry/exit fees and per-side friction once against separate notionals", () => {
  const costs = { ...DEFAULT_V2_COSTS, entryFeePct: 0.05, exitFeePct: 0.05, slippageBps: 1.5, spreadBps: 1.5 };
  // (100*.0005 + 110*.0005 + 100*.0003 + 110*.0003) / 10 = 0.0168R.
  assert.ok(Math.abs(calculateExecutionCostR(100, 110, 10, costs) - 0.0168) < 1e-12);
  assert.ok(calculateExecutionCostR(100, 110, 10, costs) < 0.02);
});

test("shadow Challenger simulates next-open entry and exit in its own ledger without touching live trades/orders", () => {
  const db = store(); ensureV2Registry(db);
  const params = { ...DEFAULT_V2_PARAMS.TREND_FOLLOWING_V2, max_hold_bars: 32 };
  const version = createV2Challenger(db, { strategy: "TREND_FOLLOWING_V2", parentVersion: 2,
    params, changedParameter: "max_hold_bars", oldValue: 32, newValue: 32,
    hypothesis: "Shadow simulation fixture for isolated lifecycle testing.", evidence: { sample: 50 } });
  transitionV2Version(db, "TREND_FOLLOWING_V2", version, "SHADOW", "test historical pass");
  const boundary = Date.parse(listV2Versions(db, "TREND_FOLLOWING_V2").find((row) => row.version === version)!.shadow_started_ts!);
  const ts = boundary + 1;
  const snapshots = [{ instrument: "BTC-USDT-SWAP", features: feature(ts) }];
  const history = new Map([["BTC-USDT-SWAP", [candle(ts, 101, 101.2, 100.8, 101)]]]);
  assert.equal(processShadowCycle(db, snapshots, history, "15m", DEFAULT_V2_COSTS), 2);
  const matched = db.db.prepare("SELECT shadow_role,shadow_experiment_id,signal_ts,costs_json FROM shadow_trades ORDER BY shadow_role")
    .all() as Array<{ shadow_role: string; shadow_experiment_id: string; signal_ts: number; costs_json: string }>;
  assert.deepEqual(matched.map((row) => row.shadow_role), ["CHALLENGER", "CHAMPION"].sort());
  assert.equal(matched[0]?.shadow_experiment_id, matched[1]?.shadow_experiment_id);
  assert.equal(matched[0]?.signal_ts, matched[1]?.signal_ts);
  assert.equal(matched[0]?.costs_json, matched[1]?.costs_json);
  const shadowId = (db.db.prepare("SELECT shadow_trade_id FROM shadow_trades WHERE shadow_role='CHALLENGER' AND strategy_version=?").get(version) as { shadow_trade_id: string }).shadow_trade_id;
  assert.equal((db.db.prepare("SELECT status FROM shadow_trades WHERE shadow_trade_id=?").get(shadowId) as { status: string }).status, "PENDING");

  const entryHistory = new Map([["BTC-USDT-SWAP", [candle(ts, 101, 101.2, 100.8, 101), candle(ts + 1, 101, 102, 100, 101.5)]]]);
  processShadowCycle(db, [{ instrument: "BTC-USDT-SWAP", features: feature(ts + 1, 101.5) }], entryHistory, "15m", DEFAULT_V2_COSTS);
  assert.equal((db.db.prepare("SELECT COUNT(*) AS count FROM shadow_trades WHERE strategy_version=? AND shadow_role='CHALLENGER' AND instrument='BTC-USDT-SWAP'").get(version) as { count: number }).count, 1,
    "one shadow position per Challenger/instrument prevents overlapping forward samples");
  const open = db.db.prepare("SELECT status,entry_ts,entry_price,stop_price,take_profit_price,costs_json FROM shadow_trades WHERE shadow_trade_id=?").get(shadowId) as {
    status: string; entry_ts: number; entry_price: number; stop_price: number; take_profit_price: number; costs_json: string;
  };
  assert.equal(open.status, "OPEN"); assert.equal(open.entry_ts, ts + 1); assert.equal(open.entry_price, 101);
  assert.equal(open.stop_price, 99.5); assert.equal(open.take_profit_price, 104.75);
  assert.deepEqual(JSON.parse(open.costs_json), DEFAULT_V2_COSTS);

  const exitHistory = new Map([["BTC-USDT-SWAP", [...entryHistory.get("BTC-USDT-SWAP")!, candle(ts + 2, 102, 105, 101.8, 104.5)]]]);
  processShadowCycle(db, [{ instrument: "BTC-USDT-SWAP", features: feature(ts + 2, 104.5) }], exitHistory, "15m", DEFAULT_V2_COSTS);
  const closed = db.db.prepare("SELECT status,exit_reason,gross_r,net_r,fees_r,mfe_r,mae_r FROM shadow_trades WHERE shadow_trade_id=?").get(shadowId) as {
    status: string; exit_reason: string; gross_r: number; net_r: number; fees_r: number; mfe_r: number; mae_r: number;
  };
  assert.equal(closed.status, "CLOSED"); assert.equal(closed.exit_reason, "TP");
  assert.ok(closed.gross_r > closed.net_r); assert.ok(closed.fees_r > 0); assert.ok(closed.mfe_r > 0);
  assert.equal((db.db.prepare("SELECT COUNT(*) n FROM shadow_trades").get() as { n: number }).n, 2,
    "an exit during this cycle cannot create a same-candle replacement signal");
  assert.equal((db.db.prepare("SELECT COUNT(*) n FROM trades").get() as { n: number }).n, 0);
  assert.equal((db.db.prepare("SELECT COUNT(*) n FROM orders").get() as { n: number }).n, 0);
  db.close();
});

test("matched forward promotion waits for both roles and atomically promotes the V2 Challenger", () => {
  const db = store(); ensureV2Registry(db);
  const version = createV2Challenger(db, { strategy: "TREND_FOLLOWING_V2", parentVersion: 2,
    params: { ...DEFAULT_V2_PARAMS.TREND_FOLLOWING_V2, max_extension_atr: 1.1 },
    changedParameter: "max_extension_atr", oldValue: 1.2, newValue: 1.1,
    hypothesis: "A modestly lower extension limit may improve matched continuation outcomes.", evidence: { sample: 50 } });
  transitionV2Version(db, "TREND_FOLLOWING_V2", version, "SHADOW", "synthetic separated historical gates passed");
  const shadow = listV2Versions(db, "TREND_FOLLOWING_V2").find((row) => row.version === version)!;
  const boundary = Date.parse(shadow.shadow_started_ts!);
  const experiment = shadowExperimentId("TREND_FOLLOWING_V2", 2, version, shadow.shadow_started_ts!);
  const insert = db.db.prepare(`INSERT INTO shadow_trades(shadow_trade_id,engine,strategy,strategy_core_version,strategy_version,
    shadow_role,shadow_experiment_id,instrument,side,status,signal_ts,last_processed_ts,entry_ts,exit_ts,signal_price,entry_price,
    exit_price,stop_price,initial_stop_price,take_profit_price,stop_atr,target_r,max_hold_bars,risk_distance,active_stop,
    regime,regime_axes,entry_conditions,exit_reason,gross_r,net_r,fees_r,mfe_r,mae_r,costs_json)
    VALUES(?, 'SWING_15M','TREND_FOLLOWING',2,?,?,?,?,'LONG','CLOSED',?,?,?,?,100,100,101,99,99,102,1.5,2.5,32,1,99,
      'BULL_TREND','{}','[]','TP',?,?,0.01,0.5,0.1,?)`);
  const add = (role: "CHAMPION" | "CHALLENGER", count: number, offset = 0) => {
    for (let j = 0; j < count; j++) {
      const i = offset + j;
      const ts = boundary + i * 60_000;
      insert.run(`${role}-${i}`, role === "CHAMPION" ? 2 : version, role, experiment, i < 8 ? "BTC-USDT-SWAP" : "ETH-USDT-SWAP",
        ts, ts, ts + 1, ts + 2, role === "CHAMPION" ? 0.1 : 0.3,
        role === "CHAMPION" ? 0.1 : 0.3, JSON.stringify(DEFAULT_V2_COSTS));
    }
  };
  add("CHALLENGER", 15); add("CHAMPION", 14);
  const waiting = evaluateV2Lifecycle(db, new Map(), "15m", DEFAULT_V2_COSTS, promotionCriteria);
  assert.equal(waiting[0]?.state, "SHADOW");
  assert.match(waiting[0]?.reasons.join(" ") ?? "", /Champion 14\/15/);
  assert.equal(getV2Champions(db).TREND_FOLLOWING_V2.version, 2);
  add("CHAMPION", 1, 14);
  const promoted = evaluateV2Lifecycle(db, new Map(), "15m", DEFAULT_V2_COSTS, promotionCriteria);
  assert.equal(promoted[0]?.state, "PROMOTED", promoted[0]?.reasons.join(" | "));
  assert.equal(promoted[0]?.championShadowTrades, 15);
  assert.equal(promoted[0]?.challengerShadowTrades, 15);
  const versions = listV2Versions(db, "TREND_FOLLOWING_V2");
  assert.equal(getV2Champions(db).TREND_FOLLOWING_V2.version, version);
  assert.equal(versions.find((row) => row.version === 2)?.status, "SUPERSEDED");
  db.close();
});

test("V2 historical pass enters matched no-LLM shadow and deterministically promotes immutable V3", () => {
  const db = store(); ensureV2Registry(db);
  const symbols = ["BTC-USDT-SWAP", "ETH-USDT-SWAP", "SOL-USDT-SWAP", "XRP-USDT-SWAP"];
  const stepMs = 15 * 60_000;
  const priceAt = (i: number) => 100 + 0.02 * i + 0.3 * Math.sin(i / 3);
  const baseTs = Date.now() - 3000 * stepMs - 10_000;
  const historical = Array.from({ length: 3000 }, (_, i) => {
    const open = priceAt(i), close = priceAt(i + 1);
    return { ...candle(baseTs + i * stepMs, open, Math.max(open, close) + 0.06,
      Math.min(open, close) - 0.06, close), vol: i % 5 === 0 ? 200 : 100 };
  });
  const history = new Map(symbols.map((symbol) => [symbol, [...historical]]));
  const lastEvidenceTs = historical.at(-1)!.ts;
  const version = createV2Challenger(db, { strategy: "TREND_FOLLOWING_V2", parentVersion: 2,
    params: { ...DEFAULT_V2_PARAMS.TREND_FOLLOWING_V2, max_extension_atr: 0.8 },
    changedParameter: "max_extension_atr", oldValue: 1.2, newValue: 0.8,
    hypothesis: "Rejecting extended continuation entries improves net R in this synthetic fixture.",
    evidence: { sample: 50, evidenceCutoffTs: new Date(lastEvidenceTs).toISOString() } });
  const ticks = new Map(symbols.map((symbol) => [symbol, 0.1]));
  const historicalResult = evaluateV2Lifecycle(db, history, "15m", DEFAULT_V2_COSTS, promotionCriteria, ticks);
  assert.equal(historicalResult[0]?.state, "SHADOW", historicalResult[0]?.reasons.join(" | "));
  assert.ok(historicalResult[0]!.historicalTrades >= 50);
  assert.ok(historicalResult[0]!.outOfSampleTrades >= 15);
  assert.ok(historicalResult[0]!.historicalEndTs! < historicalResult[0]!.oosStartTs!);
  const challenger = listV2Versions(db, "TREND_FOLLOWING_V2").find((row) => row.version === version)!;
  assert.ok(challenger.shadow_started_ts);
  const boundary = Date.parse(challenger.shadow_started_ts!);
  const shadowPrice = priceAt(2999);
  const shadowFeature = (symbol: string, ts: number, extension: number): FeatureSnapshot => ({
    ...feature(ts, shadowPrice), instrument: symbol, ema20: shadowPrice - extension, ema50: shadowPrice - extension - 1,
  });
  const runCycle = (ts: number, extension: number, outcome: "NORMAL" | "WIN" | "LOSS") => {
    const snapshots = symbols.map((instrument) => ({ instrument,
      features: shadowFeature(instrument, ts, extension), tickSize: 0.1 }));
    for (const symbol of symbols) {
      const historyRows = history.get(symbol)!;
      const high = outcome === "WIN" ? shadowPrice + 4 : outcome === "LOSS" ? shadowPrice + 0.1 : shadowPrice + 0.1;
      const low = outcome === "LOSS" ? shadowPrice - 2 : shadowPrice - 0.1;
      history.set(symbol, [...historyRows, candle(ts, shadowPrice, high, low, shadowPrice)]);
    }
    processShadowCycle(db, snapshots, history, "15m", DEFAULT_V2_COSTS);
  };
  let ts = boundary + stepMs;
  for (let i = 0; i < 15; i++) {
    for (const extension of [0.5, 1.0]) {
      runCycle(ts, extension, "NORMAL");
      runCycle(ts + stepMs, extension, "NORMAL");
      runCycle(ts + 2 * stepMs, extension, extension === 0.5 ? "WIN" : "LOSS");
      ts += 3 * stepMs;
    }
  }
  const roles = db.db.prepare(`SELECT shadow_role role,COUNT(*) trades FROM shadow_trades
    WHERE shadow_experiment_id=? AND status='CLOSED' GROUP BY shadow_role ORDER BY shadow_role`)
    .all(shadowExperimentId("TREND_FOLLOWING_V2", 2, version, challenger.shadow_started_ts!)) as Array<{ role: string; trades: number }>;
  assert.deepEqual(roles, [{ role: "CHALLENGER", trades: 60 }, { role: "CHAMPION", trades: 120 }]);
  assert.equal((db.db.prepare("SELECT COUNT(*) n FROM trades").get() as { n: number }).n, 0);
  assert.equal((db.db.prepare("SELECT COUNT(*) n FROM orders").get() as { n: number }).n, 0);
  const final = evaluateV2Lifecycle(db, history, "15m", DEFAULT_V2_COSTS, promotionCriteria, ticks);
  assert.equal(final[0]?.state, "PROMOTED", final[0]?.reasons.join(" | "));
  assert.ok(final[0]!.challengerShadowExpectancyR > final[0]!.championShadowExpectancyR);
  assert.equal(getV2Champions(db).TREND_FOLLOWING_V2.version, version);
  assert.equal(listV2Versions(db, "TREND_FOLLOWING_V2").find((row) => row.version === 2)?.status, "SUPERSEDED");
  db.close();
});

test("max-hold bars time-stop shadow trades on the next modeled candle open", () => {
  const db = store(); ensureV2Registry(db);
  const params = { ...DEFAULT_V2_PARAMS.TREND_FOLLOWING_V2, max_hold_bars: 1 };
  const version = createV2Challenger(db, { strategy: "TREND_FOLLOWING_V2", parentVersion: 2,
    params, changedParameter: "max_hold_bars", oldValue: 32, newValue: 1,
    hypothesis: "A one-bar max holding horizon exits at the next modeled open.", evidence: { sample: 50 } });
  transitionV2Version(db, "TREND_FOLLOWING_V2", version, "SHADOW", "test historical pass");
  const boundary = Date.parse(listV2Versions(db, "TREND_FOLLOWING_V2").find((row) => row.version === version)!.shadow_started_ts!);
  const t = boundary + 1;
  const first = [candle(t, 101, 101.2, 100.8, 101)];
  processShadowCycle(db, [{ instrument: "BTC-USDT-SWAP", features: feature(t) }], new Map([["BTC-USDT-SWAP", first]]), "15m", DEFAULT_V2_COSTS);
  const second = [...first, candle(t + 1, 101, 102, 100, 101.5)];
  processShadowCycle(db, [{ instrument: "BTC-USDT-SWAP", features: feature(t + 1, 101.5) }], new Map([["BTC-USDT-SWAP", second]]), "15m", DEFAULT_V2_COSTS);
  const third = [...second, candle(t + 2, 101.2, 101.4, 100.9, 101.1)];
  processShadowCycle(db, [{ instrument: "BTC-USDT-SWAP", features: feature(t + 2, 101.1) }], new Map([["BTC-USDT-SWAP", third]]), "15m", DEFAULT_V2_COSTS);
  const closed = db.db.prepare("SELECT exit_reason,exit_price FROM shadow_trades WHERE strategy_version=? AND shadow_role='CHALLENGER' AND status='CLOSED'").get(version) as { exit_reason: string; exit_price: number };
  assert.equal(closed.exit_reason, "TIME_STOP"); assert.equal(closed.exit_price, 101.2);
  db.close();
});

test("historical-only evidence cannot promote a shadow Challenger; no forward sample remains awaiting", () => {
  const db = store(); ensureV2Registry(db);
  const version = createV2Challenger(db, { strategy: "TREND_FOLLOWING_V2", parentVersion: 2,
    params: { ...DEFAULT_V2_PARAMS.TREND_FOLLOWING_V2, max_extension_atr: 1.1 },
    changedParameter: "max_extension_atr", oldValue: 1.2, newValue: 1.1,
    hypothesis: "Slightly lower trend extension filter tests continuation entries.", evidence: { sample: 50 } });
  transitionV2Version(db, "TREND_FOLLOWING_V2", version, "SHADOW", "synthetic historical pass");
  const candles = Array.from({ length: 120 }, (_, i) => candle(i + 1, 100 + i * 0.02, 100.2 + i * 0.02, 99.8 + i * 0.02, 100 + i * 0.02));
  const history = new Map([["BTC-USDT-SWAP", candles], ["ETH-USDT-SWAP", candles]]);
  const result = evaluateV2Lifecycle(db, history, "15m", DEFAULT_V2_COSTS, promotionCriteria);
  assert.equal(result[0]?.state, "SHADOW");
  assert.match(result[0]?.reasons.join(" ") ?? "", /awaiting matched-window evidence/);
  assert.equal(getV2Champions(db).TREND_FOLLOWING_V2.version, 2);
  assert.equal(listV2Versions(db, "TREND_FOLLOWING_V2").find((row) => row.version === version)?.status, "SHADOW");
  const saved = db.db.prepare("SELECT stage,metrics FROM strategy_v2_evaluations WHERE strategy='TREND_FOLLOWING_V2'").get() as { stage: string; metrics: string };
  assert.equal(saved.stage, "SHADOW");
  const metrics = JSON.parse(saved.metrics) as { historicalBySymbol: Record<string, unknown>; outOfSampleBySymbol: Record<string, unknown>;
    historicalEndTs: number | null; oosStartTs: number | null };
  assert.deepEqual(Object.keys(metrics.historicalBySymbol).sort(), ["BTC-USDT-SWAP", "ETH-USDT-SWAP"]);
  assert.deepEqual(Object.keys(metrics.outOfSampleBySymbol).sort(), ["BTC-USDT-SWAP", "ETH-USDT-SWAP"]);
  assert.ok(metrics.historicalEndTs !== null && metrics.oosStartTs !== null && metrics.historicalEndTs < metrics.oosStartTs,
    "primary historical validation and trailing OOS windows are explicitly disjoint");
  db.close();
});

test("insufficient historical evidence leaves a V2 Challenger awaiting rather than rejecting", () => {
  const db = store(); ensureV2Registry(db);
  const version = createV2Challenger(db, { strategy: "BREAKOUT_V2", parentVersion: 2,
    params: { ...DEFAULT_V2_PARAMS.BREAKOUT_V2, volume_ratio_min: 1.25 },
    changedParameter: "volume_ratio_min", oldValue: 1.3, newValue: 1.25,
    hypothesis: "Slightly less volume confirmation may improve net breakout expectancy.", evidence: { sample: 15 } });
  const result = evaluateV2Lifecycle(db, new Map(), "15m", DEFAULT_V2_COSTS, promotionCriteria);
  assert.equal(result[0]?.state, "AWAITING_EVIDENCE");
  assert.equal(listV2Versions(db, "BREAKOUT_V2").find((row) => row.version === version)?.status, "CHALLENGER");
  assert.equal((db.db.prepare("SELECT COUNT(*) AS count FROM strategy_v2_evaluations").get() as { count: number }).count, 1);
  db.close();
});

test("global evolution idempotency allows one run per market candle cycle", async () => {
  const db = store(); let runs = 0;
  assert.equal(await runOncePerGlobalCycle(db, "15m", 100, async () => { runs++; }), true);
  assert.equal(await runOncePerGlobalCycle(db, "15m", 100, async () => { runs++; }), false);
  assert.equal(await runOncePerGlobalCycle(db, "15m", 200, async () => { runs++; }), true);
  assert.equal(runs, 2);
  db.close();
});
