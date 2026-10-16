import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { finalizePendingEvidence, type EvidenceFinalizerDeps } from "../src/evidence/finalizer.ts";
import { getFillsHistoryForOrder } from "../src/exchange/okx/orders.ts";
import { getFundingBills } from "../src/exchange/okx/account.ts";
import { openStore } from "../src/memory/db.ts";

const instId = "BTC-USDT-SWAP";
const start = 1_700_000_000_000;
const finish = start + 120_000;
const meta = { instId, tickSz: "0.01", lotSz: "1", minSz: "1", ctVal: "1", ctValCcy: "USDT" };

function fixture(t: test.TestContext) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "evoq-accounting-recovery-"));
  const store = openStore(dir);
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  store.db.prepare(`INSERT INTO trades(trade_id,engine,status,evidence_state,evolution_evidence_eligible,accounting_quality,
    instrument,timeframe,side,strategy,strategy_core_version,strategy_version,regime,contracts,entry_px,entry_ts,stop_px,initial_stop_px,take_profit_px,
    exit_px,exit_ts,exit_reason,ord_open_id,ord_close_id,result_r_basis)
    VALUES('ACCT','SWING_15M','CLOSED','EVIDENCE_PENDING',0,'PENDING',?,'15m','LONG','TREND_FOLLOWING',2,3,
      'TRENDING_BULLISH','1',100,?,98,98,106,104,?,'TP','OPEN-1','CLOSE-1','PENDING')`)
    .run(instId, new Date(start).toISOString(), new Date(finish).toISOString());
  return store;
}

function fill(orderId: string, tradeId: string, options: Partial<Record<string, string>> = {}) {
  const isOpen = orderId === "OPEN-1";
  return { instId, tradeId, ordId: orderId, fillPx: isOpen ? "100" : "104", fillSz: "1",
    side: isOpen ? "buy" : "sell", posSide: "long", execType: "T", ts: String(isOpen ? start : finish),
    fee: "-0.1", feeCcy: "USDT", ...options };
}

function candles() { return [[String(start), "100", "105", "99", "104", "1", "1", "1"]]; }

function deps(store: ReturnType<typeof openStore>, get: (endpoint: string, query?: Record<string, unknown>) => unknown, now = finish + 5 * 60_000): EvidenceFinalizerDeps {
  return { store, client: { get: async (endpoint: string, query?: Record<string, unknown>) => get(endpoint, query) } as never,
    instruments: { [instId]: meta }, trading: { timeframe: "15m" } as never, now: () => now };
}

function response(recent: Record<string, unknown>[], history: Record<string, unknown>[] = []) {
  return (endpoint: string, query?: Record<string, unknown>) => {
    if (endpoint === "/api/v5/trade/fills") return recent.filter((f) => f.ordId === query?.ordId);
    if (endpoint === "/api/v5/trade/fills-history") return history.filter((f) => f.ordId === query?.ordId);
    if (endpoint === "/api/v5/account/bills") return [];
    if (endpoint === "/api/v5/market/candles") return candles();
    throw new Error(endpoint);
  };
}

test("entry and exit fees require the exact full quantities for both order legs", async (t) => {
  const store = fixture(t);
  const entry = [fill("OPEN-1", "E1", { fillSz: "0.4", fillPx: "99", fee: "-0.04" }), fill("OPEN-1", "E2", { fillSz: "0.6", fillPx: "101", fee: "-0.06", ts: String(start + 1) })];
  const exit = [fill("CLOSE-1", "X1", { fillSz: "0.25", fillPx: "103", fee: "-0.025" }), fill("CLOSE-1", "X2", { fillSz: "0.75", fillPx: "105", fee: "-0.075", ts: String(finish - 1) })];
  assert.equal(await finalizePendingEvidence(deps(store, response([...entry, ...exit])), 1), 1);
  const row = store.db.prepare("SELECT entry_px,exit_px,fees,pnl,result_r,evidence_state,accounting_quality,evolution_evidence_eligible FROM trades WHERE trade_id='ACCT'").get() as Record<string, unknown>;
  assert.ok(Math.abs(Number(row.entry_px) - 100.2) < 1e-10);
  assert.equal(row.exit_px, 104.5);
  assert.equal(row.fees, 0.2);
  assert.ok(Math.abs(Number(row.pnl) - 4.1) < 1e-10);
  assert.ok(Math.abs(Number(row.result_r) - 4.1 / 2.2) < 1e-10);
  assert.equal(row.evidence_state, "VALID");
  assert.equal(row.accounting_quality, "COMPLETE");
  assert.equal(row.evolution_evidence_eligible, 1);
});

