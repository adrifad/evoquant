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
  assert.equal(full.algorithmVersion, "structure-v1");
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
  assert.equal(invalidated.state, "TRANSITION");
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
  const result = buildMarketIntelligence("BTC-USDT-SWAP", "15m", bars);
  assert.equal(result.status, "AVAILABLE");
  assert.equal(result.candleCount, 80);
  assert.equal(result.evaluatedAt, 79);
  if (result.status === "AVAILABLE") assert.notEqual(result.features.price, 110);
});
