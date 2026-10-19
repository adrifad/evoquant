import assert from "node:assert/strict";
import { test } from "node:test";
import type { Candle } from "../src/exchange/okx/types.ts";
import { detectMarketStructure } from "../src/market/market-structure.ts";
import { detectSupportResistance } from "../src/market/support-resistance.ts";
import { assessStructuralRange } from "../src/market/range-detector.ts";
import { describePriceAction } from "../src/market/price-action.ts";
import { buildMarketIntelligence } from "../src/market/intelligence.ts";

function candle(ts: number, o: number, h: number, l: number, c: number, confirm: "0" | "1" = "1"): Candle {
  return { ts, o, h, l, c, vol: 10, volCcy: 10, confirm };
}

test("market structure confirms pivots only after right-side bars and ignores unconfirmed candles", () => {
  const bars = [candle(0, 3, 4, 2, 3), candle(1, 3, 5, 2, 4), candle(2, 4, 8, 3, 6),
    candle(3, 5, 6, 2, 4), candle(4, 4, 5, 1, 3), candle(5, 3, 4, 2, 3, "0")];
  const snapshot = detectMarketStructure("BTC-USDT-SWAP", "5m", bars, { leftBars: 1, rightBars: 1 });
  const pivot = snapshot.pivots.find((event) => event.kind === "SWING_HIGH");
  assert.equal(pivot?.ts, 2);
  assert.equal(pivot?.confirmedAt, 3);
  assert.deepEqual(pivot?.sourceCandleIds, [1, 2, 3]);
  assert.ok(snapshot.pivots.every((event) => event.confirmedAt <= 4));
});

test("market structure identifies higher highs/lows and produces stable confirmed history", () => {
  const bars = [
    candle(0, 5, 6, 4, 5), candle(1, 5, 8, 4, 7), candle(2, 6, 7, 3, 5),
    candle(3, 5, 6, 4, 5), candle(4, 6, 9, 5, 8), candle(5, 7, 8, 4, 6),
    candle(6, 6, 7, 5, 6), candle(7, 7, 10, 6, 9), candle(8, 8, 9, 5, 7),
  ];
  const options = { leftBars: 1, rightBars: 1 };
  const partial = detectMarketStructure("ETH-USDT-SWAP", "15m", bars.slice(0, 8), options);
  const full = detectMarketStructure("ETH-USDT-SWAP", "15m", bars, options);
  assert.ok(full.events.some((event) => event.kind === "HH"));
  assert.ok(full.events.some((event) => event.kind === "HL"));
  assert.deepEqual(full.pivots.filter((event) => event.confirmedAt < 8), partial.pivots.filter((event) => event.confirmedAt < 8));
  assert.equal(full.algorithmVersion, "structure-v2");
});

test("historical market-structure breaks retain chronological bias as future candles are appended", () => {
  const bars = [
    candle(0, 5, 6, 4, 5), candle(1, 5, 8, 4, 7), candle(2, 6, 7, 3, 5),
    candle(3, 5, 6, 4, 5), candle(4, 6, 9, 5, 8), candle(5, 7, 8, 4, 6),
    candle(6, 6, 7, 5, 6), candle(7, 7, 10, 6, 9), candle(8, 8, 9, 5, 7),
    candle(9, 7, 8, 3, 4), candle(10, 4, 6, 2, 3), candle(11, 3, 5, 1, 2),
    candle(12, 2, 7, 2, 6), candle(13, 6, 8, 5, 7), candle(14, 7, 9, 6, 8),
  ];
  const options = { leftBars: 1, rightBars: 1 };
  const prefix = detectMarketStructure("ETH-USDT-SWAP", "15m", bars.slice(0, 10), options);
  const extended = detectMarketStructure("ETH-USDT-SWAP", "15m", bars, options);
  const prefixBreaks = prefix.events.filter((item) => item.kind === "BREAK_OF_STRUCTURE" || item.kind === "CHANGE_OF_CHARACTER");
  const extendedBreaks = extended.events.filter((item) => (item.kind === "BREAK_OF_STRUCTURE" || item.kind === "CHANGE_OF_CHARACTER")
    && item.confirmedAt <= 9);
  assert.deepEqual(extendedBreaks, prefixBreaks);
  assert.ok(prefixBreaks.every((item) => item.breakConfirmedAt === item.confirmedAt
    && item.sourcePivotConfirmedAt < item.breakConfirmedAt && item.biasBeforeBreak && item.biasAfterBreak && item.brokenLevel === item.price));
});

