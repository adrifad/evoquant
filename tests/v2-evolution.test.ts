import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { openStore } from "../src/memory/db.ts";
import { DEFAULT_V2_PARAMS, type StrategyV2Id } from "../src/strategy/core-v2.ts";
import { createV2Challenger, ensureV2Registry, getV2Champions, listV2Versions, transitionV2Version } from "../src/strategy/v2-registry.ts";
import { validateV2Proposal } from "../src/agents/v2-evolution.ts";
import { calculateExecutionCostR, DEFAULT_V2_COSTS } from "../src/evaluation/backtest.ts";
import { evaluateV2Lifecycle } from "../src/evaluation/v2-promotion.ts";
import { processShadowCycle } from "../src/evaluation/shadow-challenger.ts";
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
  championForwardMinTrades: 15, outOfSampleFraction: 0.3, minimumSymbols: 2,
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
  const snapshots = [{ instrument: "BTC-USDT-SWAP", features: feature(100) }];
  const history = new Map([["BTC-USDT-SWAP", [candle(100, 101, 101.2, 100.8, 101)]]]);
  assert.equal(processShadowCycle(db, snapshots, history, "15m", DEFAULT_V2_COSTS), 1);
  const shadowId = `SHD-TREND_FOLLOWING_V2-${version}-BTC-USDT-SWAP-100`;
  assert.equal((db.db.prepare("SELECT status FROM shadow_trades WHERE shadow_trade_id=?").get(shadowId) as { status: string }).status, "PENDING");

  const entryHistory = new Map([["BTC-USDT-SWAP", [candle(100, 101, 101.2, 100.8, 101), candle(101, 101, 102, 100, 101.5)]]]);
  processShadowCycle(db, [{ instrument: "BTC-USDT-SWAP", features: feature(101, 101.5) }], entryHistory, "15m", DEFAULT_V2_COSTS);
  assert.equal((db.db.prepare("SELECT COUNT(*) AS count FROM shadow_trades WHERE strategy_version=? AND instrument='BTC-USDT-SWAP'").get(version) as { count: number }).count, 1,
    "one shadow position per Challenger/instrument prevents overlapping forward samples");
  const open = db.db.prepare("SELECT status,entry_ts,entry_price,stop_price,take_profit_price,costs_json FROM shadow_trades WHERE shadow_trade_id=?").get(shadowId) as {
    status: string; entry_ts: number; entry_price: number; stop_price: number; take_profit_price: number; costs_json: string;
  };
  assert.equal(open.status, "OPEN"); assert.equal(open.entry_ts, 101); assert.equal(open.entry_price, 101);
  assert.equal(open.stop_price, 99.5); assert.equal(open.take_profit_price, 104.75);
  assert.deepEqual(JSON.parse(open.costs_json), DEFAULT_V2_COSTS);

  const exitHistory = new Map([["BTC-USDT-SWAP", [...entryHistory.get("BTC-USDT-SWAP")!, candle(102, 102, 105, 101.8, 104.5)]]]);
  processShadowCycle(db, [{ instrument: "BTC-USDT-SWAP", features: feature(102, 104.5) }], exitHistory, "15m", DEFAULT_V2_COSTS);
  const closed = db.db.prepare("SELECT status,exit_reason,gross_r,net_r,fees_r,mfe_r,mae_r FROM shadow_trades WHERE shadow_trade_id=?").get(shadowId) as {
    status: string; exit_reason: string; gross_r: number; net_r: number; fees_r: number; mfe_r: number; mae_r: number;
  };
  assert.equal(closed.status, "CLOSED"); assert.equal(closed.exit_reason, "TP");
  assert.ok(closed.gross_r > closed.net_r); assert.ok(closed.fees_r > 0); assert.ok(closed.mfe_r > 0);
  assert.equal((db.db.prepare("SELECT COUNT(*) n FROM trades").get() as { n: number }).n, 0);
  assert.equal((db.db.prepare("SELECT COUNT(*) n FROM orders").get() as { n: number }).n, 0);
  db.close();
});

test("max-hold bars time-stop shadow trades on the next modeled candle open", () => {
  const db = store(); ensureV2Registry(db);
  const params = { ...DEFAULT_V2_PARAMS.TREND_FOLLOWING_V2, max_hold_bars: 1 };
  const version = createV2Challenger(db, { strategy: "TREND_FOLLOWING_V2", parentVersion: 2,
    params, changedParameter: "max_hold_bars", oldValue: 32, newValue: 1,
    hypothesis: "A one-bar max holding horizon exits at the next modeled open.", evidence: { sample: 50 } });
  transitionV2Version(db, "TREND_FOLLOWING_V2", version, "SHADOW", "test historical pass");
  const first = [candle(200, 101, 101.2, 100.8, 101)];
  processShadowCycle(db, [{ instrument: "BTC-USDT-SWAP", features: feature(200) }], new Map([["BTC-USDT-SWAP", first]]), "15m", DEFAULT_V2_COSTS);
  const second = [...first, candle(201, 101, 102, 100, 101.5)];
  processShadowCycle(db, [{ instrument: "BTC-USDT-SWAP", features: feature(201, 101.5) }], new Map([["BTC-USDT-SWAP", second]]), "15m", DEFAULT_V2_COSTS);
  const third = [...second, candle(202, 101.2, 101.4, 100.9, 101.1)];
  processShadowCycle(db, [{ instrument: "BTC-USDT-SWAP", features: feature(202, 101.1) }], new Map([["BTC-USDT-SWAP", third]]), "15m", DEFAULT_V2_COSTS);
  const closed = db.db.prepare("SELECT exit_reason,exit_price FROM shadow_trades WHERE strategy_version=? AND status='CLOSED'").get(version) as { exit_reason: string; exit_price: number };
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
  assert.match(result[0]?.reasons.join(" ") ?? "", /awaiting shadow\/Champion forward evidence/);
  assert.equal(getV2Champions(db).TREND_FOLLOWING_V2.version, 2);
  assert.equal(listV2Versions(db, "TREND_FOLLOWING_V2").find((row) => row.version === version)?.status, "SHADOW");
  const saved = db.db.prepare("SELECT stage,metrics FROM strategy_v2_evaluations WHERE strategy='TREND_FOLLOWING_V2'").get() as { stage: string; metrics: string };
  assert.equal(saved.stage, "SHADOW");
  const metrics = JSON.parse(saved.metrics) as { historicalBySymbol: Record<string, unknown>; outOfSampleBySymbol: Record<string, unknown> };
  assert.deepEqual(Object.keys(metrics.historicalBySymbol).sort(), ["BTC-USDT-SWAP", "ETH-USDT-SWAP"]);
  assert.deepEqual(Object.keys(metrics.outOfSampleBySymbol).sort(), ["BTC-USDT-SWAP", "ETH-USDT-SWAP"]);
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
