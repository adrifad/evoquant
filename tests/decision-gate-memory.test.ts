import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { CandidateGateSchema, gateCandidate } from "../src/agents/decision-agent.ts";
import { ScalpCandidateGateSchema, gateSignal } from "../src/agents/scalp-agent.ts";
import { SCALP_DEFAULTS } from "../src/scalp/signals.ts";
import { openStore, type Store } from "../src/memory/db.ts";
import type { TradeCandidate } from "../src/strategy/core-v2.ts";
import type { ScalpSignal } from "../src/scalp/signals.ts";
import type { RoleLlmService } from "../src/core/llm-role-service.ts";

function fixture(t: TestContext): { root: string; store: Store } {
  const previousFlag = process.env.GATE_MEMORY_ENABLED;
  delete process.env.GATE_MEMORY_ENABLED;
  t.after(() => {
    if (previousFlag === undefined) delete process.env.GATE_MEMORY_ENABLED;
    else process.env.GATE_MEMORY_ENABLED = previousFlag;
  });
  const root = mkdtempSync(path.join(os.tmpdir(), "evoq-gate-memory-"));
  const promptDir = path.join(root, "prompts");
  writeFileSync(path.join(root, ".env"), "GATE_MEMORY_ENABLED=false\n");
  const sourcePrompt = readFileSync(new URL("../prompts/candidate-gate.md", import.meta.url), "utf8");
  mkdirSync(promptDir, { recursive: true });
  writeFileSync(path.join(promptDir, "candidate-gate.md"), sourcePrompt);
  const store = openStore(root);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, store };
}

type Call = { role: string; system: string; user: string; contextRef: string };
function fakeRoles(calls: Call[], response: unknown): RoleLlmService {
  const stub = { json: async <T>(role: string, system: string, user: string, schema: { parse(value: unknown): T }, contextRef: string) => {
    calls.push({ role, system, user, contextRef });
    return schema.parse(response);
  } };
  return stub as unknown as RoleLlmService;
}

const candidate: TradeCandidate = {
  instrument: "BTC-USDT-SWAP", engine: "SWING_15M", strategy: "BREAKOUT_V2", strategyVersion: 7,
  side: "LONG", setupScore: 0.81, entryPrice: 100, stopPrice: 98, takeProfitPrice: 104,
  stopAtr: 2, targetR: 2, regime: { trend: "BULL_TREND", volatility: "NORMAL" }, conditions: [], reasoning: ["confirmed breakout"],
  maxHoldBars: 20, features: {} as TradeCandidate["features"], signalTs: 1,
};
const scalpSignal: ScalpSignal = {
  instrument: "ETH-USDT-SWAP", direction: -1, score: 0.7, price: 100, stopPx: 101, tpPx: 98, atr: 1,
  reason: "deterministic setup", regime: "TRENDING_BEARISH", ts: 1,
};

