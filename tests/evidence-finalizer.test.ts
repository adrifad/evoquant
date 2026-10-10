import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { getV2EvolutionEvidence } from "../src/agents/v2-evolution.ts";
import { reviewTrade } from "../src/agents/reviewer-agent.ts";
import { finalizePendingEvidence, reviewerEligibleTradeIds, type EvidenceFinalizerDeps } from "../src/evidence/finalizer.ts";
import { openStore } from "../src/memory/db.ts";

const symbol = "BTC-USDT-SWAP";
const entryMs = 1_700_000_000_000;
const exitMs = entryMs + 120_000;
const meta = { instId: symbol, tickSz: "0.01", lotSz: "1", minSz: "1", ctVal: "1", ctValCcy: "USDT" };

function withStore(t: test.TestContext) {
  const root = mkdtempSync(path.join(os.tmpdir(), "evoq-finalizer-"));
  const store = openStore(root);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  return store;
}

function seedPending(store: ReturnType<typeof openStore>, id = "T1", engine = "SWING_15M") {
  store.db.prepare(`INSERT INTO trades(trade_id,engine,status,evidence_state,evolution_evidence_eligible,accounting_quality,
    instrument,timeframe,side,strategy,strategy_core_version,strategy_version,regime,contracts,entry_px,entry_ts,stop_px,initial_stop_px,take_profit_px,
    exit_px,exit_ts,exit_reason,ord_open_id,ord_close_id,result_r_basis)
    VALUES(?,?,'CLOSED','EVIDENCE_PENDING',0,'PENDING',?,'15m','LONG','TREND_FOLLOWING',2,3,'TRENDING_BULLISH','1',100,?,98,98,106,104,?,'TP','OPEN-1','CLOSE-1','PENDING')`)
    .run(id, engine, symbol, new Date(entryMs).toISOString(), new Date(exitMs).toISOString());
}

function deps(store: ReturnType<typeof openStore>, response: (endpoint: string, query?: Record<string, unknown>) => unknown, now = exitMs + 5 * 60_000): EvidenceFinalizerDeps {
  return {
    store, client: { get: async (endpoint: string, query?: Record<string, unknown>) => response(endpoint, query) } as never,
    instruments: { [symbol]: meta }, trading: { timeframe: "15m" } as never, now: () => now,
  };
}

function fills(order: string) {
  return order === "OPEN-1"
    ? [{ instId: symbol, tradeId: "F-OPEN", ordId: order, fillPx: "100", fillSz: "1", side: "buy", posSide: "long", execType: "T", ts: String(entryMs), fee: "-0.1", feeCcy: "USDT" }]
    : [{ instId: symbol, tradeId: "F-CLOSE", ordId: order, fillPx: "104", fillSz: "1", side: "sell", posSide: "long", execType: "T", ts: String(exitMs), fee: "-0.1", feeCcy: "USDT" }];
}

const confirmedCandles = [
  [String(entryMs), "100", "105", "99", "104", "1", "1", "1"],
];

test("a proven no-funding trade becomes NET valid Evolution evidence", async t => {
  const store = withStore(t); seedPending(store);
  const done = await finalizePendingEvidence(deps(store, (endpoint, query) => {
    if (endpoint === "/api/v5/trade/fills") return fills(String(query?.ordId));
    if (endpoint === "/api/v5/account/bills") return [];
    if (endpoint === "/api/v5/market/candles") return confirmedCandles;
    throw new Error(endpoint);
  }));
  assert.equal(done, 1);
  const row = store.db.prepare("SELECT funding,fees,pnl,result_r,result_r_basis,evidence_state,accounting_quality,evolution_evidence_eligible FROM trades WHERE trade_id='T1'").get();
  assert.deepEqual(row, { funding: 0, fees: 0.2, pnl: 3.8, result_r: 1.9, result_r_basis: "NET", evidence_state: "VALID", accounting_quality: "COMPLETE", evolution_evidence_eligible: 1 });
  assert.deepEqual(reviewerEligibleTradeIds(store), ["T1"]);
  assert.equal(getV2EvolutionEvidence(store, "TREND_FOLLOWING_V2", 3).length, 1);
});

