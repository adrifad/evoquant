import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluateGateVetoPolicy, scalpVerifiedMarketEvidence, swingVerifiedMarketEvidence,
  type GateVetoPolicyInput } from "../src/agents/gate-veto-policy.ts";
import type { DecisionMemoryContext } from "../src/memory/decision-context.ts";
import type { TradeCandidate } from "../src/strategy/core-v2.ts";

function memory(s1Trades: number, s1Expectancy: number | null, s2Trades = s1Trades,
  s2Expectancy: number | null = s1Expectancy): DecisionMemoryContext {
  return { window_days: 30, stats: [
    { id: "S1", scope: "exact", trades: s1Trades, wins: 0, losses: s1Trades,
      win_rate: s1Trades ? 0 : null, expectancy_r: s1Expectancy },
    { id: "S2", scope: "same_symbol_strategy_direction", trades: s2Trades, wins: 0, losses: s2Trades,
      win_rate: s2Trades ? 0 : null, expectancy_r: s2Expectancy },
  ], lessons: [] };
}

function evaluate(overrides: Partial<GateVetoPolicyInput> = {}) {
  return evaluateGateVetoPolicy({ verdict: "DENY", denyBasis: "MEMORY", citedMemory: ["S1"],
    marketEvidenceRefs: [], memory: memory(2, -1), verifiedMarketEvidence: new Set(), ...overrides });
}

test("weak and exploratory S1 history cannot veto, regardless of market-sounding prose", () => {
  const prose = ["S1 has only 2 losing trades, but market looks weak.",
    "S1 negative expectancy; RSI suggests danger.", "Historical losses are concerning and trend may reverse."];
  for (const [index, n] of [1, 5, 20].entries()) {
    assert.equal(evaluate({ memory: memory(n, -0.8), reasoning: [prose[index]!] }).kind,
      "IGNORE_UNSUPPORTED_MEMORY_VETO");
  }
});

test("a cited S1 sample of at least 30 with negative NET expectancy may support a memory veto", () => {
  assert.deepEqual(evaluate({ memory: memory(30, -0.25), citedMemory: ["S1"] }), {
    kind: "ACCEPT", verdict: "DENY", basis: "MEMORY",
  });
});

test("win rate, neutral or positive expectancy, S2 size, and lessons cannot replace strong exact S1 evidence", () => {
  assert.equal(evaluate({ memory: memory(30, 0), citedMemory: ["S1"] }).kind, "IGNORE_UNSUPPORTED_MEMORY_VETO");
  assert.equal(evaluate({ memory: memory(30, 0.1), citedMemory: ["S1"] }).kind, "IGNORE_UNSUPPORTED_MEMORY_VETO");
  assert.equal(evaluate({ memory: memory(2, -0.5, 50, -0.8), citedMemory: ["S2"] }).kind,
    "IGNORE_UNSUPPORTED_MEMORY_VETO");
  const withLesson = memory(2, -0.5);
  withLesson.lessons.push({ id: "LESSON-1", status: "VERIFIED", n: 30, confidence: 1, statement: "lesson" });
  assert.equal(evaluate({ memory: withLesson, citedMemory: ["LESSON-1"] }).kind, "IGNORE_UNSUPPORTED_MEMORY_VETO");
});

test("unavailable or fabricated memory citations are policy rejections, not provider failures", () => {
  assert.equal(evaluate({ citedMemory: ["UNKNOWN"] }).kind, "MEMORY_CITATION_INVALID");
  assert.deepEqual(evaluate({ verdict: "ALLOW", citedMemory: ["UNKNOWN"] }), { kind: "ACCEPT", verdict: "ALLOW" });
});

test("market keywords never validate evidence, but a supplied verified reference does", () => {
  assert.equal(evaluate({ denyBasis: "MARKET", citedMemory: [], marketEvidenceRefs: ["rsi_extreme"],
    verifiedMarketEvidence: new Set() }).kind, "UNSUPPORTED_DENY");
  assert.deepEqual(evaluate({ denyBasis: "MARKET", citedMemory: [], marketEvidenceRefs: ["regime_direction_conflict"],
    verifiedMarketEvidence: new Set(["regime_direction_conflict"]) }), {
    kind: "ACCEPT", verdict: "DENY", basis: "MARKET",
  });
});

test("weak memory plus a genuinely verified independent market concern may deny", () => {
  assert.equal(evaluate({ denyBasis: "MIXED", memory: memory(5, -0.5), marketEvidenceRefs: ["high_volatility_regime"],
    verifiedMarketEvidence: new Set(["high_volatility_regime"]) }).kind, "ACCEPT");
});

test("verified market facts remain valid regardless of the model's claimed denial basis", () => {
  assert.deepEqual(evaluate({ denyBasis: "MEMORY", memory: memory(2, -0.5), citedMemory: ["S1"],
    marketEvidenceRefs: ["high_volatility_regime"], verifiedMarketEvidence: new Set(["high_volatility_regime"]) }), {
    kind: "ACCEPT", verdict: "DENY", basis: "MARKET",
  });
});

test("counter-trend Swing market evidence is strategy-aware; Scalp direction remains explicitly aligned", () => {
  const candidate = { strategy: "MEAN_REVERSION_V2", side: "SHORT", regime: { trend: "BULL_TREND", volatility: "NORMAL" },
    features: { sufficientData: true }, conditions: [] } as unknown as TradeCandidate;
  assert.equal(swingVerifiedMarketEvidence(candidate, "TRENDING_BULLISH").has("regime_direction_conflict"), false);
  assert.equal(swingVerifiedMarketEvidence({ ...candidate, strategy: "TREND_FOLLOWING_V2" } as TradeCandidate,
    "TRENDING_BULLISH").has("regime_direction_conflict"), true);
  assert.equal(scalpVerifiedMarketEvidence({ side: "SHORT", regime: "TRENDING_BULLISH", atrPct15m: 0.2 })
    .has("regime_direction_conflict"), true);
});

test("ambiguous denial skips the candidate rather than authorizing it", () => {
  assert.equal(evaluateGateVetoPolicy({ verdict: "DENY", citedMemory: [], marketEvidenceRefs: [], memory: memory(0, null),
    verifiedMarketEvidence: new Set() }).kind, "UNSUPPORTED_DENY");
  assert.equal(evaluate({ denyBasis: "MIXED", marketEvidenceRefs: ["fabricated"], verifiedMarketEvidence: new Set() }).kind,
    "UNSUPPORTED_DENY");
});
