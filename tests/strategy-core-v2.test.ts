import test from "node:test";
import assert from "node:assert/strict";
import type { Candle } from "../src/exchange/okx/types.ts";
import type { FeatureSnapshot } from "../src/market/features.ts";
import { classifyRegimeAxes } from "../src/market/regime.ts";
import {
  evaluateBreakoutSetup, evaluateMeanReversionSetup, evaluateTrendFollowingSetup,
  type StrategyV2Params,
} from "../src/strategy/core-v2.ts";
import { backtestV2, DEFAULT_V2_COSTS, walkForwardV2 } from "../src/evaluation/backtest.ts";
import { evaluateV2Portfolio } from "../src/evaluation/champion-challenger.ts";

function features(overrides: Partial<FeatureSnapshot> = {}): FeatureSnapshot {
  return {
    ts: 100, instrument: "BTC-USDT-SWAP", price: 101, ema20: 100, ema50: 99,
    emaSpreadPct: 1, ema20SlopePct: 0.2, distanceFromEma20Pct: 1,
    rsi14: 60, adx14: 30, atr14: 1, atrPct: 1, volume: 130, volumeSma20: 100,
    volumeRatio: 1.3, sufficientData: true, ...overrides,
  };
}
function candle(o: number, h: number, l: number, c: number, ts: number): Candle {
  return { ts, o, h, l, c, vol: 130, volCcy: 130, confirm: "1" };
}
const breakoutCandles = (): Candle[] => [
  ...Array.from({ length: 20 }, (_, i) => candle(98, 100, 97.5, 99, i)),
  candle(100, 100.8, 99.8, 100.5, 21),
];
const strictTrendParams: StrategyV2Params["TREND_FOLLOWING_V2"] = {
  adx_min: 25, volume_ratio_min: 1.1, rsi_min: 52, rsi_max: 68,
  max_extension_atr: 1.2, stop_atr: 1.5, target_r: 2.5, max_hold_bars: 32,
};

test("Trend Following V2 emits symmetric directional candidates only after mandatory conditions", () => {
  const long = evaluateTrendFollowingSetup(features(), strictTrendParams);
  assert.equal(long.tradable, true);
  assert.equal(long.candidate?.side, "LONG");
  const short = evaluateTrendFollowingSetup(features({ price: 99, ema20: 100, ema50: 101, emaSpreadPct: -1, ema20SlopePct: -0.2, rsi14: 40 }), strictTrendParams);
  assert.equal(short.tradable, true);
  assert.equal(short.candidate?.side, "SHORT");
  assert.equal(evaluateTrendFollowingSetup(features({ volumeRatio: 0.8 }), strictTrendParams).tradable, false);
  assert.equal(evaluateTrendFollowingSetup(features({ adx14: 18 }), strictTrendParams).tradable, false);
  assert.equal(evaluateTrendFollowingSetup(features({ price: 103, ema20: 100 }), strictTrendParams).tradable, false);
});

test("regime axes preserve direction when volatility is high", () => {
  assert.deepEqual(classifyRegimeAxes(features({ atrPct: 2.2, emaSpreadPct: 0.8, adx14: 35 })),
    { trend: "BULL_TREND", volatility: "HIGH" });
  assert.deepEqual(classifyRegimeAxes(features({ atrPct: 2.2, emaSpreadPct: -0.8, adx14: 35 })),
    { trend: "BEAR_TREND", volatility: "HIGH" });
});

test("Breakout V2 needs a genuine range break, supporting volume and anti-chase passes", () => {
  const cs = breakoutCandles();
  const f = features({ ts: 21, price: 100.5, ema20: 99.5, ema50: 98.5, emaSpreadPct: 1, ema20SlopePct: 0.2 });
  assert.equal(evaluateBreakoutSetup(f, cs).candidate?.side, "LONG");
  assert.equal(evaluateBreakoutSetup(features({ price: 99.5 }), cs.slice(0, -1)).tradable, false);
  const vertical = cs.slice(); vertical[20] = candle(100, 104, 99.8, 103.5, 21);
  const chased = evaluateBreakoutSetup(features({ price: 103.5, ema20: 100 }), vertical);
  assert.equal(chased.tradable, false);
  assert.ok(chased.conditions.some((c) => c.name.startsWith("anti_chase") && !c.passed));
  const shortCandles = [...Array.from({ length: 20 }, (_, i) => candle(102, 103, 100, 101, i)), candle(100, 100.2, 99, 99.5, 21)];
  assert.equal(evaluateBreakoutSetup(features({ price: 99.5, ema20: 100.5, ema50: 101.5, emaSpreadPct: -1, ema20SlopePct: -0.2 }), shortCandles).candidate?.side, "SHORT");
});

test("Mean Reversion V2 requires sideways context and structural reversion confirmation", () => {
  const p = { adx_max: 20, deviation_atr: 1.25, rsi_low: 30, rsi_high: 70, stop_atr: 1.4, target_r: 1.5, max_hold_bars: 16 };
  const cs = [candle(97.8, 98, 97, 97.4, 1), candle(97.5, 98.2, 97.4, 98.1, 2)];
  const f = features({ price: 98.1, ema20: 100, ema50: 100.05, emaSpreadPct: -0.05, adx14: 15, rsi14: 25, ema20SlopePct: -0.01 });
  assert.equal(evaluateMeanReversionSetup(f, cs, p).candidate?.side, "LONG");
  assert.equal(evaluateMeanReversionSetup(f, [cs[0]!], p).tradable, false);
  assert.equal(evaluateMeanReversionSetup(features({ ...f, adx14: 35 }), cs, p).tradable, false);
});

test("V2 backtest is deterministic, net of costs, and reports walk-forward stability", () => {
  const candles: Candle[] = [];
  let price = 100;
  for (let i = 0; i < 1000; i++) {
    const drift = i % 120 < 70 ? 0.12 : -0.08;
    const open = price;
    price += drift + Math.sin(i / 4) * 0.05;
    candles.push(candle(open, Math.max(open, price) + 0.15, Math.min(open, price) - 0.15, price, i + 1));
  }
  const a = backtestV2("TREND_FOLLOWING_V2", candles, "15m");
  const b = backtestV2("TREND_FOLLOWING_V2", candles, "15m");
  assert.deepEqual(a.trades, b.trades);
  assert.ok(a.trades.every((t) => t.netR <= t.grossR));
  assert.equal(a.assumptions.intrabar.includes("stop fills first"), true);
  assert.equal(backtestV2("TREND_FOLLOWING_V2", candles, "15m", undefined, {
    ...DEFAULT_V2_COSTS, entryFeePct: 0, exitFeePct: 0, spreadBps: 0, slippageBps: 0,
  }).netExpectancyR, a.grossExpectancyR);
  const wf = walkForwardV2("TREND_FOLLOWING_V2", candles, "15m");
  assert.equal(wf.foldExpectancies.length, 4);
  assert.ok(Number.isFinite(wf.dispersion));
  const portfolio = evaluateV2Portfolio("TREND_FOLLOWING_V2", new Map([["BTC-USDT-SWAP", candles], ["ETH-USDT-SWAP", candles]]), "15m");
  assert.deepEqual(Object.keys(portfolio.perSymbol).sort(), ["BTC-USDT-SWAP", "ETH-USDT-SWAP"]);
  assert.equal(portfolio.aggregate.trades, portfolio.perSymbol["BTC-USDT-SWAP"]!.summary.trades * 2);
});
