import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { maybeEvolveV2Strategies } from "../src/agents/v2-evolution.ts";
import { RoleLlmService } from "../src/core/llm-role-service.ts";
import { REPO_ROOT } from "../src/core/env.ts";
import { openStore } from "../src/memory/db.ts";
import { closeTrade, openTrade } from "../src/memory/trades.ts";
import { ensureV2Registry, getV2Champions, listV2Versions } from "../src/strategy/v2-registry.ts";
import { identityForV2 } from "../src/strategy/identity.ts";

type Scenario = "accept" | "reject" | "revise" | "invalid" | "unavailable";

function setup(scenario: Scenario) {
  const root = mkdtempSync(path.join(os.tmpdir(), "evoquant-critic-"));
  mkdirSync(path.join(root, "config"), { recursive: true });
  mkdirSync(path.join(root, "prompts"), { recursive: true });
  copyFileSync(path.join(REPO_ROOT, "config/llm-roles.yaml"), path.join(root, "config/llm-roles.yaml"));
  for (const prompt of ["evolution-v2.md", "critic-v2.md"]) copyFileSync(path.join(REPO_ROOT, "prompts", prompt), path.join(root, "prompts", prompt));
  const store = openStore(root);
  ensureV2Registry(store);
  for (let index = 0; index < 20; index++) {
    const tradeId = `CRITIC-EVIDENCE-${index}`;
    const entry = new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString();
    const identity = identityForV2("TREND_FOLLOWING_V2", 2);
    openTrade(store, { tradeId, instrument: "BTC-USDT-SWAP", timeframe: "15m", side: "LONG", strategy: "TREND_FOLLOWING_V2",
      strategyVersion: 2, identity, regime: "BULL_TREND", contracts: "1", entryPx: 100, entryTs: entry, stopPx: 98,
      takeProfitPx: 105, clOpenId: `critic-${index}`, ordOpenId: `order-${index}`, rawConfidence: 0.7,
      calibratedConfidence: 0.7, plannedRiskPct: 0.5, leverage: 2, maxHoldBars: 20,
      entryFeatures: { ts: Date.parse(entry), instrument: "BTC-USDT-SWAP", price: 100, ema20: 99, ema50: 98,
        emaSpreadPct: 1, rsi14: 55, adx14: 30, atr14: 2, atrPct: 2, volume: 100, volumeSma20: 90,
        volumeRatio: 1.1, sufficientData: true } });
    closeTrade(store, tradeId, { exitPx: 102, exitTs: new Date(Date.parse(entry) + 60_000).toISOString(), exitReason: "TP",
      fees: 0.1, funding: 0, pnl: 1, pnlPct: 1, resultR: 0.9, mfe: 2, mae: 0.2, durationS: 60 });
  }
  const proposal = (newValue = 1.1, changedParameter = "max_extension_atr") => ({ proposals: [{
    strategy: "TREND_FOLLOWING_V2", parent_version: 2, changed_parameter: changedParameter, old_value: 1.2, new_value: newValue,
    hypothesis: "Reduce late continuation entries where extended setups showed weaker after-cost results.",
  }] });
  const proposalQueue = [proposal()];
  if (scenario === "revise") proposalQueue.push(proposal(1.08));
  if (scenario === "invalid") proposalQueue[0] = proposal(1.1, "leverage");
  const criticQueue = scenario === "reject" ? [{ verdict: "REJECT", confidence: 0.91, issues: ["The effect is not consistent across symbols."], reasoning_summary: ["Evidence is not robust."] }]
    : scenario === "revise" ? [
      { verdict: "REVISE", confidence: 0.6, issues: ["Constrain the claim to the sampled regime."], reasoning_summary: ["The initial scope is too broad."] },
      { verdict: "ACCEPT", confidence: 0.82, issues: [], reasoning_summary: ["The revised scope matches the evidence."] },
    ] : [{ verdict: "ACCEPT", confidence: 0.84, issues: [], reasoning_summary: ["One bounded parameter is supported by the evidence."] }];
  const env = {
    LLM_EVOLUTION_BASE_URL: "https://evolution.test/v1", LLM_EVOLUTION_API_KEY: "fake-evolution", LLM_EVOLUTION_MODEL: "evolution-test-model",
    LLM_CRITIC_BASE_URL: "https://critic.test/v1", LLM_CRITIC_API_KEY: "fake-critic", LLM_CRITIC_MODEL: "critic-test-model",
  };
  const fetchImpl: typeof fetch = async (_input, init) => {
    const request = JSON.parse(String(init?.body)) as { model: string };
    if (scenario === "unavailable" && request.model === "critic-test-model") return new Response("untrusted secret-bearing error", { status: 503 });
    const next = request.model === "evolution-test-model" ? proposalQueue.shift()
      : request.model === "critic-test-model" ? criticQueue.shift() : undefined;
    if (!next) return new Response("unexpected request", { status: 503 });
    const content = JSON.stringify(request.model === "evolution-test-model" ? next : next);
    return new Response(JSON.stringify({ choices: [{ message: { content } }], usage: { prompt_tokens: 20, completion_tokens: 12 } }), { status: 200 });
  };
  const roles = new RoleLlmService({ root, store, env, fetchImpl, sleep: async () => undefined });
  return { root, store, roles, close: () => { store.close(); rmSync(root, { recursive: true, force: true }); } };
}

