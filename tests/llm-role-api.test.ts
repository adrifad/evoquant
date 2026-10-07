import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { RoleLlmService } from "../src/core/llm-role-service.ts";
import { REPO_ROOT } from "../src/core/env.ts";
import { startDashboard } from "../src/core/dashboard.ts";
import { openStore } from "../src/memory/db.ts";

test("role settings API isolates writes, preserves blank keys, masks secrets, tests one role, and explicitly clears keys", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "evoquant-role-api-"));
  mkdirSync(path.join(root, "config"), { recursive: true });
  copyFileSync(path.join(REPO_ROOT, "config/llm-roles.yaml"), path.join(root, "config/llm-roles.yaml"));
  const store = openStore(root);
  const settingsFile = path.join(root, ".env");
  const requests: string[] = [];
  const roles = new RoleLlmService({ root, store, env: {}, fetchImpl: async (input) => {
    requests.push(String(input));
    return new Response("fake-provider-response fake-gate-secret", { status: 401 });
  } });
  const dashboard = startDashboard({
    port: 0, settingsFile, llmRoles: roles,
    trading: { instrument: { id: "BTC-USDT-SWAP" }, timeframe: "15m", leverage: { default: 2 } },
    risk: { hard_limits: {} }, deps: () => ({ store, client: {} } as never),
    getLastTick: () => null, getKillReason: () => null, getScan: () => [],
    evolution: { reviewEvery: true, signalInterval: 8, strategyInterval: 15, minSample: 20, maxWeightChangePct: 5, maxParamChanges: 1 },
  });
  try {
    await new Promise((resolve) => setTimeout(resolve, 10));
    const address = dashboard.address(); assert.ok(address);
    const base = `http://127.0.0.1:${address.port}`;
    const initial = await fetch(`${base}/api/settings/llm-roles`).then((response) => response.json()) as { roles: Array<Record<string, unknown>> };
    assert.equal(initial.roles.length, 5);
    assert.equal(JSON.stringify(initial).includes("apiKey\":"), false);

    const save = await fetch(`${base}/api/settings/llm-roles/gate`, { method: "PUT", headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: true, provider: "GateProvider", baseUrl: "https://gate.test/v1", apiKey: "fake-gate-secret",
        model: "gate-model", temperature: 0.1, timeoutMs: 5000, maxOutputTokens: 100, retryCount: 0, budget: { maxCallsPerHour: 4 } }) });
    assert.equal(save.status, 200);
    const savedBody = await save.text();
    assert.equal(savedBody.includes("fake-gate-secret"), false);
    assert.match(readFileSync(settingsFile, "utf8"), /LLM_GATE_API_KEY=fake-gate-secret/);
    assert.equal(statSync(settingsFile).mode & 0o777, 0o600);
    assert.equal(readFileSync(settingsFile, "utf8").includes("LLM_REVIEWER_"), false);

    const blankSave = await fetch(`${base}/api/settings/llm-roles/gate`, { method: "PUT", headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "gate-model-v2", apiKey: "" }) });
    assert.equal(blankSave.status, 200);
    assert.match(readFileSync(settingsFile, "utf8"), /LLM_GATE_API_KEY=fake-gate-secret/);
    const current = await fetch(`${base}/api/settings/llm-roles`).then((response) => response.json()) as { roles: Array<Record<string, unknown>> };
    const gate = current.roles.find((role) => role.role === "gate");
    const reviewer = current.roles.find((role) => role.role === "reviewer");
    assert.equal(gate?.model, "gate-model-v2");
    assert.equal(gate?.apiKeyConfigured, true);
    assert.equal(String(gate?.apiKeyMasked).includes("fake-gate-secret"), false);
    assert.equal(reviewer?.model, "glm-5.3");
    assert.equal(reviewer?.apiKeyConfigured, false);

    const invalid = await fetch(`${base}/api/settings/llm-roles/evolution`, { method: "PUT", headers: { "content-type": "application/json" },
      body: JSON.stringify({ timeoutMs: 999_999 }) });
    assert.equal(invalid.status, 400);
    assert.equal(readFileSync(settingsFile, "utf8").includes("LLM_EVOLUTION_TIMEOUT_MS"), false);

    const unconfirmed = await fetch(`${base}/api/settings/llm-roles/gate/api-key`, { method: "DELETE" });
    assert.equal(unconfirmed.status, 400);
    const connection = await fetch(`${base}/api/settings/llm-roles/gate/test`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ baseUrl: "https://draft-gate.test/v1", model: "draft-gate-model" }) }).then((response) => response.json()) as Record<string, unknown>;
    assert.deepEqual(connection, { success: false, role: "gate", error: "AUTHENTICATION_FAILED" });
    assert.deepEqual(requests, ["https://draft-gate.test/v1/chat/completions"]);
    const afterTest = await fetch(`${base}/api/settings/llm-roles`).then((response) => response.json()) as { roles: Array<Record<string, unknown>> };
    assert.equal(afterTest.roles.find((role) => role.role === "reviewer")?.lastFailure, null);
    const dbContents = JSON.stringify(store.db.prepare("SELECT kind,payload FROM system_events").all());
    assert.equal(dbContents.includes("fake-gate-secret"), false);
    assert.equal(dbContents.includes("fake-provider-response"), false);

    const cleared = await fetch(`${base}/api/settings/llm-roles/gate/api-key?confirm=yes`, { method: "DELETE" });
    assert.equal(cleared.status, 200);
    assert.match(readFileSync(settingsFile, "utf8"), /LLM_GATE_API_KEY=$/m);
    const afterClear = await fetch(`${base}/api/settings/llm-roles`).then((response) => response.json()) as { roles: Array<Record<string, unknown>> };
    assert.equal(afterClear.roles.find((role) => role.role === "gate")?.apiKeyConfigured, false);
    assert.equal(existsSync(settingsFile), true);
  } finally {
    dashboard.close(); store.close(); rmSync(root, { recursive: true, force: true });
  }
});
