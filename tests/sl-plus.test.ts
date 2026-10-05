import { test } from "node:test";
import assert from "node:assert/strict";
import { calculateSlPlusStop } from "../src/execution/sl-plus.ts";
import { serializeTradeMutation } from "../src/execution/trade-mutation.ts";
import { requireFilledOrder } from "../src/exchange/okx/orders.ts";

const base = {
  side: "LONG" as const,
  entryPx: 100,
  initialStopPx: 99,
  currentStopPx: 99,
  markPx: 101,
  tickSz: 0.1,
  activationR: 1,
  lockInR: 0.05,
  minProfitBufferPct: 0.12,
};

test("SL+ activates at configured R and locks the larger of R buffer and cost buffer", () => {
  assert.equal(calculateSlPlusStop({ ...base, markPx: 100.99 }), null);
  assert.equal(calculateSlPlusStop(base), 100.2);
});

test("SL+ mirrors for SHORT and rounds stops favorably to tick size", () => {
  const stop = calculateSlPlusStop({ ...base, side: "SHORT", initialStopPx: 101, currentStopPx: 101, markPx: 99 });
  assert.equal(stop, 99.8);
});

test("SL+ never loosens an existing stop or places it at/through mark", () => {
  assert.equal(calculateSlPlusStop({ ...base, currentStopPx: 100.3 }), null);
  assert.equal(calculateSlPlusStop({ ...base, markPx: 100.1 }), null);
});

test("trade mutations for one position are serialized, while other positions may proceed", async () => {
  const events: string[] = [];
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const first = serializeTradeMutation("trade-1", async () => {
    events.push("first-start");
    await firstGate;
    events.push("first-end");
  });
  const second = serializeTradeMutation("trade-1", async () => { events.push("second"); });
  const independent = serializeTradeMutation("trade-2", async () => { events.push("independent"); });
  await independent;
  assert.deepEqual(events, ["first-start", "independent"]);
  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(events, ["first-start", "independent", "first-end", "second"]);
});

test("a canceled terminal close order is not accepted as filled", () => {
  assert.equal(requireFilledOrder({ state: "filled", ordId: "filled-1" }).ordId, "filled-1");
  assert.throws(() => requireFilledOrder({ state: "canceled" }), /order not filled: canceled/);
});
