import assert from "node:assert/strict";
import { test } from "node:test";
import { getLlmConfigForRole, maskApiKey } from "../src/core/llm-roles.ts";
import { CandidateGateSchema } from "../src/agents/decision-agent.ts";
import { REPO_ROOT } from "../src/core/env.ts";

test("role defaults use the requested model map without requiring credentials", () => {
  const models = {
    gate: "deepseek-v4.1-flash", scalp: "qwen3.8-flash", reviewer: "glm-5.3",
    evolution: "deepseek-v4-pro:cloudflare", critic: "qwen3.7-plus",
  } as const;
  for (const [role, model] of Object.entries(models) as Array<[keyof typeof models, string]>) {
    const resolved = getLlmConfigForRole(role, { root: REPO_ROOT, env: {} });
    assert.equal(resolved.config.model, model);
    assert.equal(resolved.status, "UNCONFIGURED");
  }
});

test("role endpoint, key, and model overrides remain isolated", () => {
  const resolved = getLlmConfigForRole("gate", { root: REPO_ROOT, env: {
    LLM_GATE_BASE_URL: "https://gate.example/v1", LLM_GATE_API_KEY: "fake-gate-key", LLM_GATE_MODEL: "gate-model",
    LLM_REVIEWER_BASE_URL: "https://review.example/v1", LLM_REVIEWER_API_KEY: "fake-review-key", LLM_REVIEWER_MODEL: "review-model",
  } });
  const reviewer = getLlmConfigForRole("reviewer", { root: REPO_ROOT, env: {
    LLM_GATE_BASE_URL: "https://gate.example/v1", LLM_GATE_API_KEY: "fake-gate-key", LLM_GATE_MODEL: "gate-model",
    LLM_REVIEWER_BASE_URL: "https://review.example/v1", LLM_REVIEWER_API_KEY: "fake-review-key", LLM_REVIEWER_MODEL: "review-model",
  } });
  assert.equal(resolved.config.baseUrl, "https://gate.example/v1");
  assert.equal(resolved.config.apiKey, "fake-gate-key");
  assert.equal(resolved.config.model, "gate-model");
  assert.equal(reviewer.config.baseUrl, "https://review.example/v1");
  assert.equal(reviewer.config.apiKey, "fake-review-key");
  assert.equal(reviewer.config.model, "review-model");
  assert.equal(resolved.status, "AVAILABLE");
});

test("role-specific values override YAML and generic legacy settings are isolated to Gate", () => {
  const specific = getLlmConfigForRole("gate", { root: REPO_ROOT, env: {
    LLM_GATE_MODEL: "gate-override", LLM_MODEL: "legacy-model", LLM_BASE_URL: "https://legacy.example/v1", LLM_API_KEY: "legacy-key",
  } });
  assert.equal(specific.config.model, "gate-override");
  assert.equal(specific.config.baseUrl, "https://legacy.example/v1");
  assert.equal(specific.config.apiKey, "legacy-key");

  const legacy = getLlmConfigForRole("gate", { root: REPO_ROOT, env: {
    LLM_MODEL: "legacy-model", LLM_BASE_URL: "https://legacy.example/v1", LLM_API_KEY: "legacy-key",
  } });
  assert.equal(legacy.config.model, "legacy-model");
  assert.equal(legacy.config.baseUrl, "https://legacy.example/v1");
  assert.equal(legacy.config.apiKey, "legacy-key");

  const reviewer = getLlmConfigForRole("reviewer", { root: REPO_ROOT, env: {
    LLM_MODEL: "legacy-model", LLM_BASE_URL: "https://legacy.example/v1", LLM_API_KEY: "legacy-key",
  } });
  assert.equal(reviewer.config.model, "glm-5.3");
  assert.equal(reviewer.config.baseUrl, "");
  assert.equal(reviewer.config.apiKey, "");
  assert.equal(reviewer.status, "UNCONFIGURED");
});

test("invalid configuration disables only the affected role", () => {
  const defaults = {
    llm: { roles: {
      gate: { enabled: true, model: "gate", temperature: 0, timeout_ms: 500, max_output_tokens: 1, retries: 0 },
      critic: { enabled: true, model: "critic", temperature: 3, timeout_ms: 500, max_output_tokens: 1, retries: 0 },
    } },
  };
  assert.equal(getLlmConfigForRole("gate", { root: REPO_ROOT, env: {}, defaults }).status, "UNCONFIGURED");
  const critic = getLlmConfigForRole("critic", { root: REPO_ROOT, env: {}, defaults });
  assert.equal(critic.status, "ERROR");
  assert.equal(critic.config.apiKey, "");
});

test("API key masking reveals only the final four characters", () => {
  const masked = maskApiKey("fake-secret-1234");
  assert.equal(masked, "••••1234");
  assert.equal(masked.includes("fake-secret"), false);
});

test("Gate output is strict ALLOW/DENY and rejects direction or geometry fields", () => {
  assert.equal(CandidateGateSchema.safeParse({ verdict: "ALLOW", confidence: 0.8, reasoning: [], risk_flags: [] }).success, true);
  assert.equal(CandidateGateSchema.safeParse({ verdict: "LONG", confidence: 0.8 }).success, false);
  assert.equal(CandidateGateSchema.safeParse({ verdict: "ALLOW", confidence: 0.8, side: "SHORT", stop: 1 }).success, false);
});
