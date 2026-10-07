import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { z } from "zod";
import { RoleLlmService, roleEnvironmentUpdates } from "../src/core/llm-role-service.ts";
import { openStore } from "../src/memory/db.ts";
import { REPO_ROOT } from "../src/core/env.ts";
import { fetchStance } from "../src/agents/scalp-agent.ts";

const OkSchema = z.object({ ok: z.boolean() });

function fixture(env: Record<string, string | undefined>, fetchImpl: typeof fetch, now = Date.parse("2026-10-07T00:00:00.000Z")) {
  const root = mkdtempSync(path.join(os.tmpdir(), "evoquant-llm-role-"));
  mkdirSync(path.join(root, "config"), { recursive: true });
  copyFileSync(path.join(REPO_ROOT, "config/llm-roles.yaml"), path.join(root, "config/llm-roles.yaml"));
  const store = openStore(root);
  const service = new RoleLlmService({ root, store, env, fetchImpl, now: () => now, sleep: async () => undefined });
  return { root, store, service, close: () => { store.close(); rmSync(root, { recursive: true, force: true }); } };
}

function successResponse(): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }], usage: { prompt_tokens: 5, completion_tokens: 2 } }), { status: 200 });
}

test("mock multi-provider requests use only each assigned role URL, key, and model", async () => {
  const requests: Array<{ url: string; key: string; model: string }> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const headers = new Headers(init?.headers);
    const body = JSON.parse(String(init?.body)) as { model: string };
    requests.push({ url: String(input), key: headers.get("authorization") ?? "", model: body.model });
    return successResponse();
  };
  const f = fixture({
    LLM_GATE_BASE_URL: "https://gate.provider.test/v1", LLM_GATE_API_KEY: "fake-gate-A", LLM_GATE_MODEL: "model-gate-A",
    LLM_SCALP_BASE_URL: "https://scalp.provider.test/v1", LLM_SCALP_API_KEY: "fake-scalp-D", LLM_SCALP_MODEL: "model-scalp-D",
    LLM_REVIEWER_BASE_URL: "https://review.provider.test/v1", LLM_REVIEWER_API_KEY: "fake-review-B", LLM_REVIEWER_MODEL: "model-review-B",
    LLM_EVOLUTION_BASE_URL: "https://evolution.provider.test/v1", LLM_EVOLUTION_API_KEY: "fake-evolution-C", LLM_EVOLUTION_MODEL: "model-evolution-C",
    LLM_CRITIC_BASE_URL: "https://critic.provider.test/v1", LLM_CRITIC_API_KEY: "fake-critic-E", LLM_CRITIC_MODEL: "model-critic-E",
  }, fetchImpl);
  try {
    assert.deepEqual(f.service.settings().find((entry) => entry.role === "gate")?.budget, { maxCallsPerHour: 30 });
    for (const role of ["gate", "scalp", "reviewer", "evolution", "critic"] as const) assert.deepEqual(await f.service.json(role, "system", "{}", OkSchema, "test"), { ok: true },
      JSON.stringify(f.store.db.prepare("SELECT role,status,error_class FROM llm_runs").all()));
    assert.deepEqual(requests, [
      { url: "https://gate.provider.test/v1/chat/completions", key: "Bearer fake-gate-A", model: "model-gate-A" },
      { url: "https://scalp.provider.test/v1/chat/completions", key: "Bearer fake-scalp-D", model: "model-scalp-D" },
      { url: "https://review.provider.test/v1/chat/completions", key: "Bearer fake-review-B", model: "model-review-B" },
      { url: "https://evolution.provider.test/v1/chat/completions", key: "Bearer fake-evolution-C", model: "model-evolution-C" },
      { url: "https://critic.provider.test/v1/chat/completions", key: "Bearer fake-critic-E", model: "model-critic-E" },
    ]);
    const safe = JSON.stringify(f.service.settings());
    assert.equal(safe.includes("fake-gate-A"), false);
    assert.equal(safe.includes("fake-scalp-D"), false);
    assert.equal(safe.includes("fake-review-B"), false);
    assert.equal(safe.includes("fake-evolution-C"), false);
    assert.equal(safe.includes("fake-critic-E"), false);
    assert.equal(safe.includes("apiKey\""), false);
    assert.equal((f.store.db.prepare("SELECT COUNT(*) count FROM llm_runs WHERE role='gate' AND status='SUCCESS'").get() as { count: number }).count, 1);
  } finally { f.close(); }
});

