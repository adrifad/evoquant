import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { openStore } from "../src/memory/db.ts";
import { isGlobalStopReason } from "../src/execution/executor.ts";
import { getOpportunityFunnel, recordOpportunityMetric } from "../src/market/opportunity-funnel.ts";
import { scanSymbolsIsolated } from "../src/market/isolated-scan.ts";
import { attemptRankedCandidates } from "../src/strategy/candidate-queue.ts";
import type { ScanRow } from "../src/strategy/scanner.ts";
import type { TradeCandidate } from "../src/strategy/core-v2.ts";
import { DEFAULT_BREAKOUT_RETEST_V1, DEFAULT_TREND_PULLBACK_V1, evaluateBreakoutRetestV1,
  evaluateTrendPullbackV1, parseResearchStrategyConfig } from "../src/strategy/research-v1.ts";
import type { FeatureSnapshot } from "../src/market/features.ts";
import type { Candle } from "../src/exchange/okx/types.ts";

function candidate(instrument: string, setupScore: number): TradeCandidate {
  return { instrument, setupScore, engine: "SWING_15M", strategy: "TREND_FOLLOWING_V2", strategyVersion: 2,
    side: "LONG", entryPrice: 100, stopPrice: 98, takeProfitPrice: 105, stopAtr: 1, targetR: 2.5,
    regime: { trend: "BULL_TREND", volatility: "NORMAL" }, conditions: [], reasoning: [],
    maxHoldBars: 32, features: {} as TradeCandidate["features"], signalTs: 1 };
}
function rows(...values: Array<[string, number]>): ScanRow[] {
  return values.map(([instrument, score]) => ({ instrument, regime: "TRENDING_BULLISH", price: 100,
    score, strategy: "TREND_FOLLOWING_V2", tradable: true, candidate: candidate(instrument, score) } as ScanRow));
}

test("isolated symbol scan records one failure and still evaluates later symbols", async () => {
  const evaluated: string[] = [], failed: string[] = [];
  const result = await scanSymbolsIsolated(["BTC", "ETH", "SOL", "XRP"], async symbol => {
    evaluated.push(symbol);
    if (symbol === "SOL") throw new Error("symbol feed unavailable");
    return symbol;
  }, symbol => failed.push(symbol));
  assert.deepEqual(evaluated, ["BTC", "ETH", "SOL", "XRP"]);
  assert.deepEqual(result.values, ["BTC", "ETH", "XRP"]);
  assert.deepEqual(failed, ["SOL"]);
  assert.equal(result.failures.length, 1);
});

test("ranked queue continues after candidate-local Gate and risk rejection, opens once, and records rank", async () => {
  const attempted: string[] = [];
  const outcome = await attemptRankedCandidates(rows(["ETH", .86], ["BTC", .81], ["SOL", .75], ["SUI", .71]), {
    entrySymbols: new Set(["ETH", "BTC", "SOL", "SUI"]), occupiedSymbols: new Set(),
    metadataSymbols: new Set(["ETH", "BTC", "SOL", "SUI"]), maxAttempts: 3,
  }, async item => {
    attempted.push(item.instrument);
    if (item.instrument === "ETH") return { disposition: "GATE_DENY" };
    if (item.instrument === "BTC") return { disposition: "CANDIDATE_REJECT", reason: "SIZING_REJECTED" };
    return { disposition: "OPENED" };
  });
  assert.deepEqual(attempted, ["ETH", "BTC", "SOL"]);
  assert.deepEqual(outcome.attempted.map(item => item.rank), [1, 2, 3]);
  assert.equal(outcome.opened?.instrument, "SOL");
  assert.equal(outcome.attempted.length, 3, "at most one position is opened and attempt limit is respected");
});

test("Swing top Gate denial falls through to the second candidate and stops after its entry", async () => {
  const attempted: string[] = [];
  const outcome = await attemptRankedCandidates(rows(["ETH", .86], ["BTC", .81], ["SOL", .75]), {
    entrySymbols: new Set(["ETH", "BTC", "SOL"]), occupiedSymbols: new Set(),
    metadataSymbols: new Set(["ETH", "BTC", "SOL"]), maxAttempts: 3,
  }, async item => {
    attempted.push(item.instrument);
    return item.instrument === "ETH" ? { disposition: "GATE_DENY" } : { disposition: "OPENED" };
  });
  assert.deepEqual(attempted, ["ETH", "BTC"]);
  assert.equal(outcome.opened?.instrument, "BTC");
});