test("missing recent entry or exit leg is recovered from exact-order historical fills", async (t) => {
  for (const missingRecentOrder of ["OPEN-1", "CLOSE-1"]) {
    const store = fixture(t);
    const all = [fill("OPEN-1", "E"), fill("CLOSE-1", "X")];
    const recent = all.filter((f) => f.ordId !== missingRecentOrder);
    const d = deps(store, response(recent, all));
    assert.equal(await finalizePendingEvidence(d, 1), 1, `fallback should repair ${missingRecentOrder}`);
    assert.deepEqual(store.db.prepare("SELECT fees,evidence_state,evolution_evidence_eligible FROM trades WHERE trade_id='ACCT'").get(),
      { fees: 0.2, evidence_state: "VALID", evolution_evidence_eligible: 1 });
  }
});

test("missing trade order IDs are recovered only from exact persisted OPEN/CLOSE order mappings", async (t) => {
  const store = fixture(t);
  store.db.prepare("UPDATE trades SET ord_open_id=NULL,ord_close_id=NULL WHERE trade_id='ACCT'").run();
  store.db.prepare(`INSERT INTO orders(ordId,instId,side,posSide,state,sz,trade_id,kind)
    VALUES('OPEN-1',?,'buy','long','filled','1','ACCT','OPEN'),('CLOSE-1',?,'sell','long','filled','1','ACCT','CLOSE')`).run(instId, instId);
  assert.equal(await finalizePendingEvidence(deps(store, response([fill("OPEN-1", "E"), fill("CLOSE-1", "X")])), 1), 1);
  assert.deepEqual(store.db.prepare("SELECT evidence_state,fees,evolution_evidence_eligible FROM trades WHERE trade_id='ACCT'").get(),
    { evidence_state: "VALID", fees: 0.2, evolution_evidence_eligible: 1 });
});

test("order recovery never treats a CLOSE mapping as the missing OPEN order", async (t) => {
  const store = fixture(t);
  store.db.prepare("UPDATE trades SET ord_open_id=NULL,ord_close_id=NULL,cl_open_id='CLIENT-OPEN' WHERE trade_id='ACCT'").run();
  store.db.prepare(`INSERT INTO orders(ordId,clOrdId,instId,side,posSide,state,sz,trade_id,kind)
    VALUES('CLOSE-1','CLIENT-OPEN',?,'sell','long','filled','1','ACCT','CLOSE')`).run(instId);
  await finalizePendingEvidence(deps(store, response([fill("OPEN-1", "E"), fill("CLOSE-1", "X")])), 1);
  const row = store.db.prepare("SELECT evidence_state,evolution_evidence_eligible,evidence_reason FROM trades WHERE trade_id='ACCT'").get();
  assert.deepEqual(row, { evidence_state: "EVIDENCE_PENDING", evolution_evidence_eligible: 0, evidence_reason: "FEE_ORDER_ID_MISSING" });
});