test("structure candles are timestamp-ordered, duplicate-safe, and conflicting duplicate timestamps are excluded", () => {
  const bars = [candle(2, 4, 8, 3, 6), candle(0, 3, 4, 2, 3), candle(1, 3, 5, 2, 4),
    candle(1, 3, 5.5, 2, 4), candle(3, 5, 6, 2, 4), candle(4, 4, 5, 1, 3)];
  const result = detectMarketStructure("BTC-USDT-SWAP", "5m", bars, { leftBars: 1, rightBars: 1 });
  assert.deepEqual(result.pivots.map((point) => point.ts), [2]);
  const exactDuplicates = detectMarketStructure("BTC-USDT-SWAP", "5m", [...bars.filter((bar) => bar.ts !== 1), bars[2]!], { leftBars: 1, rightBars: 1 });
  assert.deepEqual(exactDuplicates.pivots.map((point) => point.ts), [2]);
});

test("BOS and CHOCH are classified using the bias known at each confirmed break", () => {
  const bars = [candle(0, 5, 6, 4, 5), candle(1, 7, 10, 6, 8), candle(2, 6, 8, 4, 5),
    candle(3, 7, 9, 6, 8), candle(4, 6, 8, 5, 6), candle(5, 9, 11, 7, 10),
    candle(6, 7, 9, 6, 7), candle(7, 10, 12, 8, 11), candle(8, 9, 10, 7, 9),
    candle(9, 12, 14, 9, 13), candle(10, 6, 13, 4, 5)];
  const result = detectMarketStructure("BTC-USDT-SWAP", "5m", bars, { leftBars: 1, rightBars: 1 });
  const bos = result.events.find((item) => item.kind === "BREAK_OF_STRUCTURE" && item.confirmedAt === 9);
  const choch = result.events.find((item) => item.kind === "CHANGE_OF_CHARACTER");
  assert.equal(bos?.direction, "BULLISH");
  assert.equal(bos?.biasBeforeBreak, "BULLISH");
  assert.equal(bos?.biasAfterBreak, "BULLISH");
  assert.equal(bos?.breakConfirmedAt, 9);
  assert.equal(choch?.direction, "BEARISH");
  assert.equal(choch?.biasBeforeBreak, "BULLISH");
  assert.equal(choch?.biasAfterBreak, "BEARISH");
  assert.equal(choch?.breakConfirmedAt, 10);
});

test("support/resistance counts distinct pivot reactions rather than repeated overlapping bars", () => {
  const bars = [
    candle(0, 100, 101, 99, 100), candle(1, 100, 105, 100, 104), candle(2, 104, 104.5, 99.5, 101),
    candle(3, 101, 103, 100, 102), candle(4, 102, 105.1, 101, 104), candle(5, 104, 104, 99.7, 101),
    candle(6, 101, 102, 100, 101), candle(7, 101, 105.2, 100.5, 104), candle(8, 104, 104, 100, 102),
  ];
  const zones = detectSupportResistance("BTC-USDT-SWAP", "5m", bars, 1, { leftBars: 1, rightBars: 1, toleranceAtr: 0.25, minTouchSeparationBars: 2 });
  assert.ok(zones.resistance.some((zone) => zone.touches === 3 && zone.confirmed));
  assert.ok(zones.nearestResistance);
  assert.ok(zones.nearestResistance.low <= zones.nearestResistance.high);
});

test("structural range requires duration, two distinct boundaries, sufficient width, and no confirmed breakout", () => {
  const bars: Candle[] = [];
  const highs = [105, 103, 102, 101, 100, 103, 104, 102, 101, 100, 103, 104, 102, 101, 100, 103, 104, 102, 101, 100];
  highs.forEach((h, i) => bars.push(candle(i, h - 2, h, h - 4, h - 2)));
  const range = assessStructuralRange("BTC-USDT-SWAP", "15m", bars, 2, { lookbackBars: 20, minDurationBars: 12,
    minBoundaryTouches: 2, toleranceAtr: 0.5, minWidthAtr: 2, maxWidthAtr: 6, pivotLeftBars: 1, pivotRightBars: 1 });
  assert.equal(range.state, "RANGE_CONFIRMED");
  assert.ok((range.positionInRange ?? -1) >= 0 && (range.positionInRange ?? 2) <= 1);
  const breakout = [...bars.slice(0, -1), candle(20, 108, 110, 107, 109)];
  const invalidated = assessStructuralRange("BTC-USDT-SWAP", "15m", breakout, 2, { lookbackBars: 20, minDurationBars: 12,
    minBoundaryTouches: 2, toleranceAtr: 0.5, minWidthAtr: 2, maxWidthAtr: 6, pivotLeftBars: 1, pivotRightBars: 1 });
  assert.equal(invalidated.state, "TRANSITION", JSON.stringify(invalidated));
  const downside = [...bars.slice(0, -1), candle(20, 93, 94, 89, 90)];
  assert.equal(assessStructuralRange("BTC-USDT-SWAP", "15m", downside, 2, { lookbackBars: 20,
    minDurationBars: 12, minBoundaryTouches: 2, toleranceAtr: 0.5, minWidthAtr: 2, maxWidthAtr: 6,
    pivotLeftBars: 1, pivotRightBars: 1 }).state, "TRANSITION");
  const failedBreakout = [...bars.slice(0, -1), candle(20, 108, 110, 107, 109), candle(21, 105, 106, 103, 105)];
  const returned = assessStructuralRange("BTC-USDT-SWAP", "15m", failedBreakout, 2, { lookbackBars: 20,
    minDurationBars: 12, minBoundaryTouches: 2, toleranceAtr: 0.5, minWidthAtr: 2, maxWidthAtr: 6,
    pivotLeftBars: 1, pivotRightBars: 1 });
  assert.notEqual(returned.state, "TRANSITION", "a close back inside the same active pair is no longer a live boundary break");
});