function addHistory(store: Store, count = 30): void {
  const insert = store.db.prepare(`INSERT INTO trades(trade_id,engine,status,evidence_state,evolution_evidence_eligible,accounting_quality,
    result_r_basis,result_r,pnl,fees,funding,instrument,timeframe,side,strategy,strategy_core_version,strategy_version,regime,
    regime_axes,contracts,entry_ts,exit_ts) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  for (let i = 0; i < count; i++) insert.run(`MEM-TRADE-${i}`, "SWING_15M", "CLOSED", "VALID", 1, "COMPLETE", "NET", -0.5, -1, 0, 0,
    candidate.instrument, "15m", "LONG", "BREAKOUT", 2, 7, "TRENDING_BULLISH",
    JSON.stringify(candidate.regime), "1", "2026-10-17T00:00:00Z", `2026-10-18T00:${String(i).padStart(2,"0")}:00Z`);
}

function addScalpHistory(store: Store): void {
  const insert = store.db.prepare(`INSERT INTO trades(trade_id,engine,status,evidence_state,evolution_evidence_eligible,accounting_quality,
    result_r_basis,result_r,pnl,fees,funding,instrument,timeframe,side,strategy,strategy_core_version,strategy_version,regime,
    regime_axes,contracts,entry_ts,exit_ts) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  insert.run("SCALP-SHORT", "SCALP_5M", "CLOSED", "VALID", 1, "COMPLETE", "NET", 0.25, 1, 0, 0,
    scalpSignal.instrument, "5m", "SHORT", "SCALP", 1, 1, "TRENDING_BEARISH", null,
    "1", "2026-10-17T00:00:00Z", "2026-10-18T00:00:00Z");
  insert.run("SCALP-LONG", "SCALP_5M", "CLOSED", "VALID", 1, "COMPLETE", "NET", -5, -1, 0, 0,
    scalpSignal.instrument, "5m", "LONG", "SCALP", 1, 1, "TRENDING_BEARISH", null,
    "1", "2026-10-17T00:00:00Z", "2026-10-18T00:00:00Z");
}

test("memory disabled keeps legacy Swing request and executes no memory queries", async (t) => {
  const { root, store } = fixture(t);
  let selects = 0;
  const originalPrepare = store.db.prepare.bind(store.db);
  const readOnlyCountingStore = { db: new Proxy(store.db, { get(target, property, receiver) {
    if (property === "prepare") return (sql: string) => {
      if (/FROM trades|FROM lessons/i.test(sql)) selects++;
      return originalPrepare(sql);
    };
    return Reflect.get(target, property, receiver) as unknown;
  } }) } as Store;
  const calls: Call[] = [];
  const legacy = readFileSync(new URL("../prompts/candidate-gate.md", import.meta.url), "utf8")
    .replace(/\n?<!-- TRADE_MEMORY_RULES_START -->[\s\S]*?<!-- TRADE_MEMORY_RULES_END -->\n?/g, "\n");
  const result = await gateCandidate(root, fakeRoles(calls, { verdict: "ALLOW", confidence: 0.8 }), candidate, readOnlyCountingStore, "TRENDING_BULLISH");
  assert.ok(result);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.contextRef, "candidate_gate");
  assert.equal(calls[0]?.system, legacy);
  const payload = JSON.parse(calls[0]!.user) as Record<string, unknown>;
  assert.equal("trade_memory" in payload, false);
  assert.equal(selects, 0);
});

test("enabled Swing gate supplies mapped family, categorical regime, axes, fingerprint and validated citations", async (t) => {
  const { root, store } = fixture(t);
  writeFileSync(path.join(root, ".env"), "GATE_MEMORY_ENABLED=true\n");
  addHistory(store);
  const calls: Call[] = [];
  const result = await gateCandidate(root, fakeRoles(calls, { verdict: "DENY", confidence: 0.8,
    reasoning: ["S1: 30 matched trades, negative NET expectancy -0.5R"], cited_memory: ["S1"], deny_basis: "MEMORY" }), candidate, store, "TRENDING_BULLISH");
  assert.ok(result);
  assert.equal(result.verdict, "DENY");
  assert.equal(result.effectiveVerdict, "DENY");
  assert.equal(result.policyDisposition, "ACCEPT");
  assert.deepEqual(result.cited_memory, ["S1"]);
  assert.match(calls[0]!.contextRef, /^candidate_gate:mem:[a-f0-9]{16}$/);
  assert.ok(calls[0]!.contextRef.length <= 80);
  const payload = JSON.parse(calls[0]!.user) as { market_regime: string; trade_memory: { stats: Array<{ id: string; trades: number }> } };
  assert.equal(payload.market_regime, "TRENDING_BULLISH");
  assert.equal(payload.trade_memory.stats[0]?.trades, 30);
  assert.equal(payload.trade_memory.stats[0]?.id, "S1");
  assert.match(calls[0]!.system, /fewer than 10 trades as WEAK/i);
  assert.match(calls[0]!.system, /10–29 as EXPLORATORY/i);
  assert.match(calls[0]!.system, /At least 30 is STRONGER/i);
  assert.match(calls[0]!.system, /S2 includes S1/);
  assert.equal(calls.length, 1);
});

test("memory retrieval failure falls back to one legacy gate call without exposing query errors", async (t) => {
  const { root, store } = fixture(t);
  writeFileSync(path.join(root, ".env"), "GATE_MEMORY_ENABLED=true\n");
  const brokenStore = { db: new Proxy(store.db, { get(target, property, receiver) {
    if (property === "prepare") return (sql: string) => {
      if (/FROM trades/i.test(sql)) throw new Error("SQL_SECRET_DETAIL");
      return Reflect.get(target, property, receiver) as unknown;
    };
    return Reflect.get(target, property, receiver) as unknown;
  } }) } as Store;
  const calls: Call[] = [];
  const result = await gateCandidate(root, fakeRoles(calls, { verdict: "ALLOW", confidence: 0.8 }), candidate,
    brokenStore, "TRENDING_BULLISH");
  assert.ok(result);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.contextRef, "candidate_gate");
  assert.equal("trade_memory" in JSON.parse(calls[0]!.user), false);
  assert.equal(calls[0]!.user.includes("SQL_SECRET_DETAIL"), false);
  assert.equal(calls[0]!.system.includes("HISTORICAL TRADE MEMORY"), false);
});

