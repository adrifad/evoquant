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