test("partial recent fills plus overlapping history are deduplicated and never accepted as a complete leg", async (t) => {
  const store = fixture(t);
  const entry = [fill("OPEN-1", "E1", { fillSz: "0.4", fee: "-0.04" })];
  const exit = [fill("CLOSE-1", "X1")];
  const entryHistory = [entry[0]!, fill("OPEN-1", "E2", { fillSz: "0.6", fee: "-0.06", ts: String(start + 1) })];
  const exitHistory = [exit[0]!];
  const d = deps(store, (endpoint, query) => {
    if (endpoint === "/api/v5/trade/fills") return [...entry, ...exit].filter((f) => f.ordId === query?.ordId);
    if (endpoint === "/api/v5/trade/fills-history") return [...entryHistory, ...exitHistory].filter((f) => f.ordId === query?.ordId);
    if (endpoint === "/api/v5/account/bills") return [];
    if (endpoint === "/api/v5/market/candles") return candles();
    throw new Error(endpoint);
  });
  assert.equal(await finalizePendingEvidence(d, 1), 1);
  assert.equal((store.db.prepare("SELECT COUNT(*) n FROM fills WHERE ordId='OPEN-1'").get() as { n: number }).n, 2);
  assert.equal((store.db.prepare("SELECT fees FROM trades WHERE trade_id='ACCT'").get() as { fees: number }).fees, 0.2);
});

test("missing order id/fills, wrong order/instrument/side/time, and wrong quantity stay untrusted", async (t) => {
  for (const mode of ["missing-id", "empty", "missing-entry", "missing-exit", "wrong-order", "wrong-instrument", "wrong-side", "wrong-time", "short-quantity"] as const) {
    const store = fixture(t);
    if (mode === "missing-id") store.db.prepare("UPDATE trades SET ord_open_id=NULL").run();
    const rows = [
      fill("OPEN-1", "E", mode === "wrong-instrument" ? { instId: "ETH-USDT-SWAP" }
        : mode === "wrong-side" ? { side: "sell" }
        : mode === "wrong-time" ? { ts: String(start - 10 * 60_000) }
        : mode === "short-quantity" ? { fillSz: "0.5" }
        : mode === "wrong-order" ? { ordId: "ANOTHER-ORDER" } : {}),
      fill("CLOSE-1", "X"),
    ];
    const returnedRows = mode === "empty" ? [] : mode === "missing-entry" ? rows.filter((row) => row.ordId !== "OPEN-1")
      : mode === "missing-exit" ? rows.filter((row) => row.ordId !== "CLOSE-1") : rows;
    const d = deps(store, mode === "wrong-order"
      ? (endpoint, query) => endpoint === "/api/v5/trade/fills" && query?.ordId === "OPEN-1"
        ? [rows[0]] : response(returnedRows)(endpoint, query)
      : response(returnedRows));
    await finalizePendingEvidence(d, 1);
    const state = store.db.prepare("SELECT evidence_state,evolution_evidence_eligible,result_r_basis,evidence_reason FROM trades WHERE trade_id='ACCT'").get() as Record<string, unknown>;
    assert.equal(state.evidence_state, "EVIDENCE_PENDING", mode);
    assert.equal(state.evolution_evidence_eligible, 0, mode);
    assert.equal(state.result_r_basis, "PENDING", mode);
    assert.match(String(state.evidence_reason), mode === "missing-id" ? /FEE_ORDER_ID_MISSING/ : mode === "missing-exit" ? /EXIT_/ : /ENTRY_/);
  }
});

test("fee accounting preserves rebates and does not trust non-USDT fee currencies", async (t) => {
  const rebateStore = fixture(t);
  const rebates = [fill("OPEN-1", "E", { fee: "0.03" }), fill("CLOSE-1", "X", { fee: "-0.1" })];
  await finalizePendingEvidence(deps(rebateStore, response(rebates)), 1);
  assert.equal((rebateStore.db.prepare("SELECT fees,pnl FROM trades WHERE trade_id='ACCT'").get() as { fees: number }).fees, 0.07);

  const currencyStore = fixture(t);
  const unsupported = [fill("OPEN-1", "E", { feeCcy: "BTC" }), fill("CLOSE-1", "X")];
  await finalizePendingEvidence(deps(currencyStore, response(unsupported)), 1);
  assert.deepEqual(currencyStore.db.prepare("SELECT fees,evidence_state,evolution_evidence_eligible,evidence_reason FROM trades WHERE trade_id='ACCT'").get(),
    { fees: null, evidence_state: "EVIDENCE_PENDING", evolution_evidence_eligible: 0, evidence_reason: "ENTRY_FEE_CURRENCY_UNSUPPORTED" });
});