test("ALLOW remains ALLOW when optional citations are absent from the memory-disabled payload", async (t) => {
  const { root } = fixture(t);
  const swingCalls: Call[] = [];
  const swing = await gateCandidate(root, fakeRoles(swingCalls, { verdict: "ALLOW", confidence: 0.8, cited_memory: ["S1"] }),
    candidate, undefined, undefined);
  assert.equal(swing?.policyDisposition, "ACCEPT");
  assert.equal(swing?.effectiveVerdict, "ALLOW");
  assert.deepEqual(swing?.cited_memory, []);
  assert.equal(swingCalls.length, 1);

  const scalpCalls: Call[] = [];
  const scalp = await gateSignal(fakeRoles(scalpCalls, { verdict: "ALLOW", confidence: 0.8, reason: "ok", cited_memory: ["S1"] }),
    scalpSignal, SCALP_DEFAULTS, { stance: "NEUTRAL", regime: "TRENDING_BEARISH", atrPct15m: 0.2, spreadOk: true }, undefined, root);
  assert.equal(scalp.policyDisposition, "ACCEPT");
  assert.equal(scalp.allow, true);
  assert.deepEqual(scalp.citedMemory, []);
  assert.equal(scalp.unavailable, false);
  assert.equal(scalpCalls.length, 1);
});

test("Scalp gate scopes short direction and validates only supplied memory IDs", async (t) => {
  const { root, store } = fixture(t);
  writeFileSync(path.join(root, ".env"), "GATE_MEMORY_ENABLED=true\n");
  addScalpHistory(store);
  const calls: Call[] = [];
  const result = await gateSignal(fakeRoles(calls, { verdict: "ALLOW", confidence: 0.7, reason: "market context", cited_memory: [] }),
    scalpSignal, SCALP_DEFAULTS, { stance: "NEUTRAL", regime: "TRENDING_BEARISH", atrPct15m: 0.2, spreadOk: true }, store, root);
  assert.equal(result.allow, true);
  assert.match(result.contextRef, /^scalp_candidate_gate:mem:[a-f0-9]{16}$/);
  const payload = JSON.parse(calls[0]!.user) as { signal: ScalpSignal; trade_memory: { stats: Array<{ trades: number }> } };
  assert.equal(payload.signal.direction, -1);
  assert.equal(payload.trade_memory.stats[0]?.trades, 1, "SHORT Scalp history is included while the opposite direction is excluded");
  assert.match(calls[0]!.system, /10–29|10-29/);

  const invalidCalls: Call[] = [];
  const invalid = await gateSignal(fakeRoles(invalidCalls, { verdict: "ALLOW", confidence: 0.7, reason: "ok", cited_memory: ["NOT-SUPPLIED"] }),
    scalpSignal, SCALP_DEFAULTS, { stance: "NEUTRAL", regime: "TRENDING_BEARISH", atrPct15m: 0.2, spreadOk: true }, store, root);
  assert.equal(invalid.allow, true, "optional citations cannot turn an ALLOW into a rejection");
  assert.equal(invalid.unavailable, false);
  assert.equal(invalid.policyDisposition, "ACCEPT");
  assert.deepEqual(invalid.citedMemory, []);

  const weakCalls: Call[] = [];
  const weak = await gateSignal(fakeRoles(weakCalls, { verdict: "DENY", confidence: 0.9,
    reason: "S1 has 1 losing trade, market looks weak; RSI suggests danger", cited_memory: ["S1"], deny_basis: "MEMORY" }), scalpSignal, SCALP_DEFAULTS,
  { stance: "NEUTRAL", regime: "TRENDING_BEARISH", atrPct15m: 0.2, spreadOk: true }, store, root);
  assert.equal(weak.allow, true, "weak memory-only veto is ignored and candidate continues through deterministic risk");
  assert.equal(weak.unavailable, false);
  assert.equal(weak.policyDisposition, "IGNORE_UNSUPPORTED_MEMORY_VETO");
});