async function evolve(f: ReturnType<typeof setup>): Promise<number> {
  return maybeEvolveV2Strategies(f.root, f.roles, f.store, { intervalTrades: 15, minimumSample: 20, maxParamChanges: 1, maxParamDeltaPct: 10 });
}

for (const scenario of ["accept", "reject", "revise", "invalid", "unavailable"] as const) {
  test(`V2 Evolution + Critic ${scenario} stays bounded and deterministic`, async () => {
    const f = setup(scenario);
    try {
      const created = await evolve(f);
      const versions = listV2Versions(f.store, "TREND_FOLLOWING_V2");
      const challenger = versions.find((version) => version.status === "CHALLENGER");
      if (scenario === "accept") {
        assert.equal(created, 1);
        assert.equal(challenger?.version, 3);
        const audit = f.store.db.prepare("SELECT payload FROM system_events WHERE kind='CHALLENGER_CREATED'").get() as { payload: string };
        const payload = JSON.parse(audit.payload) as Record<string, unknown>;
        assert.equal(payload.criticVerdict, "ACCEPT");
        assert.equal(payload.evolutionModel, "evolution-test-model");
        assert.equal(payload.criticModel, "critic-test-model");
      } else if (scenario === "revise") {
        assert.equal(created, 1);
        assert.equal(challenger?.new_value, 1.08);
        const audit = JSON.parse((f.store.db.prepare("SELECT payload FROM system_events WHERE kind='CHALLENGER_CREATED'").get() as { payload: string }).payload) as Record<string, unknown>;
        assert.equal(audit.revisionRound, 1);
      } else {
        assert.equal(created, 0);
        assert.equal(challenger, undefined);
      }
      assert.equal(getV2Champions(f.store).TREND_FOLLOWING_V2.version, 2, "Critic cannot promote or mutate Champion");
      assert.equal((f.store.db.prepare("SELECT COUNT(*) count FROM llm_runs WHERE role='critic'").get() as { count: number }).count,
        scenario === "unavailable" ? 1 : scenario === "revise" ? 2 : 1);
      const persisted = JSON.stringify({ events: f.store.db.prepare("SELECT kind,payload FROM system_events").all(), runs: f.store.db.prepare("SELECT * FROM llm_runs").all() });
      assert.equal(persisted.includes("fake-critic"), false);
      assert.equal(persisted.includes("fake-evolution"), false);
      assert.equal(persisted.includes("untrusted secret-bearing error"), false);
      if (scenario === "reject") assert.equal((f.store.db.prepare("SELECT COUNT(*) count FROM system_events WHERE kind='EVOLUTION_PROPOSAL_REJECTED'").get() as { count: number }).count, 1);
      if (scenario === "invalid") assert.equal((f.store.db.prepare("SELECT COUNT(*) count FROM system_events WHERE kind='EVOLUTION_PROPOSAL_REJECTED'").get() as { count: number }).count, 1);
    } finally { f.close(); }
  });
}
