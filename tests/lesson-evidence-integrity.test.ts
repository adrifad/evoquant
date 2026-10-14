import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { getVerifiedV2Lessons } from "../src/agents/v2-evolution.ts";
import { reviewTrade } from "../src/agents/reviewer-agent.ts";
import { openStore } from "../src/memory/db.ts";
import { addLessonEvidence, getActiveLessons, recomputeLesson, upsertLesson } from "../src/memory/lessons.ts";

function storeFor(t: test.TestContext) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "evoq-lesson-integrity-"));
  const store = openStore(dir);
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  return store;
}

function addTrade(store: ReturnType<typeof openStore>, tradeId: string, resultR: number, state: "VALID" | "EVIDENCE_PENDING" = "VALID") {
  store.db.prepare(`INSERT INTO trades(trade_id,engine,status,evidence_state,evolution_evidence_eligible,result_r_basis,
    instrument,timeframe,side,strategy,strategy_core_version,strategy_version,regime,regime_axes,contracts,result_r,exit_ts)
    VALUES(?,'SWING_15M','CLOSED',?,?,?,'BTC-USDT-SWAP','15m','LONG','TREND_FOLLOWING',2,1,'TRENDING_BULLISH','{}','1',?,?)`)
    .run(tradeId, state, state === "VALID" ? 1 : 0, state === "VALID" ? "NET" : "PENDING", resultR,
      new Date(Date.now() + Number(tradeId.replace(/\D/g, "") || 0) * 1000 + 1000).toISOString());
}

test("Reviewer lesson records its source trade and cannot count it as independent evidence", (t) => {
  const store = storeFor(t);
  addTrade(store, "TRADE-1", -1);
  const lessonId = upsertLesson(store, { statement: "Avoid weak trend continuation", confidence: 0.5,
    sourceTradeId: "TRADE-1", scope: { engine: "SWING_15M", strategy: "TREND_FOLLOWING", strategyVersion: 1,
      instrument: "BTC-USDT-SWAP", regime: "TRENDING_BULLISH", direction: "LONG", regimeAxes: "{}" } });
  addLessonEvidence(store, lessonId, "TRADE-1", true);
  assert.deepEqual(store.db.prepare("SELECT source_trade_id,status,observations FROM lessons WHERE lesson_id=?").get(lessonId),
    { source_trade_id: "TRADE-1", status: "PROVISIONAL", observations: 0 });
  assert.equal((store.db.prepare("SELECT COUNT(*) n FROM lesson_evidence WHERE lesson_id=?").get(lessonId) as { n: number }).n, 0);
});

test("Reviewer persists generated natural-language findings only as source-linked provisional lessons", async (t) => {
  const store = storeFor(t);
  store.db.prepare(`INSERT INTO trades(trade_id,engine,status,evidence_state,evolution_evidence_eligible,result_r_basis,accounting_quality,
    instrument,timeframe,side,strategy,strategy_core_version,strategy_version,regime,regime_axes,contracts,entry_px,entry_ts,stop_px,
    initial_stop_px,take_profit_px,exit_px,exit_ts,exit_reason,fees,funding,pnl,result_r,mfe,mae,duration_s,entry_features)
    VALUES('REVIEW-SOURCE','SWING_15M','CLOSED','VALID',1,'NET','COMPLETE','BTC-USDT-SWAP','15m','LONG','TREND_FOLLOWING',2,1,
      'TRENDING_BULLISH','{}','1',100,'2026-10-01T00:00:00Z',98,98,104,102,'2026-10-01T00:15:00Z','TP',0.1,0,1.9,0.95,2,0.5,900,'{}')`).run();
  const roles = { json: async () => ({ observations: [], lesson_candidates: [{ statement: "Volume support improves continuation entries",
    confidence: 0.99, scope: { strategy: "TREND_FOLLOWING" } }] }) } as never;
  assert.ok(await reviewTrade(process.cwd(), roles, store, "REVIEW-SOURCE"));
  const lesson = store.db.prepare("SELECT source_trade_id,status,confidence,observations FROM lessons").get();
  assert.deepEqual(lesson, { source_trade_id: "REVIEW-SOURCE", status: "PROVISIONAL", confidence: 0.5, observations: null });
  assert.deepEqual(store.db.prepare("SELECT outcome,result_r FROM trade_reviews WHERE trade_id='REVIEW-SOURCE'").get(),
    { outcome: null, result_r: null }, "Reviewer still cannot author deterministic trade outcome or R");
});

test("invalid accounting evidence is rejected and cannot affect lesson statistics", (t) => {
  const store = storeFor(t);
  addTrade(store, "TRADE-2", 1, "EVIDENCE_PENDING");
  const id = upsertLesson(store, { statement: "Trend setups fail without volume", confidence: 0.4,
    scope: { engine: "SWING_15M", strategy: "TREND_FOLLOWING", strategyVersion: 1 } });
  addLessonEvidence(store, id, "TRADE-2", true);
  recomputeLesson(store, id);
  assert.equal((store.db.prepare("SELECT COUNT(*) n FROM lesson_evidence WHERE lesson_id=?").get(id) as { n: number }).n, 0);
  assert.deepEqual(store.db.prepare("SELECT status,observations,expectancy_r FROM lessons WHERE lesson_id=?").get(id),
    { status: "PROVISIONAL", observations: 0, expectancy_r: 0 });
});

