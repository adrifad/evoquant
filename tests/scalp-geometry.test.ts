import assert from "node:assert/strict";
import { test } from "node:test";
import { deriveScalpExitGeometry } from "../src/scalp/geometry.ts";
import { priceTrigger } from "../src/execution/executor.ts";

test("Scalp SHORT geometry preserves signed target displacement after a different fill", () => {
  const result = deriveScalpExitGeometry({ side: "SHORT", signalPrice: 100, signalStop: 101,
    signalTakeProfit: 98, fillPrice: 99.7, tickSz: "0.1" });
  assert.equal(result.stopPrice, 100.7);
  assert.equal(result.takeProfitPrice, 97.7);
  assert.ok(result.takeProfitPrice < 99.7 && 99.7 < result.stopPrice);
  assert.equal(result.rewardRisk, 2);
});

test("Scalp LONG geometry translates both exits to the actual fill", () => {
  const result = deriveScalpExitGeometry({ side: "LONG", signalPrice: 100, signalStop: 99,
    signalTakeProfit: 102, fillPrice: 100.3, tickSz: "0.1" });
  assert.equal(result.stopPrice, 99.3);
  assert.equal(result.takeProfitPrice, 102.3);
  assert.ok(result.stopPrice < 100.3 && 100.3 < result.takeProfitPrice);
  assert.equal(result.rewardRisk, 2);
});

test("tick rounding for representative instruments keeps exits on the safe side of entry", () => {
  for (const tickSz of ["0.0001", "0.001", "0.01", "0.1"]) {
    const long = deriveScalpExitGeometry({ side: "LONG", signalPrice: 100, signalStop: 99.1234,
      signalTakeProfit: 101.2345, fillPrice: 100.015, tickSz });
    assert.ok(long.stopPrice < 100.015 && long.takeProfitPrice > 100.015, tickSz);
    const short = deriveScalpExitGeometry({ side: "SHORT", signalPrice: 100, signalStop: 100.8766,
      signalTakeProfit: 98.7655, fillPrice: 99.985, tickSz });
    assert.ok(short.takeProfitPrice < 99.985 && short.stopPrice > 99.985, tickSz);
  }
});

test("invalid direction, zero distance, nonfinite values, or invalid tick are rejected", () => {
  const base = { side: "SHORT" as const, signalPrice: 100, signalStop: 101, signalTakeProfit: 98,
    fillPrice: 99.7, tickSz: "0.1" };
  assert.throws(() => deriveScalpExitGeometry({ ...base, signalStop: 99 }));
  assert.throws(() => deriveScalpExitGeometry({ ...base, signalTakeProfit: 100 }));
  assert.throws(() => deriveScalpExitGeometry({ ...base, fillPrice: Number.NaN }));
  assert.throws(() => deriveScalpExitGeometry({ ...base, tickSz: "0" }));
});

test("software fallback triggers a SHORT target below the fill and stop above it", () => {
  const exits = deriveScalpExitGeometry({ side: "SHORT", signalPrice: 100, signalStop: 101,
    signalTakeProfit: 98, fillPrice: 99.7, tickSz: "0.1" });
  const trade = { side: "SHORT", stop_px: exits.stopPrice, take_profit_px: exits.takeProfitPrice };
  assert.equal(priceTrigger(trade, 97.6), "TP");
  assert.equal(priceTrigger(trade, 100.8), "SL");
  assert.equal(priceTrigger(trade, 99.7), null);
});