test("a legacy/default funding zero is not trusted when the funding ledger lookup fails", async (t) => {
  const store = fixture(t);
  store.db.prepare("UPDATE trades SET funding=0 WHERE trade_id='ACCT'").run();
  const all = [fill("OPEN-1", "E"), fill("CLOSE-1", "X")];
  const d = deps(store, (endpoint, query) => {
    if (endpoint === "/api/v5/trade/fills") return all.filter((row) => row.ordId === query?.ordId);
    if (endpoint === "/api/v5/trade/fills-history") return [];
    if (endpoint === "/api/v5/account/bills") throw new Error("temporary account ledger outage");
    if (endpoint === "/api/v5/market/candles") return candles();
    throw new Error(endpoint);
  });
  await finalizePendingEvidence(d, 1);
  assert.deepEqual(store.db.prepare("SELECT fees,funding,pnl,result_r,evidence_state,evolution_evidence_eligible,evidence_reason FROM trades WHERE trade_id='ACCT'").get(),
    { fees: 0.2, funding: null, pnl: null, result_r: null, evidence_state: "EVIDENCE_PENDING", evolution_evidence_eligible: 0,
      evidence_reason: "FUNDING_LOOKUP_PENDING" });
});

test("fill history outside OKX's documented three-month window cannot prove complete fees", async (t) => {
  const store = fixture(t);
  store.db.prepare("UPDATE trades SET entry_ts='2025-01-01T00:00:00.000Z',exit_ts='2025-01-01T00:02:00.000Z'").run();
  const all = [fill("OPEN-1", "E"), fill("CLOSE-1", "X")];
  await finalizePendingEvidence(deps(store, response(all), Date.parse("2026-10-14T00:00:00.000Z")), 1);
  assert.deepEqual(store.db.prepare("SELECT fees,evidence_state,evolution_evidence_eligible,evidence_reason FROM trades WHERE trade_id='ACCT'").get(),
    { fees: null, evidence_state: "EVIDENCE_PENDING", evolution_evidence_eligible: 0, evidence_reason: "FILL_HISTORY_WINDOW_EXCEEDED" });
});

test("historical fill pagination uses billId and reports a bounded incomplete scan", async () => {
  const page = Array.from({ length: 100 }, (_, i) => ({ instId, ordId: "O", tradeId: `T${i}`, billId: `B${100 - i}`, fillPx: "1", fillSz: "1", side: "buy", posSide: "long", ts: "1700000000000", fee: "-0.1", feeCcy: "USDT" }));
  let calls = 0;
  const complete = await getFillsHistoryForOrder({ get: async (_endpoint: string, query: Record<string, unknown>) => {
    calls += 1;
    return query.after ? [{ ...page[0], tradeId: "T-LAST", billId: "B-LAST" }] : page;
  } } as never, instId, "O", 2);
  assert.equal(calls, 2);
  assert.equal(complete.complete, true);
  assert.equal(complete.fills.length, 101);

  const incomplete = await getFillsHistoryForOrder({ get: async () => page.map(({ billId: _billId, ...row }) => row) } as never, instId, "O", 2);
  assert.equal(incomplete.complete, false, "full page without a stable billId cursor cannot prove coverage");
});

