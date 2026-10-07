// OpenAI-compatible structured-output transport. Provider bodies and error
// messages are deliberately never logged or returned to callers.
import { z } from "zod";

export interface LlmConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs?: number;
  temperature?: number;
  maxOutputTokens?: number;
  retryCount?: number;
}

export type LlmErrorClass = "TIMEOUT" | "RATE_LIMIT" | "AUTHENTICATION_FAILED" | "PROVIDER_ERROR" | "HTTP_ERROR" | "INVALID_RESPONSE" | "NETWORK_ERROR";
export type LlmTransportStatus = "SUCCESS" | LlmErrorClass;
export interface LlmTransportResult<T> {
  value: T | null;
  status: LlmTransportStatus;
  attempts: number;
  latencyMs: number;
  inputTokens?: number;
  outputTokens?: number;
}

interface ParsedCompletion {
  text: string;
  inputTokens?: number;
  outputTokens?: number;
}

export async function llmJsonDetailed<T>(
  cfg: LlmConfig,
  system: string,
  user: string,
  schema: z.ZodType<T>,
  fetchImpl: typeof fetch = fetch,
  sleep: (ms: number) => Promise<void> = delay,
): Promise<LlmTransportResult<T>> {
  const started = Date.now();
  const retries = Math.max(0, Math.min(3, Math.trunc(cfg.retryCount ?? 1)));
  let lastStatus: LlmTransportStatus = "NETWORK_ERROR";
  let inputTokens: number | undefined;
  let outputTokens: number | undefined;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), cfg.timeoutMs ?? 90_000);
    try {
      const response = await fetchImpl(`${cfg.baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.apiKey}` },
        body: JSON.stringify({
          model: cfg.model,
          temperature: cfg.temperature ?? 0.2,
          max_tokens: cfg.maxOutputTokens ?? 900,
          messages: [{ role: "system", content: system }, { role: "user", content: user }],
          response_format: { type: "json_object" },
        }),
        signal: controller.signal,
      });
      const raw = await response.text();
      if (!response.ok) {
        lastStatus = classifyHttpStatus(response.status);
        if (isRetryable(lastStatus) && attempt < retries) {
          await sleep(backoffMs(attempt));
          continue;
        }
        return { value: null, status: lastStatus, attempts: attempt + 1, latencyMs: Date.now() - started };
      }
      let parsed: ParsedCompletion;
      try {
        const data = JSON.parse(raw) as {
          choices?: Array<{ message?: { content?: unknown } }>;
          usage?: { prompt_tokens?: unknown; completion_tokens?: unknown };
        };
        const text = data.choices?.[0]?.message?.content;
        if (typeof text !== "string" || !text) throw new Error("invalid completion");
        const usage = data.usage;
        const tokens = (value: unknown): number | undefined => typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
        const promptTokens = tokens(usage?.prompt_tokens);
        const completionTokens = tokens(usage?.completion_tokens);
        parsed = { text, ...(promptTokens !== undefined ? { inputTokens: promptTokens } : {}),
          ...(completionTokens !== undefined ? { outputTokens: completionTokens } : {}) };
      } catch {
        lastStatus = "INVALID_RESPONSE";
        return { value: null, status: lastStatus, attempts: attempt + 1, latencyMs: Date.now() - started };
      }
      inputTokens = parsed.inputTokens;
      outputTokens = parsed.outputTokens;
      // Providers should never need to echo the authorization credential, but
      // scrub it before any structured model output can reach persisted domain
      // records or system-event payloads.
      const safeText = cfg.apiKey ? parsed.text.replaceAll(cfg.apiKey, "[REDACTED]") : parsed.text;
      const start = safeText.indexOf("{");
      const end = safeText.lastIndexOf("}");
      if (start < 0 || end <= start) return { value: null, status: "INVALID_RESPONSE", attempts: attempt + 1,
        latencyMs: Date.now() - started, ...(inputTokens !== undefined ? { inputTokens } : {}), ...(outputTokens !== undefined ? { outputTokens } : {}) };
      try {
        const result = schema.safeParse(JSON.parse(safeText.slice(start, end + 1)) as unknown);
        if (!result.success) return { value: null, status: "INVALID_RESPONSE", attempts: attempt + 1,
          latencyMs: Date.now() - started, ...(inputTokens !== undefined ? { inputTokens } : {}), ...(outputTokens !== undefined ? { outputTokens } : {}) };
        return { value: result.data, status: "SUCCESS", attempts: attempt + 1, latencyMs: Date.now() - started,
          ...(inputTokens !== undefined ? { inputTokens } : {}), ...(outputTokens !== undefined ? { outputTokens } : {}) };
      } catch {
        return { value: null, status: "INVALID_RESPONSE", attempts: attempt + 1, latencyMs: Date.now() - started,
          ...(inputTokens !== undefined ? { inputTokens } : {}), ...(outputTokens !== undefined ? { outputTokens } : {}) };
      }
    } catch (error) {
      lastStatus = error instanceof Error && error.name === "AbortError" ? "TIMEOUT" : "NETWORK_ERROR";
      if (attempt < retries) {
        await sleep(backoffMs(attempt));
        continue;
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  return { value: null, status: lastStatus, attempts: retries + 1, latencyMs: Date.now() - started,
    ...(inputTokens !== undefined ? { inputTokens } : {}), ...(outputTokens !== undefined ? { outputTokens } : {}) };
}

export async function llmJson<T>(
  cfg: LlmConfig,
  system: string,
  user: string,
  schema: z.ZodType<T>,
  fetchImpl: typeof fetch = fetch,
): Promise<T | null> {
  return (await llmJsonDetailed(cfg, system, user, schema, fetchImpl)).value;
}

function classifyHttpStatus(status: number): LlmTransportStatus {
  if (status === 401 || status === 403) return "AUTHENTICATION_FAILED";
  if (status === 429) return "RATE_LIMIT";
  if (status >= 500) return "PROVIDER_ERROR";
  return "HTTP_ERROR";
}

function isRetryable(status: LlmTransportStatus): boolean {
  return status === "RATE_LIMIT" || status === "PROVIDER_ERROR";
}

function backoffMs(attempt: number): number {
  return Math.min(1_000, 250 * 2 ** attempt);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