test("LLM budget exhaustion is a global queue stop", async () => {
  const attempted: string[] = [];
  const result = await attemptRankedCandidates(rows(["ETH", .86], ["BTC", .81]), {
    entrySymbols: new Set(["ETH", "BTC"]), occupiedSymbols: new Set(),
    metadataSymbols: new Set(["ETH", "BTC"]), maxAttempts: 3,
  }, async item => {
    attempted.push(item.instrument);
    return { disposition: "GLOBAL_STOP", reason: "LLM_BUDGET_EXHAUSTED" };
  });
  assert.deepEqual(attempted, ["ETH"]);
  assert.equal(result.stoppedByGlobalCondition, true);
});

test("global Swing queue stop classification covers deterministic daily/drawdown halts", () => {
  for (const reason of ["KILL_SWITCH_ACTIVE:MANUAL", "BOT_PAUSED", "MAX_CONCURRENT_POSITIONS", "MAX_DAILY_LOSS_REACHED",
    "MAX_DRAWDOWN_REACHED", "MAX_ACCOUNT_DRAWDOWN_REACHED", "PORTFOLIO_OPEN_RISK_LIMIT", "STATE_UNCERTAIN"])
    assert.equal(isGlobalStopReason(reason), true, reason);
  for (const reason of ["GATE_DENIED", "CONFIDENCE_BELOW_MIN", "INVALID_STOP_DISTANCE", "SIZING_REJECTED", "INSTRUMENT_ALREADY_OCCUPIED"])
    assert.equal(isGlobalStopReason(reason), false, reason);
});

test("ranked queue stops on global halt and excludes occupied, non-entry and metadata-invalid symbols", async () => {
  const attempted: string[] = [];
  const outcome = await attemptRankedCandidates(rows(["OCCUPIED", .99], ["NOT_ENTRY", .95], ["NO_META", .92], ["ETH", .86], ["BTC", .81]), {
    entrySymbols: new Set(["OCCUPIED", "ETH", "BTC"]), occupiedSymbols: new Set(["OCCUPIED"]),
    metadataSymbols: new Set(["OCCUPIED", "ETH", "BTC"]), maxAttempts: 3,
  }, async item => {
    attempted.push(item.instrument);
    return { disposition: "GLOBAL_STOP", reason: "MAX_DAILY_LOSS_REACHED" };
  });
  assert.deepEqual(attempted, ["ETH"]);
  assert.equal(outcome.stoppedByGlobalCondition, true);
  assert.equal(outcome.attempted.length, 1);
});

test("candidate queue deduplicates same-symbol setup alternatives and obeys configured maximum", async () => {
  const repeated = rows(["ETH", .9], ["BTC", .8], ["SOL", .7], ["XRP", .6]);
  repeated.push({ ...repeated[0]!, candidate: candidate("ETH", .85) });
  const attempted: string[] = [];
  const result = await attemptRankedCandidates(repeated, {
    entrySymbols: new Set(["ETH", "BTC", "SOL", "XRP"]), occupiedSymbols: new Set(),
    metadataSymbols: new Set(["ETH", "BTC", "SOL", "XRP"]), maxAttempts: 2,
  }, async item => { attempted.push(item.instrument); return { disposition: "CANDIDATE_REJECT" }; });
  assert.deepEqual(attempted, ["ETH", "BTC"]);
  assert.equal(result.attempted.length, 2);
});

test("hourly opportunity funnel aggregates by engine and blocker without event rows", t => {
  const root = mkdtempSync(path.join(os.tmpdir(), "evoq-funnel-"));
  const store = openStore(root);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const now = new Date("2026-10-10T10:30:00.000Z");
  recordOpportunityMetric(store, "SWING_15M", "SYMBOLS_EVALUATED", "", now);
  recordOpportunityMetric(store, "SWING_15M", "HARD_CONDITION_FAILED", "TREND_FOLLOWING_V2:adx_min", now);
  recordOpportunityMetric(store, "SWING_15M", "HARD_CONDITION_FAILED", "TREND_FOLLOWING_V2:adx_min", now);
  recordOpportunityMetric(store, "SCALP_5M", "MARKET_DATA_FAILED", "", now);
  const projected = getOpportunityFunnel(store, 24, now);
  assert.equal(projected.engines.SWING_15M.totals.SYMBOLS_EVALUATED, 1);
  assert.equal(projected.engines.SWING_15M.blockers[0]?.count, 2);
  assert.equal(projected.engines.SCALP_5M.totals.MARKET_DATA_FAILED, 1);
  assert.equal((store.db.prepare("SELECT COUNT(*) count FROM system_events").get() as { count: number }).count, 0);
});