test("role budgets fail closed and health remains isolated", async () => {
  let requests = 0;
  const f = fixture({
    LLM_GATE_BASE_URL: "https://gate.test/v1", LLM_GATE_API_KEY: "fake-gate", LLM_GATE_MAX_CALLS_PER_HOUR: "1",
    LLM_REVIEWER_BASE_URL: "https://review.test/v1", LLM_REVIEWER_API_KEY: "fake-review",
  }, async () => { requests++; return successResponse(); });
  try {
    assert.deepEqual(await f.service.json("gate", "s", "u", OkSchema, "first"), { ok: true });
    assert.equal(await f.service.json("gate", "s", "u", OkSchema, "second"), null);
    assert.deepEqual(await f.service.json("reviewer", "s", "u", OkSchema, "review"), { ok: true });
    assert.equal(requests, 2);
    const roles = Object.fromEntries(f.service.settings().map((entry) => [entry.role, entry]));
    assert.equal(roles.gate?.status, "BUDGET_EXHAUSTED");
    assert.equal(roles.gate?.callsThisHour, 1);
    assert.equal(roles.reviewer?.status, "AVAILABLE");
    assert.equal(roles.reviewer?.callsThisHour, 1);
    assert.equal((f.store.db.prepare("SELECT COUNT(*) count FROM system_events WHERE kind='LLM_BUDGET_EXHAUSTED' AND json_extract(payload,'$.role')='gate'").get() as { count: number }).count, 1);
  } finally { f.close(); }
});

test("test connection uses only its role and failures never persist provider bodies", async () => {
  const seen: string[] = [];
  const f = fixture({
    LLM_GATE_BASE_URL: "https://gate-only.test/v1", LLM_GATE_API_KEY: "fake-gate-secret", LLM_GATE_MODEL: "gate-model",
    LLM_REVIEWER_BASE_URL: "https://review-only.test/v1", LLM_REVIEWER_API_KEY: "fake-review-secret", LLM_REVIEWER_MODEL: "review-model",
  }, async (input) => {
    seen.push(String(input));
    return new Response("fake-gate-secret provider detail", { status: 401 });
  });
  try {
    const result = await f.service.testConnection("gate", { baseUrl: "https://gate-draft.test/v1", model: "gate-draft-model" });
    assert.deepEqual(result, { success: false, role: "gate", error: "AUTHENTICATION_FAILED" });
    assert.deepEqual(seen, ["https://gate-draft.test/v1/chat/completions"]);
    const persisted = JSON.stringify({ events: f.store.db.prepare("SELECT payload FROM system_events").all(), runs: f.store.db.prepare("SELECT * FROM llm_runs").all() });
    assert.equal(persisted.includes("fake-gate-secret"), false);
    assert.equal(persisted.includes("provider detail"), false);
    const settings = JSON.stringify(f.service.settings());
    assert.equal(settings.includes("fake-gate-secret"), false);
    assert.equal(settings.includes("fake-review-secret"), false);
    assert.equal((f.store.db.prepare("SELECT COUNT(*) count FROM llm_runs WHERE role='reviewer'").get() as { count: number }).count, 0);
  } finally { f.close(); }
});

test("provider output cannot echo a role API key into returned data or audit storage", async () => {
  const secret = "fake-output-echo-secret";
  const f = fixture({ LLM_GATE_BASE_URL: "https://gate.test/v1", LLM_GATE_API_KEY: secret }, async () =>
    new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ note: secret }) } }] }), { status: 200 }));
  try {
    const result = await f.service.json("gate", "system", "{}", z.object({ note: z.string() }), "echo_test");
    assert.deepEqual(result, { note: "[REDACTED]" });
    const persisted = JSON.stringify({ events: f.store.db.prepare("SELECT payload FROM system_events").all(), runs: f.store.db.prepare("SELECT * FROM llm_runs").all() });
    assert.equal(persisted.includes(secret), false);
  } finally { f.close(); }
});

test("Scalp role outage returns DEFENSIVE and does not make a network request", async () => {
  let requests = 0;
  const f = fixture({}, async () => { requests++; return successResponse(); });
  try {
    const result = await fetchStance(f.service, { regimes: {}, atrPcts: {}, sessionPnlR: 0, tradesToday: 0 });
    assert.equal(result.stance, "DEFENSIVE");
    assert.equal(requests, 0);
  } finally { f.close(); }
});

test("blank key updates preserve secrets and explicit clear overrides the role key", () => {
  const f = fixture({ LLM_GATE_BASE_URL: "https://gate.test/v1", LLM_GATE_API_KEY: "fake-existing-key" }, async () => successResponse());
  try {
    const blank = f.service.validateUpdate("gate", { model: "new-model", apiKey: "" });
    assert.equal("apiKey" in blank, true);
    assert.deepEqual(roleEnvironmentUpdates("gate", blank), { LLM_GATE_MODEL: "new-model" });
    f.service.updateRuntime("gate", blank);
    assert.equal(f.service.settings().find((entry) => entry.role === "gate")?.apiKeyConfigured, true);
    f.service.clearApiKey("gate");
    const gate = f.service.settings().find((entry) => entry.role === "gate");
    assert.equal(gate?.apiKeyConfigured, false);
    assert.equal(gate?.status, "UNCONFIGURED");
  } finally { f.close(); }
});

test("llm run ledger migration exists and contains no secret column", () => {
  const f = fixture({}, async () => successResponse());
  try {
    const columns = (f.store.db.prepare("PRAGMA table_info(llm_runs)").all() as Array<{ name: string }>).map((column) => column.name);
    assert.deepEqual(columns, ["id", "ts", "role", "provider", "model", "status", "latency_ms", "input_tokens", "output_tokens", "error_class", "context_ref"]);
  } finally { f.close(); }
});
