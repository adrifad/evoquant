import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import { llmJsonDetailed } from "../src/core/llm.ts";

const schema = z.object({ ok: z.boolean() });
const success = () => new Response(JSON.stringify({ choices: [{ message: { content: "{\"ok\":true}" } }],
  usage: { prompt_tokens: 4, completion_tokens: 2 } }), { status: 200 });

test("OpenAI-compatible transport retries a bounded rate limit and applies role request settings", async () => {
  let calls = 0;
  const waits: number[] = [];
  let requestBody: Record<string, unknown> = {};
  const result = await llmJsonDetailed({ baseUrl: "https://provider.test/v1", apiKey: "fake-transport-key", model: "role-model",
    temperature: 0.1, timeoutMs: 2_000, maxOutputTokens: 123, retryCount: 1 }, "system", "user", schema,
  async (_input, init) => {
    calls++;
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return calls === 1 ? new Response("not persisted", { status: 429 }) : success();
  }, async (ms) => { waits.push(ms); });

  assert.deepEqual(result, { value: { ok: true }, status: "SUCCESS", attempts: 2,
    latencyMs: result.latencyMs, inputTokens: 4, outputTokens: 2 });
  assert.equal(calls, 2);
  assert.deepEqual(waits, [250]);
  assert.equal(requestBody.model, "role-model");
  assert.equal(requestBody.temperature, 0.1);
  assert.equal(requestBody.max_tokens, 123);
});

test("OpenAI-compatible transport classifies a timeout without returning provider detail", async () => {
  const result = await llmJsonDetailed({ baseUrl: "https://provider.test/v1", apiKey: "fake-transport-key", model: "role-model",
    timeoutMs: 10, retryCount: 0 }, "system", "user", schema, async (_input, init) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => reject(new DOMException("secret-bearing detail", "AbortError")), { once: true });
  }));
  assert.equal(result.value, null);
  assert.equal(result.status, "TIMEOUT");
  assert.equal(result.attempts, 1);
});

test("truncated reasoning response stays fail closed and reports a safe output limit diagnostic", async () => {
  const result = await llmJsonDetailed({ baseUrl: "https://provider.test/v1", apiKey: "fake-transport-key", model: "reasoning-model", retryCount: 0 }, "system", "user", schema,
    async () => new Response(JSON.stringify({ choices: [{ finish_reason: "length", message: { content: "", reasoning_content: "private reasoning content" } }], usage: { prompt_tokens: 12, completion_tokens: 24 } })));
  assert.equal(result.status, "INVALID_RESPONSE");
  assert.equal(result.value, null);
  assert.equal(result.failureReason, "OUTPUT_LIMIT");
  assert.equal(result.inputTokens, 12);
  assert.equal(result.outputTokens, 24);
  assert.ok(!JSON.stringify(result).includes("private reasoning"));
});

test("invalid completion diagnostics distinguish empty, malformed, JSON and schema failures", async () => {
  const cases = [
    ["EMPTY_CONTENT", { choices: [{ message: { content: "", reasoning_content: "private" } }] }],
    ["MALFORMED_COMPLETION", { message: "fake-transport-key private error body" }],
    ["INVALID_JSON", { choices: [{ message: { content: "not JSON" } }] }],
    ["SCHEMA_MISMATCH", { choices: [{ message: { content: '{"ok":"yes"}' } }] }],
    ["OUTPUT_LIMIT", { choices: [{ finish_reason: "length", message: { content: '{"ok":true}' } }] }],
  ] as const;
  for (const [reason, body] of cases) {
    const result = await llmJsonDetailed({ baseUrl: "https://provider.test/v1", apiKey: "fake-transport-key", model: "model", retryCount: 0 }, "system", "user", schema,
      async () => new Response(JSON.stringify(body)));
    assert.equal(result.status, "INVALID_RESPONSE");
    assert.equal(result.failureReason, reason);
    assert.ok(!JSON.stringify(result).includes("private"));
    assert.ok(!JSON.stringify(result).includes("fake-transport-key"));
  }
});

test("transport accepts explicit final JSON in fences, explanatory text, and OpenAI-style text content arrays", async () => {
  const contents: unknown[] = [
    "```json\n{\"ok\":true}\n```",
    "Final answer follows. A non-JSON brace {is ignored}. {\"ok\":true} End.",
    [{ type: "text", text: "{\"ok\":true}" }],
    [{ type: "output_text", text: "```json\n{\"ok\":true}\n```" }],
  ];
  for (const content of contents) {
    const result = await llmJsonDetailed({ baseUrl: "https://provider.test/v1", apiKey: "fake-transport-key", model: "model", retryCount: 0 }, "system", "user", schema,
      async () => new Response(JSON.stringify({ choices: [{ message: { content } }] })));
    assert.equal(result.status, "SUCCESS");
    assert.deepEqual(result.value, { ok: true });
  }
});

test("transport never treats reasoning content as a final answer", async () => {
  const result = await llmJsonDetailed({ baseUrl: "https://provider.test/v1", apiKey: "fake-transport-key", model: "model", retryCount: 0 }, "system", "user", schema,
    async () => new Response(JSON.stringify({ choices: [{ message: { content: null, reasoning_content: '{"ok":true}' } }] })));
  assert.equal(result.status, "INVALID_RESPONSE");
  assert.equal(result.failureReason, "EMPTY_CONTENT");
  assert.equal(result.value, null);
});
