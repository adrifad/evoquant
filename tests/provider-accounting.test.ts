import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { z } from "zod";
import { RoleLlmService } from "../src/core/llm-role-service.ts";
import { openStore } from "../src/memory/db.ts";
import { REPO_ROOT } from "../src/core/env.ts";

const schema = z.object({ ok: z.boolean() });
function response(usage = true) {
  return new Response(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }],
    ...(usage ? { usage: { prompt_tokens: 5, completion_tokens: 2 } } : {}) }));
}
function fixture(fetchImpl: typeof fetch, limit = 20) {
  const root = mkdtempSync(path.join(os.tmpdir(), "evoq-accounting-"));
  mkdirSync(path.join(root, "config"));
  copyFileSync(path.join(REPO_ROOT, "config/llm-roles.yaml"), path.join(root, "config/llm-roles.yaml"));
  const store = openStore(root);
  let now = Date.parse("2026-10-07T12:00:00.000Z");
  const options = { root, store, fetchImpl, now: () => now, sleep: async () => undefined,
    env: { LLM_GATE_BASE_URL: "https://mock.test/v1", LLM_GATE_API_KEY: "fixture-secret",
      LLM_GATE_MAX_CALLS_PER_HOUR: String(limit), LLM_GATE_RETRIES: "3" } };
  return { root, store, options, service: new RoleLlmService(options), advance: (ms: number) => { now += ms; },
    close: () => { store.close(); rmSync(root, { recursive: true, force: true }); } };
}

test("retry exhaustion counts actual attempts and the logical call, then recovers after the window", async () => {
  let attempts = 0;
  const f = fixture(async () => { attempts++; return new Response("busy", { status: 429 }); }, 2);
  try {
    assert.equal(await f.service.json("gate", "s", "u", schema, "retry"), null);
    assert.equal(attempts, 2);
    const settings = f.service.settings()[0]!;
    assert.equal(settings.callsThisHour, 1);
    assert.equal(settings.providerRequestsThisHour, 2);
    assert.equal(settings.retriesToday, 1);
    assert.equal(settings.inputTokensToday, null);
    assert.equal(settings.status, "BUDGET_EXHAUSTED");
    assert.deepEqual(f.store.db.prepare("SELECT status,provider_requests FROM llm_runs").all(), [{ status: "BUDGET_EXHAUSTED", provider_requests: 2 }]);
    assert.equal((await f.service.testConnection("gate", {})).error, "BUDGET_EXHAUSTED");
    assert.equal(f.service.settings()[0]!.callsToday, 1, "denied calls do not increase provider call counts");
    f.advance(3_600_001);
    assert.equal(f.service.settings()[0]!.status, "AVAILABLE");
    assert.equal(f.service.settings()[0]!.errorClass, null);
    assert.equal(f.service.settings()[0]!.providerRequestsThisHour, 0);
  } finally { f.close(); }
});

test("concurrent services reserve a shared last slot before issuing HTTP", async () => {
  let requests = 0;
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const f = fixture(async () => { requests++; await pending; return response(); }, 1);
  const otherStore = openStore(f.root);
  try {
    const other = new RoleLlmService({ ...f.options, store: otherStore });
    const first = f.service.json("gate", "s", "u", schema, "first");
    assert.equal(await other.json("gate", "s", "u", schema, "concurrent"), null);
    assert.equal(requests, 1);
    release();
    assert.deepEqual(await first, { ok: true });
    assert.equal(other.settings()[0]!.providerRequestsThisHour, 1);
    assert.equal(other.settings()[0]!.callsThisHour, 1);
  } finally { release(); otherStore.close(); f.close(); }
});

test("legacy ledger migration preserves old budget charges and survives reopen", async () => {
  let requests = 0;
  const f = fixture(async () => { requests++; return response(); }, 1);
  try {
    f.store.db.exec("ALTER TABLE llm_runs DROP COLUMN provider_requests");
    f.store.db.prepare(`INSERT INTO llm_runs(ts,role,provider,model,status,latency_ms,context_ref)
      VALUES(?,'gate','legacy','legacy','SUCCESS',1,'legacy')`).run(new Date(f.options.now()).toISOString());
    new RoleLlmService(f.options);
    const reopened = openStore(f.root);
    try {
      const service = new RoleLlmService({ ...f.options, store: reopened });
      assert.equal(await service.json("gate", "s", "u", schema, "blocked"), null);
      assert.equal(requests, 0);
      assert.equal(service.settings()[0]!.callsThisHour, 1);
      assert.equal(service.settings()[0]!.providerRequestsThisHour, 0);
      assert.equal(service.settings()[0]!.legacyBudgetChargesThisHour, 1);
      assert.equal(service.settings()[0]!.budgetRequestsThisHour, 1);
    } finally { reopened.close(); }
  } finally { f.close(); }
});

test("token totals stay unknown after missing usage or retries instead of reporting a partial sum", async () => {
  let attempt = 0;
  const f = fixture(async () => { attempt++; return response(attempt === 1); });
  try {
    await f.service.json("gate", "s", "u", schema, "known");
    assert.equal(f.service.settings()[0]!.inputTokensToday, 5);
    await f.service.json("gate", "s", "u", schema, "unknown");
    assert.equal(f.service.settings()[0]!.inputTokensToday, null);
    assert.equal(f.service.settings()[0]!.outputTokensToday, null);
  } finally { f.close(); }
  let retries = 0;
  const retried = fixture(async () => ++retries === 1 ? new Response("busy", { status: 503 }) : response());
  try {
    assert.deepEqual(await retried.service.json("gate", "s", "u", schema, "retried"), { ok: true });
    assert.equal(retried.service.settings()[0]!.providerRequestsToday, 2);
    assert.equal(retried.service.settings()[0]!.callsToday, 1);
    assert.equal(retried.service.settings()[0]!.inputTokensToday, null);
  } finally { retried.close(); }
});

test("dispatched requests without a completed run keep token totals unknown, including after restart", async () => {
  const f = fixture(async () => response());
  try {
    await f.service.json("gate", "s", "u", schema, "completed");
    assert.equal(f.service.settings()[0]!.inputTokensToday, 5);
    // Simulate process interruption between durable dispatch and completion.
    f.store.db.prepare("INSERT INTO llm_provider_requests(ts,role,retry) VALUES(?,'gate',0)").run(new Date(f.options.now()).toISOString());
    const reopened = openStore(f.root);
    try {
      const service = new RoleLlmService({ ...f.options, store: reopened });
      assert.equal(service.settings()[0]!.providerRequestsToday, 2);
      assert.equal(service.settings()[0]!.callsToday, 1);
      assert.equal(service.settings()[0]!.inputTokensToday, null);
      assert.equal(service.settings()[0]!.outputTokensToday, null);
    } finally { reopened.close(); }
  } finally { f.close(); }
});
