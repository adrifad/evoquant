import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { openStore } from "../src/memory/db.ts";
import { buildDecisionContext, serializeDecisionContext, decisionMemoryFingerprint, validateMemoryCitations, type DecisionMemoryScope } from "../src/memory/decision-context.ts";

const at = new Date("2026-10-18T12:00:00.000Z");
const scope: DecisionMemoryScope = {
  engine: "SWING_15M", instrument: "BTC-USDT-SWAP", strategy: "TREND_FOLLOWING",
  strategyCoreVersion: 2, strategyVersion: 7, side: "LONG", regime: "TRENDING_BULLISH",
  regimeAxes: { trend: "BULLISH", volatility: "NORMAL" },
};

let generatedId = 0;
function fixture(t: TestContext) {
  const root = mkdtempSync(path.join(os.tmpdir(), "evoq-memory-context-"));
  const store = openStore(root);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  return store;
}

function addTrade(store: ReturnType<typeof openStore>, options: {
  id?: string; exit?: string; r?: number | null; engine?: string; strategy?: string; core?: number; version?: number;
  instrument?: string; side?: string; regime?: string; axes?: string | null; status?: string; evidence?: string;
  eligible?: number; basis?: string; accounting?: string;
} = {}): void {
  const id = options.id ?? `T-${++generatedId}`;
  store.db.prepare(`INSERT INTO trades(trade_id,engine,status,evidence_state,evolution_evidence_eligible,accounting_quality,
    result_r_basis,result_r,pnl,fees,funding,instrument,timeframe,side,strategy,strategy_core_version,strategy_version,regime,
    regime_axes,contracts,entry_ts,exit_ts)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    id, options.engine ?? "SWING_15M", options.status ?? "CLOSED", options.evidence ?? "VALID", options.eligible ?? 1,
    options.accounting ?? "COMPLETE", options.basis ?? "NET", options.r === undefined ? 0.5 : options.r, 1, 0, 0,
    options.instrument ?? scope.instrument, "15m", options.side ?? scope.side, options.strategy ?? scope.strategy,
    options.core ?? scope.strategyCoreVersion, options.version ?? scope.strategyVersion, options.regime ?? scope.regime,
    options.axes ?? JSON.stringify(scope.regimeAxes), "1", "2026-10-17T00:00:00.000Z",
    options.exit ?? "2026-10-18T11:00:00.000Z");
}

function addLesson(store: ReturnType<typeof openStore>, options: {
  id: string; status?: string; statement?: string; confidence?: number; scopeEngine?: string | null;
  strategy?: string | null; version?: number | null; instrument?: string | null; regime?: string | null;
  direction?: string | null; axes?: string | null; created?: string; sourceTradeId?: string | null;
  evidence?: Array<{ aligned: boolean; trade?: Parameters<typeof addTrade>[1] }>;
}): void {
  const created = options.created ?? "2026-10-01T00:00:00.000Z";
  store.db.prepare(`INSERT INTO lessons(lesson_id,statement,status,scope_engine,scope_strategy,scope_strategy_version,
    scope_instrument,scope_regime,scope_direction,scope_regime_axes,source_trade_id,confidence,observations,created_ts,updated_ts)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(options.id, options.statement ?? options.id, options.status ?? "VERIFIED",
    options.scopeEngine === undefined ? scope.engine : options.scopeEngine,
    options.strategy === undefined ? scope.strategy : options.strategy,
    options.version === undefined ? scope.strategyVersion : options.version,
    options.instrument === undefined ? scope.instrument : options.instrument,
    options.regime === undefined ? scope.regime : options.regime,
    options.direction === undefined ? scope.side : options.direction,
    options.axes === undefined ? JSON.stringify(scope.regimeAxes) : options.axes,
    options.sourceTradeId ?? null, options.confidence ?? 0.8, 999, created, created);
  for (const [index, entry] of (options.evidence ?? []).entries()) {
    const tradeId = `LE-${options.id}-${index}`;
    addTrade(store, { ...(entry.trade ?? {}), id: tradeId, exit: "2026-10-17T12:00:00.000Z" });
    store.db.prepare("INSERT INTO lesson_evidence(lesson_id,trade_id,aligned,ts) VALUES(?,?,?,?)")
      .run(options.id, tradeId, entry.aligned ? 1 : 0, "2026-10-17T13:00:00.000Z");
  }
}

test("empty database returns neutral S1/S2 cells and no lessons", (t) => {
  const store = fixture(t);
  assert.deepEqual(buildDecisionContext(store, scope, at), {
    window_days: 30,
    stats: [
      { id: "S1", scope: "exact", trades: 0, wins: 0, losses: 0, win_rate: null, expectancy_r: null },
      { id: "S2", scope: "same_symbol_strategy_direction", trades: 0, wins: 0, losses: 0, win_rate: null, expectancy_r: null },
    ],
    lessons: [],
  });
});

test("trade statistics use the inclusive UTC lower boundary and exclude older/future rows", (t) => {
  const store = fixture(t);
  const lower = new Date(at.getTime() - 30 * 86_400_000).toISOString();
  addTrade(store, { id: "LOWER", exit: lower, r: 2 });
  addTrade(store, { id: "OLDER", exit: new Date(Date.parse(lower) - 1).toISOString(), r: 100 });
  addTrade(store, { id: "FUTURE", exit: new Date(at.getTime() + 1).toISOString(), r: 100 });
  const result = buildDecisionContext(store, scope, at).stats[0]!;
  assert.deepEqual(result, { id: "S1", scope: "exact", trades: 1, wins: 1, losses: 0, win_rate: 1, expectancy_r: 2 });
});

test("only valid eligible NET closed accounting contributes and zero R is not a win", (t) => {
  const store = fixture(t);
  addTrade(store, { id: "VALID-POS", r: 1 });
  addTrade(store, { id: "VALID-ZERO", r: 0 });
  for (const [id, override] of [
    ["OPEN", { status: "OPEN" }], ["PENDING", { status: "RECONCILIATION_PENDING" }],
    ["BAD-EVIDENCE", { evidence: "ACCOUNTING_INCOMPLETE" }], ["INELIGIBLE", { eligible: 0 }],
    ["GROSS", { basis: "GROSS" }], ["NO-R", { r: null }], ["INCOMPLETE-QUALITY", { accounting: "FEE_PENDING" }],
  ] as Array<[string, Parameters<typeof addTrade>[1]]>) addTrade(store, { id, r: 99, ...override });
  assert.deepEqual(buildDecisionContext(store, scope, at).stats[0], {
    id: "S1", scope: "exact", trades: 2, wins: 1, losses: 0, win_rate: 0.5, expectancy_r: 0.5,
  });
});

test("statistics isolate engine, persisted strategy family, core version, strategy version, instrument, direction and regime", (t) => {
  const store = fixture(t);
  addTrade(store, { id: "EXACT", r: 1 });
  addTrade(store, { id: "OTHER-REGIME", regime: "SIDEWAYS", r: 5 });
  addTrade(store, { id: "OTHER-SIDE", side: "SHORT", r: 5 });
  addTrade(store, { id: "OTHER-SYMBOL", instrument: "ETH-USDT-SWAP", r: 5 });
  addTrade(store, { id: "OTHER-STRATEGY", strategy: "BREAKOUT", r: 5 });
  addTrade(store, { id: "OTHER-CORE", core: 1, r: 5 });
  addTrade(store, { id: "OTHER-VERSION", version: 8, r: 5 });
  addTrade(store, { id: "OTHER-ENGINE", engine: "SCALP_5M", strategy: "SCALP", core: 1, version: 1, r: 5 });
  const result = buildDecisionContext(store, scope, at).stats;
  assert.equal(result[0]?.trades, 1);
  assert.equal(result[1]?.trades, 2, "S2 includes exact plus same scope with another categorical regime");
  assert.equal(result[1]?.expectancy_r, 3);
});

test("lesson inclusion uses independent eligible evidence counts, semantic axes, and exact scopes", (t) => {
  const store = fixture(t);
  const eligible = Array.from({ length: 30 }, (_, i) => ({ aligned: i < 22, trade: {
    id: `OBS-${i}`, axes: JSON.stringify({ volatility: "NORMAL", trend: "BULLISH" }),
  } }));
  addLesson(store, { id: "GOOD", evidence: eligible, axes: JSON.stringify({ volatility: "NORMAL", trend: "BULLISH" }) });
  addLesson(store, { id: "PROVISIONAL", status: "PROVISIONAL", evidence: eligible });
  addLesson(store, { id: "CONFLICTED", status: "CONFLICTED", evidence: eligible });
  addLesson(store, { id: "SUPERSEDED", status: "SUPERSEDED", evidence: eligible });
  addLesson(store, { id: "REJECTED", status: "REJECTED", evidence: eligible });
  addLesson(store, { id: "TOO-FEW", status: "VERIFIED", evidence: eligible.slice(0, 29) });
  addLesson(store, { id: "WRONG-AXES", axes: JSON.stringify({ trend: "BEARISH", volatility: "NORMAL" }), evidence: eligible });
  addLesson(store, { id: "WRONG-SYMBOL", instrument: "ETH-USDT-SWAP", evidence: eligible });
  const result = buildDecisionContext(store, scope, at).lessons;
  assert.deepEqual(result.map(lesson => lesson.id), ["GOOD"]);
  assert.equal(result[0]?.n, 30);
  assert.equal(result[0]?.status, "VERIFIED");
});

test("reinforced lessons require ten qualifying observations and scope NULLs wildcard only their dimensions", (t) => {
  const store = fixture(t);
  const evidence = Array.from({ length: 10 }, (_, i) => ({ aligned: i < 7, trade: { id: `RE-${i}` } }));
  addLesson(store, { id: "REINFORCED-OK", status: "REINFORCED", strategy: null, version: null,
    instrument: null, regime: null, direction: null, axes: null, evidence });
  addLesson(store, { id: "EXPLICIT-MISMATCH", status: "REINFORCED", strategy: "BREAKOUT", evidence });
  addLesson(store, { id: "REINFORCED-TOO-FEW", status: "REINFORCED", evidence: evidence.slice(0, 9) });
  const result = buildDecisionContext(store, scope, at).lessons;
  assert.deepEqual(result.map(lesson => lesson.id), ["REINFORCED-OK"]);
  assert.equal(result[0]?.n, 10);
});

test("lesson source trade and evidence with incomplete or wrong scope cannot validate the lesson", (t) => {
  const store = fixture(t);
  const evidence = Array.from({ length: 30 }, (_, i) => ({ aligned: true, trade: { id: `INDEP-${i}` } }));
  addLesson(store, { id: "SELF", sourceTradeId: "LE-SELF-0", evidence });
  addLesson(store, { id: "INVALID-EVIDENCE", evidence: evidence.map((item, i) => ({ ...item,
    trade: i === 0 ? { evidence: "ACCOUNTING_INCOMPLETE" } : item.trade })) });
  addLesson(store, { id: "WRONG-DIRECTION", direction: "SHORT", evidence });
  assert.deepEqual(buildDecisionContext(store, scope, at).lessons.map((lesson) => lesson.id), []);
});

test("lesson ordering is deterministic by specificity, status, strength, confidence, and id and caps at five", (t) => {
  const store = fixture(t);
  const evidence = Array.from({ length: 30 }, (_, i) => ({ aligned: i < 26, trade: { id: `ORD-${i}` } }));
  for (const id of ["A", "B", "C", "D", "E", "F"]) addLesson(store, { id, evidence, confidence: 0.8 });
  addLesson(store, { id: "WILDCARD", strategy: null, version: null, instrument: null,
    regime: null, direction: null, axes: null, evidence, confidence: 1 });
  const result = buildDecisionContext(store, scope, at).lessons;
  assert.equal(result.length, 5);
  assert.deepEqual(result.map(lesson => lesson.id), ["A", "B", "C", "D", "E"]);
});

test("serializer is deterministic, capped, preserves primary statistics, and fingerprint follows sanitized bytes", (t) => {
  const store = fixture(t);
  const evidence = Array.from({ length: 30 }, (_, i) => ({ aligned: i < 24, trade: { id: `SIZE-${i}` } }));
  for (let i = 0; i < 5; i++) addLesson(store, { id: `L-${i}`, statement: `${i}`.repeat(400), evidence });
  const context = buildDecisionContext(store, scope, at);
  const serialized = serializeDecisionContext(context, 2_400);
  assert.ok(serialized.length <= 2_400);
  assert.match(serialized, /"id":"S1"/);
  assert.match(serialized, /"expectancy_r":/);
  assert.equal(serialized, serializeDecisionContext(context, 2_400));
  assert.equal(decisionMemoryFingerprint(serialized), decisionMemoryFingerprint(serialized));
  assert.notEqual(decisionMemoryFingerprint(serialized), decisionMemoryFingerprint(`${serialized} `));
  const bounded = serializeDecisionContext(context, 450);
  const transmitted = (JSON.parse(bounded) as { trade_memory: typeof context }).trade_memory;
  assert.ok(bounded.length <= 450);
  const omitted = context.lessons.find((lesson) => !transmitted.lessons.some((sent) => sent.id === lesson.id));
  assert.ok(omitted, "the reduced budget removes lower-priority lessons");
  assert.equal(validateMemoryCitations([omitted.id], transmitted), false,
    "citation validation against serialized context rejects an omitted lesson");
});

test("decision context retrieval is SELECT-only", (t) => {
  const store = fixture(t);
  addTrade(store, { id: "READONLY", r: 0.25 });
  const before = (store.db.prepare("SELECT total_changes() AS n").get() as { n: number }).n;
  buildDecisionContext(store, scope, at);
  const after = (store.db.prepare("SELECT total_changes() AS n").get() as { n: number }).n;
  assert.equal(after, before);
});