test("memory flag is re-read on later gate calls and only literal true enables it", async (t) => {
  const { root, store } = fixture(t);
  const calls: Call[] = [];
  const roles = fakeRoles(calls, { verdict: "ALLOW", confidence: 0.8 });
  const invoke = () => gateCandidate(root, roles, candidate, store, "TRENDING_BULLISH");
  await invoke();
  assert.equal(calls.at(-1)?.contextRef, "candidate_gate");
  writeFileSync(path.join(root, ".env"), "GATE_MEMORY_ENABLED=yes\n");
  await invoke();
  assert.equal(calls.at(-1)?.contextRef, "candidate_gate");
  writeFileSync(path.join(root, ".env"), "GATE_MEMORY_ENABLED=true\n");
  await invoke();
  assert.match(calls.at(-1)!.contextRef, /^candidate_gate:mem:/);
});

test("both gate output schemas remain strict and accept legacy responses without cited_memory", () => {
  assert.deepEqual(CandidateGateSchema.parse({ verdict: "ALLOW", confidence: 0.8 }), {
    verdict: "ALLOW", confidence: 0.8, reasoning: [], risk_flags: [], cited_memory: [],
  });
  assert.deepEqual(ScalpCandidateGateSchema.parse({ verdict: "DENY", confidence: 0.8, reason: "market" }), {
    verdict: "DENY", confidence: 0.8, reason: "market", cited_memory: [],
  });
  assert.equal(CandidateGateSchema.safeParse({ verdict: "ALLOW", confidence: 0.8, injected: true }).success, false);
  assert.equal(ScalpCandidateGateSchema.safeParse({ verdict: "ALLOW", confidence: 0.8, reason: "x", injected: true }).success, false);
});

test("enabled gate rejects fabricated market keywords as evidence and skips the current candidate", async (t) => {
  const { root, store } = fixture(t);
  writeFileSync(path.join(root, ".env"), "GATE_MEMORY_ENABLED=true\n");
  addHistory(store, 5);
  const calls: Call[] = [];
  const result = await gateCandidate(root, fakeRoles(calls, { verdict: "DENY", confidence: 0.9,
    reasoning: ["S1 has 30 losses but RSI suggests danger"], cited_memory: ["S1"], deny_basis: "MIXED",
    market_evidence_refs: ["fabricated_rsi_event"] }), candidate, store, "TRENDING_BULLISH");
  assert.ok(result);
  assert.equal(result.policyDisposition, "UNSUPPORTED_DENY");
  assert.equal(result.effectiveVerdict, "DENY");
  assert.equal(calls.length, 1);
});

test("weak memory-only Swing DENY is ignored and remains subject to deterministic risk evaluation", async (t) => {
  const { root, store } = fixture(t);
  writeFileSync(path.join(root, ".env"), "GATE_MEMORY_ENABLED=true\n");
  addHistory(store, 1);
  const calls: Call[] = [];
  const result = await gateCandidate(root, fakeRoles(calls, { verdict: "DENY", confidence: 0.9,
    reasoning: ["S1 has one losing trade; market is weak and trend may reverse"], cited_memory: ["S1"], deny_basis: "MEMORY" }),
  candidate, store, "TRENDING_BULLISH");
  assert.ok(result);
  assert.equal(result.verdict, "DENY", "raw model verdict remains auditable");
  assert.equal(result.effectiveVerdict, "ALLOW", "unsupported memory veto does not block the candidate before Risk");
  assert.equal(result.policyDisposition, "IGNORE_UNSUPPORTED_MEMORY_VETO");
  assert.equal(result.memorySampleCounts?.s1, 1);
  assert.equal(calls.length, 1, "the policy uses no repair or second model call");
});

test("market-only gate denial requires a true request-bound market evidence reference", async (t) => {
  const { root, store } = fixture(t);
  writeFileSync(path.join(root, ".env"), "GATE_MEMORY_ENABLED=true\n");
  const calls: Call[] = [];
  const denied = await gateCandidate(root, fakeRoles(calls, { verdict: "DENY", confidence: 0.8,
    reasoning: ["Trend conflict"], deny_basis: "MARKET", market_evidence_refs: ["regime_direction_conflict"] }),
  { ...candidate, side: "SHORT" }, store, "TRENDING_BULLISH");
  assert.equal(denied?.policyDisposition, "ACCEPT");
  assert.equal(denied?.effectiveVerdict, "DENY");
});

test("optional denial attribution remains backward-parseable but strict schemas reject unknown keys", () => {
  assert.equal(CandidateGateSchema.safeParse({ verdict: "DENY", confidence: 0.8, extra: true }).success, false);
  assert.equal(ScalpCandidateGateSchema.safeParse({ verdict: "DENY", confidence: 0.8, reason: "x", extra: true }).success, false);
});