test("actual funding is included in deterministic NET PnL and R", async t => {
  const store = withStore(t); seedPending(store);
  await finalizePendingEvidence(deps(store, (endpoint, query) => {
    if (endpoint === "/api/v5/trade/fills") return fills(String(query?.ordId));
    if (endpoint === "/api/v5/account/bills") return [{ billId: "B1", instId: symbol, ts: String(exitMs - 1), pnl: "-0.5", balChg: "-0.47", ccy: "USDT", type: "8", subType: "173" }];
    if (endpoint === "/api/v5/market/candles") return confirmedCandles;
    throw new Error(endpoint);
  }));
  assert.deepEqual(store.db.prepare("SELECT funding,pnl,result_r,evidence_state FROM trades WHERE trade_id='T1'").get(),
    { funding: -0.5, pnl: 3.3, result_r: 1.65, evidence_state: "VALID" });
});

test("funding uses signed authoritative pnl, sums only the exact position interval and ignores balChg", async t => {
  const store = withStore(t); seedPending(store);
  await finalizePendingEvidence(deps(store, (endpoint, query) => {
    if (endpoint === "/api/v5/trade/fills") return fills(String(query?.ordId));
    if (endpoint === "/api/v5/account/bills") return [
      { billId: "expense", instId: symbol, ts: String(entryMs + 1), pnl: "-0.50", balChg: "-0.47", ccy: "USDT", subType: "173" },
      { billId: "income", instId: symbol, ts: String(exitMs - 1), pnl: "0.20", balChg: "0.19", ccy: "USDT", subType: "174" },
      { billId: "outside", instId: symbol, ts: String(exitMs + 1), pnl: "99", balChg: "99", ccy: "USDT", subType: "174" },
      { billId: "wrong", instId: "ETH-USDT-SWAP", ts: String(exitMs - 1), pnl: "99", balChg: "99", ccy: "USDT", subType: "174" },
    ];
    if (endpoint === "/api/v5/market/candles") return confirmedCandles;
    throw new Error(endpoint);
  }));
  assert.deepEqual(store.db.prepare("SELECT funding,pnl,result_r,evidence_state FROM trades WHERE trade_id='T1'").get(),
    { funding: -0.3, pnl: 3.5, result_r: 1.75, evidence_state: "VALID" });
});

test("temporary funding failure remains pending and never assumes zero", async t => {
  const store = withStore(t); seedPending(store);
  await finalizePendingEvidence(deps(store, (endpoint, query) => {
    if (endpoint === "/api/v5/trade/fills") return fills(String(query?.ordId));
    if (endpoint === "/api/v5/account/bills") throw new Error("temporary outage");
    if (endpoint === "/api/v5/market/candles") return confirmedCandles;
    throw new Error(endpoint);
  }));
  assert.deepEqual(store.db.prepare("SELECT funding,result_r,evidence_state,evidence_reason,evolution_evidence_eligible FROM trades WHERE trade_id='T1'").get(),
    { funding: null, result_r: null, evidence_state: "EVIDENCE_PENDING", evidence_reason: "FUNDING_LOOKUP_PENDING", evolution_evidence_eligible: 0 });
  assert.deepEqual(reviewerEligibleTradeIds(store), []);
});