test("only independent eligible scoped NET observations count; conflict is retained", (t) => {
  const store = storeFor(t);
  addTrade(store, "SOURCE-0", -1);
  const id = upsertLesson(store, { statement: "Continuation entries need aligned volume", confidence: 0.5, sourceTradeId: "SOURCE-0",
    scope: { engine: "SWING_15M", strategy: "TREND_FOLLOWING", strategyVersion: 1,
      instrument: "BTC-USDT-SWAP", regime: "TRENDING_BULLISH", direction: "LONG", regimeAxes: "{}" } });
  addLessonEvidence(store, id, "SOURCE-0", true);
  for (let i = 1; i <= 30; i++) {
    addTrade(store, `TRADE-${i}`, i <= 22 ? 0.5 : -0.5);
    addLessonEvidence(store, id, `TRADE-${i}`, i <= 22);
  }
  let lesson = store.db.prepare("SELECT status,observations,wins,losses,expectancy_r FROM lessons WHERE lesson_id=?").get(id);
  assert.deepEqual(lesson, { status: "VERIFIED", observations: 30, wins: 22, losses: 8, expectancy_r: 0.5 });
  assert.deepEqual(getVerifiedV2Lessons(store, "TREND_FOLLOWING_V2", 1).map((row) => row.lesson_id), [id]);
  assert.equal(getActiveLessons(store, "BTC-USDT-SWAP", "SWING_15M").length, 1);

  for (let i = 31; i <= 50; i++) {
    addTrade(store, `TRADE-${i}`, -0.5);
    addLessonEvidence(store, id, `TRADE-${i}`, false);
  }
  lesson = store.db.prepare("SELECT status,observations,wins,losses FROM lessons WHERE lesson_id=?").get(id);
  assert.deepEqual(lesson, { status: "CONFLICTED", observations: 50, wins: 22, losses: 28 });
  assert.deepEqual(getVerifiedV2Lessons(store, "TREND_FOLLOWING_V2", 1), []);
  assert.deepEqual(getActiveLessons(store, "BTC-USDT-SWAP", "SWING_15M"), []);
});

test("out-of-scope lessons and fewer than the verification threshold are not Evolution inputs", (t) => {
  const store = storeFor(t);
  const id = upsertLesson(store, { statement: "Narrow trend lesson", confidence: 0.9,
    scope: { engine: "SWING_15M", strategy: "TREND_FOLLOWING", strategyVersion: 1, instrument: "BTC-USDT-SWAP" } });
  for (let i = 1; i <= 10; i++) {
    addTrade(store, `TRADE-${i}`, 0.2);
    addLessonEvidence(store, id, `TRADE-${i}`, true);
  }
  store.db.prepare("UPDATE lessons SET status='VERIFIED',observations=99 WHERE lesson_id=?").run(id);
  assert.deepEqual(getVerifiedV2Lessons(store, "TREND_FOLLOWING_V2", 1), [], "stored status/confidence cannot substitute for 30 verified trades");
  assert.deepEqual(getActiveLessons(store, "BTC-USDT-SWAP", "SWING_15M"), [], "advisory retrieval also requires the eligible evidence behind its state");
  assert.deepEqual(getVerifiedV2Lessons(store, "TREND_FOLLOWING_V2", 1, "SCALP_5M"), []);
  assert.deepEqual(getVerifiedV2Lessons(store, "BREAKOUT_V2", 1), []);
});

test("legacy lesson evidence with mismatched scope cannot qualify for Active or Evolution contexts", (t) => {
  const store = storeFor(t);
  const id = upsertLesson(store, { statement: "BTC trend continuation lesson", confidence: 0.9,
    scope: { engine: "SWING_15M", strategy: "TREND_FOLLOWING", strategyVersion: 1,
      instrument: "BTC-USDT-SWAP", direction: "LONG", regime: "TRENDING_BULLISH" } });
  for (let i = 1; i <= 30; i++) {
    addTrade(store, `TRADE-${i}`, 0.5);
    store.db.prepare("UPDATE trades SET instrument='ETH-USDT-SWAP' WHERE trade_id=?").run(`TRADE-${i}`);
    store.db.prepare("INSERT INTO lesson_evidence(lesson_id,trade_id,aligned,ts) VALUES(?,?,1,?)")
      .run(id, `TRADE-${i}`, new Date().toISOString());
  }
  store.db.prepare("UPDATE lessons SET status='VERIFIED',observations=30,confidence=1 WHERE lesson_id=?").run(id);
  assert.deepEqual(getVerifiedV2Lessons(store, "TREND_FOLLOWING_V2", 1), [],
    "legacy evidence from another instrument cannot validate a scoped lesson");
  assert.deepEqual(getActiveLessons(store, "BTC-USDT-SWAP", "SWING_15M"), [],
    "stored VERIFIED status cannot bypass revalidation of evidence scope");
  addLessonEvidence(store, id, "TRADE-1", true);
  assert.equal((store.db.prepare("SELECT COUNT(*) AS n FROM lesson_evidence WHERE lesson_id=?").get(id) as { n: number }).n, 30,
    "scope-mismatched evidence is not duplicated or newly admitted");
});

test("rejected and superseded lessons stay terminal when new evidence is submitted", (t) => {
  const store = storeFor(t);
  addTrade(store, "TRADE-1", 1);
  for (const status of ["REJECTED", "SUPERSEDED"] as const) {
    const id = upsertLesson(store, { statement: `Terminal ${status} lesson`, confidence: 0.4,
      scope: { engine: "SWING_15M", strategy: "TREND_FOLLOWING", strategyVersion: 1 } });
    store.db.prepare("UPDATE lessons SET status=? WHERE lesson_id=?").run(status, id);
    addLessonEvidence(store, id, "TRADE-1", true);
    assert.equal((store.db.prepare("SELECT status FROM lessons WHERE lesson_id=?").get(id) as { status: string }).status, status);
    assert.deepEqual(getActiveLessons(store, "BTC-USDT-SWAP", "SWING_15M").filter((lesson) => lesson.lesson_id === id), []);
  }
});