test("structural range ignores an older unrelated resistance when selecting the current active pair", () => {
  const closes = [90, 85, 90, 85, 90, 85, 90, 85, 90, 85,
    105, 110, 105, 100, 105, 110, 105, 100, 105, 110, 105, 100, 105, 110, 105, 100, 105, 110, 105, 100, 105, 110, 105, 100, 105, 105];
  const bars = closes.map((close, index) => candle(index, close, close + 0.1, close - 0.1, close));
  const result = assessStructuralRange("BTC-USDT-SWAP", "15m", bars, 1, { lookbackBars: 40,
    minDurationBars: 8, minBoundaryTouches: 2, toleranceAtr: 0.4, minWidthAtr: 3, maxWidthAtr: 15,
    pivotLeftBars: 1, pivotRightBars: 1 });
  assert.notEqual(result.breakoutDirection, "UP");
  assert.notEqual(result.state, "TRANSITION");
  assert.ok((result.support?.center ?? 0) >= 99);
  assert.ok((result.resistance?.center ?? Infinity) <= 111);
});

test("price action describes confirmed candle rejection and does not declare an entry", () => {
  const previous = candle(0, 100, 102, 99, 101);
  const current = candle(1, 99, 101, 95, 100.5);
  const result = describePriceAction(current, previous, { priorHigh: 102, priorLow: 98 });
  assert.equal(result.rejection, "BULLISH");
  assert.equal(result.breakout, "NONE");
  assert.equal(result.entrySignal, false);
});

test("market intelligence is timestamp-bounded and excludes the latest unconfirmed candle", () => {
  const bars = Array.from({ length: 80 }, (_, i) => {
    const center = 100 + Math.sin(i * Math.PI / 4) * 3;
    return candle(i, center - 0.2, center + 0.5, center - 0.5, center);
  });
  bars.push(candle(80, 109, 111, 108, 110, "0"));
  const result = buildMarketIntelligence("BTC-USDT-SWAP", "15m", bars, 79 + 15 * 60_000 + 60_000);
  assert.equal(result.status, "AVAILABLE");
  assert.equal(result.candleCount, 80);
  assert.equal(result.evaluatedAt, 79);
  if (result.status === "AVAILABLE") assert.notEqual(result.features.price, 110);
  assert.equal(result.freshness.status, "CURRENT");
  assert.equal(result.freshness.lastConfirmedCandleAt, 79);
  assert.equal(result.freshness.dataSource, "PERSISTED_CONFIRMED_CANDLES");
});

test("market intelligence freshness distinguishes stale, insufficient, and unavailable history", () => {
  const fresh = Array.from({ length: 60 }, (_, i) => candle(i * 300_000, 100, 101, 99, 100));
  assert.equal(buildMarketIntelligence("BTC-USDT-SWAP", "5m", fresh, 60 * 300_000).freshness.status, "CURRENT");
  assert.equal(buildMarketIntelligence("BTC-USDT-SWAP", "5m", fresh, 59 * 300_000 + 390_000).freshness.status, "CURRENT",
    "freshness allows one candle interval plus the documented 90s publication grace from candle open");
  assert.equal(buildMarketIntelligence("BTC-USDT-SWAP", "5m", fresh, 59 * 300_000 + 390_001).freshness.status, "STALE");
  assert.equal(buildMarketIntelligence("BTC-USDT-SWAP", "5m", fresh, 70 * 300_000).freshness.status, "STALE");
  const insufficient = buildMarketIntelligence("BTC-USDT-SWAP", "5m", fresh.slice(0, 4), 4 * 300_000).freshness;
  assert.equal(insufficient.status, "INSUFFICIENT_DATA");
  assert.equal(insufficient.dataSufficient, false);
  const staleInsufficient = buildMarketIntelligence("BTC-USDT-SWAP", "5m", fresh.slice(0, 4), 10 * 300_000).freshness;
  assert.equal(staleInsufficient.status, "STALE", "staleness must not be hidden by a short history");
  assert.equal(staleInsufficient.dataSufficient, false);
  assert.equal(buildMarketIntelligence("BTC-USDT-SWAP", "5m", [], 0).freshness.status, "UNAVAILABLE");
});