test("funding bills follow billId pagination and retain authoritative signed pnl", async () => {
  const page = Array.from({ length: 100 }, (_, i) => ({ billId: `B${String(i).padStart(3, "0")}`, instId,
    ts: String(start + i), pnl: i === 99 ? "-0.50" : "0", balChg: i === 99 ? "-0.47" : "0",
    ccy: "USDT", type: "2", subType: "173" }));
  const requests: Array<Record<string, unknown>> = [];
  const bills = await getFundingBills({ get: async (_endpoint: string, query: Record<string, unknown>) => {
    requests.push(query);
    return query.after ? [{ billId: "B100", instId, ts: String(start + 100), pnl: "0.25", balChg: "0.21", ccy: "USDT", type: "2", subType: "174" }] : page;
  } } as never, instId, start, finish, finish + 5 * 60_000);
  assert.equal(requests.length, 2);
  assert.equal(requests[1]?.after, "B099");
  assert.equal(bills.length, 101);
  assert.equal(bills[99]?.pnl, "-0.50");
  assert.equal(bills[99]?.balChg, "-0.47");
  assert.equal(bills[100]?.pnl, "0.25");
  assert.equal(bills[100]?.balChg, "0.21");
});

test("funding pagination without a stable cursor fails closed instead of proving zero", async () => {
  const fullPage = Array.from({ length: 100 }, (_, i) => ({ instId, ts: String(start + i), pnl: "0", ccy: "USDT", subType: "173" }));
  await assert.rejects(() => getFundingBills({ get: async () => fullPage } as never, instId, start, finish, finish + 5 * 60_000),
    /pagination cursor unavailable/);
});

test("a relevant funding bill without a stable ID remains untrusted instead of synthetic-deduplicating", async () => {
  const bill = { instId, ts: String(start + 1), pnl: "-0.5", balChg: "-0.47", ccy: "USDT", type: "2", subType: "173" };
  await assert.rejects(() => getFundingBills({ get: async () => [bill] } as never, instId, start, finish, finish + 5 * 60_000),
    /stable identifier unavailable/);
});

test("an incomplete history page cannot qualify fees even when it contains some fill records", async (t) => {
  const store = fixture(t);
  const page = Array.from({ length: 100 }, (_, i) => fill("OPEN-1", `PART-${i}`, {
    fillSz: "0.01", fee: "-0.001", ts: String(start + i),
  }));
  const exit = fill("CLOSE-1", "EXIT");
  const d = deps(store, (endpoint, query) => {
    if (endpoint === "/api/v5/trade/fills") return query?.ordId === "OPEN-1" ? [] : [exit];
    if (endpoint === "/api/v5/trade/fills-history") return page;
    if (endpoint === "/api/v5/account/bills") return [];
    if (endpoint === "/api/v5/market/candles") return candles();
    throw new Error(endpoint);
  });
  await finalizePendingEvidence(d, 1);
  assert.deepEqual(store.db.prepare("SELECT fees,evidence_state,evolution_evidence_eligible,evidence_reason FROM trades WHERE trade_id='ACCT'").get(),
    { fees: null, evidence_state: "EVIDENCE_PENDING", evolution_evidence_eligible: 0, evidence_reason: "ENTRY_FILL_HISTORY_INCOMPLETE" });
});