test("a scalp waits for its current 1m candle then finalizes idempotently", async t => {
  const store = withStore(t); seedPending(store, "S1", "SCALP_5M");
  let confirmed = false;
  const d = deps(store, (endpoint, query) => {
    if (endpoint === "/api/v5/trade/fills") return fills(String(query?.ordId));
    if (endpoint === "/api/v5/account/bills") return [];
    if (endpoint === "/api/v5/market/candles") return [
      [String(entryMs), "100", "105", "99", "104", "1", "1", "1"],
      [String(entryMs + 60_000), "104", "104", "103", "104", "1", "1", confirmed ? "1" : "0"],
    ];
    throw new Error(endpoint);
  });
  await finalizePendingEvidence(d);
  assert.deepEqual(store.db.prepare("SELECT mfe,mae,evidence_state,evolution_evidence_eligible FROM trades WHERE trade_id='S1'").get(),
    { mfe: null, mae: null, evidence_state: "EVIDENCE_PENDING", evolution_evidence_eligible: 0 });
  confirmed = true;
  store.db.prepare("UPDATE trades SET evidence_next_retry_ts=NULL WHERE trade_id='S1'").run();
  assert.equal(await finalizePendingEvidence(d), 1);
  const first = store.db.prepare("SELECT funding,fees,mfe,mae,pnl,result_r,evidence_state FROM trades WHERE trade_id='S1'").get();
  assert.deepEqual(first, { funding: 0, fees: 0.2, mfe: 5, mae: 1, pnl: 3.8, result_r: 1.9, evidence_state: "VALID" });
  assert.equal(await finalizePendingEvidence(d), 0);
  assert.deepEqual(store.db.prepare("SELECT funding,fees,mfe,mae,pnl,result_r,evidence_state FROM trades WHERE trade_id='S1'").get(), first);
});

test("reconciliation-pending and invalid rows cannot enter Reviewer or Evolution", t => {
  const store = withStore(t);
  seedPending(store, "BAD");
  store.db.prepare("UPDATE trades SET evidence_state='INVALID', evolution_evidence_eligible=0, result_r_basis='PENDING' WHERE trade_id='BAD'").run();
  assert.deepEqual(reviewerEligibleTradeIds(store), []);
  assert.equal(getV2EvolutionEvidence(store, "TREND_FOLLOWING_V2", 3).length, 0);
});

test("Reviewer cannot run while evidence is pending and becomes eligible after VALID", async t => {
  const store = withStore(t); seedPending(store);
  let calls = 0;
  const roles = { json: async () => { calls += 1; return { observations: [], lesson_candidates: [] }; } } as never;
  assert.equal(await reviewTrade(process.cwd(), roles, store, "T1"), null);
  assert.equal(calls, 0);
  await finalizePendingEvidence(deps(store, (endpoint, query) => {
    if (endpoint === "/api/v5/trade/fills") return fills(String(query?.ordId));
    if (endpoint === "/api/v5/account/bills") return [];
    if (endpoint === "/api/v5/market/candles") return confirmedCandles;
    throw new Error(endpoint);
  }));
  assert.notEqual(await reviewTrade(process.cwd(), roles, store, "T1"), null);
  assert.equal(calls, 1);
});

test("metadata-pending evidence advances bounded retries and completes after exact metadata recovery", async t => {
  const store = withStore(t); seedPending(store, "META");
  const recovered: Record<string, typeof meta> = {};
  const d: EvidenceFinalizerDeps = {
    ...deps(store, (endpoint, query) => {
      if (endpoint === "/api/v5/trade/fills") return fills(String(query?.ordId));
      if (endpoint === "/api/v5/account/bills") return [];
      if (endpoint === "/api/v5/market/candles") return confirmedCandles;
      throw new Error(endpoint);
    }), instruments: recovered,
    hydrateInstrumentMetadata: async ([instrument]) => { if (instrument === symbol && recovered[symbol]) return; },
  };
  await finalizePendingEvidence(d);
  assert.deepEqual(store.db.prepare("SELECT evidence_state,evidence_reason,evidence_attempts,evolution_evidence_eligible FROM trades WHERE trade_id='META'").get(),
    { evidence_state: "EVIDENCE_PENDING", evidence_reason: "INSTRUMENT_METADATA_PENDING", evidence_attempts: 1, evolution_evidence_eligible: 0 });
  recovered[symbol] = meta;
  store.db.prepare("UPDATE trades SET evidence_next_retry_ts=NULL WHERE trade_id='META'").run();
  assert.equal(await finalizePendingEvidence(d), 1);
  assert.deepEqual(store.db.prepare("SELECT evidence_state,result_r_basis,evolution_evidence_eligible FROM trades WHERE trade_id='META'").get(),
    { evidence_state: "VALID", result_r_basis: "NET", evolution_evidence_eligible: 1 });
});
