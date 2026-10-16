import { test } from "node:test";
import assert from "node:assert/strict";
import { calculateSlPlusStop } from "../src/execution/sl-plus.ts";
import { serializeTradeMutation } from "../src/execution/trade-mutation.ts";
import { requireFilledOrder } from "../src/exchange/okx/orders.ts";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { openStore } from "../src/memory/db.ts";
import { getBotState } from "../src/core/state.ts";
import { updateTradeStopPlus } from "../src/execution/position-management.ts";

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

test("uncertain SL+ amendment degrades protection and halts new entries", async t => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "evoq-sl-plus-risk-"));
  const store = openStore(dir);
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  store.db.prepare(`INSERT INTO trades(trade_id,engine,status,instrument,timeframe,side,strategy,strategy_version,regime,contracts,
    entry_px,entry_ts,stop_px,initial_stop_px,take_profit_px,sl_algo_id,tp_algo_id,protection_state)
    VALUES('SLP','SWING_15M','OPEN','BTC-USDT-SWAP','15m','LONG','TREND_FOLLOWING',1,'TRENDING_BULLISH','1',100,
    '2026-10-16T00:00:00Z',99,99,104,'SL-1','TP-1','VERIFIED')`).run();
  const client = {
    post: async () => [{ sCode: "0" }],
    get: async () => [{ algoId: "SL-1", state: "canceled", instId: "BTC-USDT-SWAP", posSide: "long", sz: "1", slTriggerPx: "100.2" }],
  } as never;
  const result = await updateTradeStopPlus(client, store,
    store.db.prepare("SELECT * FROM trades WHERE trade_id='SLP'").get() as Record<string, unknown>,
    { instId: "BTC-USDT-SWAP", pos: "1", markPx: "101", posSide: "long" } as never,
    { instId: "BTC-USDT-SWAP", tickSz: "0.1" } as never,
    { enabled: true, activation_r: 1, lock_in_r: 0.05, min_profit_buffer_pct: 0.12 });
  assert.equal(result.updated, false);
  assert.equal((store.db.prepare("SELECT protection_state FROM trades WHERE trade_id='SLP'").get() as { protection_state: string }).protection_state, "DEGRADED");
  assert.equal(getBotState(store), "RISK_HALTED");
});

test("SL+ updates only after the existing TP leg is read back live and intact", async t => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "evoq-sl-plus-tp-"));
  const store = openStore(dir);
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  store.db.prepare(`INSERT INTO trades(trade_id,engine,status,instrument,timeframe,side,strategy,strategy_version,regime,contracts,
    entry_px,entry_ts,stop_px,initial_stop_px,take_profit_px,sl_algo_id,tp_algo_id,protection_state)
    VALUES('SLP-TP','SWING_15M','OPEN','BTC-USDT-SWAP','15m','LONG','TREND_FOLLOWING',1,'TRENDING_BULLISH','1',100,
    '2026-10-16T00:00:00Z',99,99,104,'SL-1','TP-1','VERIFIED')`).run();
  const queried: string[] = [];
  const client = {
    post: async () => [{ sCode: "0" }],
    get: async (_endpoint: string, query: Record<string, unknown>) => {
      const id = String(query.algoId); queried.push(id);
      return [{ algoId: id, state: "live", instId: "BTC-USDT-SWAP", tdMode: "isolated", side: "sell",
        ordType: "conditional", posSide: "long", sz: "1", slTriggerPx: id === "SL-1" ? "100.2" : "",
        slTriggerPxType: "mark", tpTriggerPx: id === "TP-1" ? "104" : "", tpTriggerPxType: "mark" }];
    },
  } as never;
  const result = await updateTradeStopPlus(client, store,
    store.db.prepare("SELECT * FROM trades WHERE trade_id='SLP-TP'").get() as Record<string, unknown>,
    { instId: "BTC-USDT-SWAP", pos: "1", markPx: "101", posSide: "long" } as never,
    { instId: "BTC-USDT-SWAP", tickSz: "0.1" } as never,
    { enabled: true, activation_r: 1, lock_in_r: 0.05, min_profit_buffer_pct: 0.12 });
  assert.equal(result.updated, true);
  assert.deepEqual(queried, ["SL-1", "TP-1"]);
  assert.deepEqual(store.db.prepare("SELECT stop_px,take_profit_px,protection_state FROM trades WHERE trade_id='SLP-TP'").get(),
    { stop_px: 100.2, take_profit_px: 104, protection_state: "VERIFIED" });
});