const features = (patch: Partial<FeatureSnapshot> = {}): FeatureSnapshot => ({
  ts: 1_800_000, instrument: "TEST-USDT-SWAP", price: 100.3, ema20: 100, ema50: 99.7,
  emaSpreadPct: 0.3, ema20SlopePct: 0.1, rsi14: 53, adx14: 30, atr14: 1, atrPct: 0.5,
  volume: 120, volumeSma20: 100, volumeRatio: 1.2, sufficientData: true, ...patch,
});
const candle = (ts: number, o: number, h: number, l: number, c: number, vol = 120): Candle =>
  ({ ts, o, h, l, c, vol, volCcy: vol, confirm: "1" });

test("Trend Pullback research evaluator is direction-symmetric and keeps ATR risk geometry valid", () => {
  const trendWarmup = Array.from({ length: 20 }, (_, i) => candle(i, 100, 100.1, 99.9, 100, 100));
  const long = evaluateTrendPullbackV1(features(), [...trendWarmup, candle(21, 100, 100.2, 99.5, 99.6), candle(22, 100.1, 100.4, 100, 100.3)]);
  assert.equal(long.candidate?.side, "LONG");
  assert.equal(long.candidate?.stopAtr, 1.3);
  assert.equal(long.candidate?.targetR, 2);
  assert.equal(long.candidate?.stopPrice, 99.0);
  assert.ok(Math.abs((long.candidate?.takeProfitPrice ?? 0) - 102.9) < 1e-9);
  const short = evaluateTrendPullbackV1(features({ price: 99.7, ema20: 100, ema50: 100.3, emaSpreadPct: -0.3,
    ema20SlopePct: -0.1, rsi14: 47 }), [...trendWarmup, candle(21, 100.1, 100.5, 100.2, 100.4), candle(22, 99.9, 100, 99.6, 99.7)]);
  assert.equal(short.candidate?.side, "SHORT");
  assert.equal(short.candidate?.stopPrice, 101.0);
});

test("research setup score cannot rescue failed hard conditions and parameter objects reject unknown fields", () => {
  const trendWarmup = Array.from({ length: 20 }, (_, i) => candle(i, 100, 100.1, 99.9, 100, 100));
  const rejected = evaluateTrendPullbackV1(features({ volumeRatio: 0.2 }), [...trendWarmup, candle(21, 100, 100.2, 99.5, 99.6), candle(22, 100.1, 100.4, 100, 100.3)]);
  assert.equal(rejected.candidate, null);
  assert.ok(rejected.setupScore > 0, "score is informational and does not override deterministic hard failures");
  const config = { trend_pullback_v1: DEFAULT_TREND_PULLBACK_V1, breakout_retest_v1: DEFAULT_BREAKOUT_RETEST_V1 };
  assert.deepEqual(parseResearchStrategyConfig(config), config);
  assert.throws(() => parseResearchStrategyConfig({ ...config, new_knob: 1 }));
  assert.throws(() => parseResearchStrategyConfig({ ...config, trend_pullback_v1: { ...DEFAULT_TREND_PULLBACK_V1, stop_atr: 0.1 } }));
});

test("Breakout Retest research evaluator recognizes bullish and bearish confirmed retests", () => {
  const base: Candle[] = [];
  for (let i = 0; i < 20; i++) base.push(candle(i, 99.4, 100, 99, 99.5, 100));
  const longCandles = [...base, candle(20, 99.6, 100.5, 99.5, 100.3, 160), candle(21, 100.2, 100.3, 99.95, 100.05),
    candle(22, 100.05, 100.2, 99.98, 100.1), candle(23, 100.1, 100.25, 100.02, 100.2), candle(24, 100.2, 100.6, 100.15, 100.5)];
  const long = evaluateBreakoutRetestV1(features({ price: 100.5, volumeRatio: 1.2 }), longCandles);
  assert.equal(long.candidate?.side, "LONG");
  const downBase: Candle[] = [];
  for (let i = 0; i < 20; i++) downBase.push(candle(i, 100.6, 101, 100, 100.5, 100));
  const shortCandles = [...downBase, candle(20, 100.4, 100.5, 99.5, 99.7, 160), candle(21, 99.8, 100.05, 99.7, 99.95),
    candle(22, 99.95, 100.02, 99.8, 99.9), candle(23, 99.9, 99.98, 99.75, 99.8), candle(24, 99.8, 99.85, 99.4, 99.5)];
  const short = evaluateBreakoutRetestV1(features({ price: 99.5, ema20: 100, ema50: 100.3, emaSpreadPct: -0.3,
    ema20SlopePct: -0.1, rsi14: 45, volumeRatio: 1.2 }), shortCandles);
  assert.equal(short.candidate?.side, "SHORT");
  assert.equal(short.candidate?.targetR, 2.1);
});
