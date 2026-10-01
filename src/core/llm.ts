// M3 — LLM client (OpenAI-compatible; kiosapi). Structured JSON output with
// zod validation; ANY invalid output → null (caller applies safe fallback:
// HOLD for decisions, skip for reviews). Transient gateway failures (HTML
// challenge pages, 5xx, aborts) get ONE retry; still fail-closed (§21).

import { z } from "zod";

export interface LlmConfig {
  baseUrl: string;
  apiKey: string; // bearer token, never logged (§51)
  model: string;
  timeoutMs?: number;
  temperature?: number;
}

type Attempt<T> = { ok: true; value: T | null } | { ok: false; retry: true };

async function attempt<T>(
  cfg: LlmConfig, system: string, user: string, schema: z.ZodType<T>, fetchImpl: typeof fetch,
): Promise<Attempt<T>> {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), cfg.timeoutMs ?? 90_000);
  try {
    const res = await fetchImpl(`${cfg.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify({
        model: cfg.model,
        temperature: cfg.temperature ?? 0.2,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        response_format: { type: "json_object" },
      }),
      signal: controller.signal,
    });
    const raw = await res.text();
    if (!res.ok) {
      console.error(`[llm] http ${res.status} ${raw.slice(0, 160)}`);
      return { ok: false, retry: true };
    }
    let json: { choices?: Array<{ message?: { content?: string } }> };
    try {
      json = JSON.parse(raw) as typeof json;
    } catch {
      // gateways (Cloudflare challenge) can answer HTTP 200 with HTML — retry
      console.error(`[llm] non-JSON body: ${raw.slice(0, 120)}`);
      return { ok: false, retry: true };
    }
    const text = json?.choices?.[0]?.message?.content ?? "";
    if (!text) return { ok: false, retry: true };
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start < 0 || end <= start) {
      console.error(`[llm] no-json in content (${text.length} chars): ${text.slice(0, 160)}`);
      return { ok: true, value: null };
    }
    const parsed: unknown = JSON.parse(text.slice(start, end + 1));
    const v = schema.safeParse(parsed);
    if (!v.success) {
      console.error(`[llm] schema fail: ${JSON.stringify(v.error.issues.slice(0, 3))}`);
      return { ok: true, value: null };
    }
    return { ok: true, value: v.data };
  } catch (e) {
    console.error(`[llm] error: ${e instanceof Error ? `${e.name} ${e.message}`.slice(0, 200) : String(e)}`);
    return { ok: false, retry: true };
  } finally {
    clearTimeout(t);
  }
}

export async function llmJson<T>(
  cfg: LlmConfig, system: string, user: string, schema: z.ZodType<T>, fetchImpl: typeof fetch = fetch,
): Promise<T | null> {
  const first = await attempt(cfg, system, user, schema, fetchImpl);
  if (first.ok) return first.value;
  await new Promise((r) => setTimeout(r, 3_000));
  const second = await attempt(cfg, system, user, schema, fetchImpl);
  return second.ok ? second.value : null;
}