test("ACCOUNTING_INCOMPLETE is retried with backoff, recovers idempotently, and respects cycle batch limits", async (t) => {
  const store = fixture(t);
  store.db.prepare(`UPDATE trades SET evidence_state='ACCOUNTING_INCOMPLETE', evidence_attempts=12,
    evidence_reason='FEE_LOOKUP_PENDING_RETRY_EXHAUSTED', accounting_reconcile_next_retry_ts=NULL, fees=NULL, funding=0`).run();
  store.db.prepare(`INSERT INTO trades(trade_id,engine,status,evidence_state,evolution_evidence_eligible,accounting_quality,instrument,timeframe,side,
    strategy,strategy_core_version,strategy_version,regime,contracts,entry_px,entry_ts,stop_px,initial_stop_px,take_profit_px,exit_px,exit_ts,exit_reason,
    ord_open_id,ord_close_id,result_r_basis,accounting_reconcile_next_retry_ts)
    SELECT 'ACCT-2',engine,status,evidence_state,0,accounting_quality,instrument,timeframe,side,strategy,strategy_core_version,strategy_version,
    regime,contracts,entry_px,entry_ts,stop_px,initial_stop_px,take_profit_px,exit_px,exit_ts,exit_reason,ord_open_id,ord_close_id,'PENDING',accounting_reconcile_next_retry_ts
    FROM trades WHERE trade_id='ACCT'`).run();
  store.db.prepare("UPDATE trades SET accounting_reconcile_next_retry_ts=? WHERE trade_id='ACCT-2'")
    .run(new Date(finish + 24 * 60 * 60_000).toISOString());
  let now = finish + 10 * 60_000;
  const all = [fill("OPEN-1", "E"), fill("CLOSE-1", "X")];
  const d = deps(store, response([]), now);
  d.now = () => now;
  assert.equal(await finalizePendingEvidence(d, 1), 0, "failed accounting stays ineligible");
  let row = store.db.prepare("SELECT evidence_state,accounting_reconcile_attempts,accounting_reconcile_next_retry_ts,evolution_evidence_eligible FROM trades WHERE trade_id='ACCT'").get() as Record<string, unknown>;
  assert.deepEqual(row, { evidence_state: "ACCOUNTING_INCOMPLETE", accounting_reconcile_attempts: 1,
    accounting_reconcile_next_retry_ts: new Date(now + 15 * 60_000).toISOString(), evolution_evidence_eligible: 0 });
  assert.equal((store.db.prepare("SELECT accounting_reconcile_attempts FROM trades WHERE trade_id='ACCT-2'").get() as { accounting_reconcile_attempts: number }).accounting_reconcile_attempts, 0,
    "batch limit leaves the second trade untouched");
  now += 15 * 60_000;
  (d.client as unknown as { get: (endpoint: string, query?: Record<string, unknown>) => Promise<unknown> }).get = async (endpoint, query) => response(all)(endpoint, query);
  assert.equal(await finalizePendingEvidence(d, 1), 1);
  const valid = store.db.prepare("SELECT fees,funding,pnl,result_r,evidence_state,evolution_evidence_eligible,accounting_reconcile_attempts FROM trades WHERE trade_id='ACCT'").get();
  assert.deepEqual(valid, { fees: 0.2, funding: 0, pnl: 3.8, result_r: 1.9, evidence_state: "VALID", evolution_evidence_eligible: 1, accounting_reconcile_attempts: 1 });
  assert.equal((store.db.prepare("SELECT accounting_reconcile_last_result FROM trades WHERE trade_id='ACCT'").get() as { accounting_reconcile_last_result: string }).accounting_reconcile_last_result, "RECOVERED");
  assert.equal(await finalizePendingEvidence(d, 1), 0, "re-running does not duplicate costs or reopen a valid trade");
  assert.deepEqual(store.db.prepare("SELECT fees,pnl,result_r,evidence_state FROM trades WHERE trade_id='ACCT'").get(),
    { fees: 0.2, pnl: 3.8, result_r: 1.9, evidence_state: "VALID" });
});

test("accounting retry backoff has a bounded maximum interval", async (t) => {
  const store = fixture(t);
  store.db.prepare(`UPDATE trades SET evidence_state='ACCOUNTING_INCOMPLETE',evidence_attempts=12,
    accounting_reconcile_attempts=10,accounting_reconcile_next_retry_ts=NULL`).run();
  const now = finish + 5 * 60_000;
  await finalizePendingEvidence(deps(store, response([]), now), 1);
  assert.deepEqual(store.db.prepare("SELECT evidence_state,accounting_reconcile_attempts,accounting_reconcile_next_retry_ts FROM trades WHERE trade_id='ACCT'").get(),
    { evidence_state: "ACCOUNTING_INCOMPLETE", accounting_reconcile_attempts: 11,
      accounting_reconcile_next_retry_ts: new Date(now + 24 * 60 * 60_000).toISOString() });
});
