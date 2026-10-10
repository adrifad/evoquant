// OpenAI-compatible structured-output transport. Provider bodies and error
// messages are deliberately never logged or returned to callers.
import { z } from "zod";

export type LlmTokenParameter = "max_tokens" | "max_completion_tokens";
export interface LlmCapabilities { supportsJsonObject: boolean; supportsTemperature: boolean; tokenParameter: LlmTokenParameter; }
export const DEFAULT_LLM_CAPABILITIES: LlmCapabilities = { supportsJsonObject: true, supportsTemperature: true, tokenParameter: "max_tokens" };
export interface LlmConfig {
  baseUrl: string; apiKey: string; model: string; timeoutMs?: number; temperature?: number; maxOutputTokens?: number; retryCount?: number;
  capabilities?: Partial<LlmCapabilities>; beforeRequest?: () => boolean; now?: () => number;
}
export type LlmErrorClass = "TIMEOUT" | "RATE_LIMIT" | "AUTHENTICATION_FAILED" | "PROVIDER_ERROR" | "HTTP_ERROR" | "INVALID_RESPONSE" | "NETWORK_ERROR" | "BUDGET_EXHAUSTED";
export type LlmTransportStatus = "SUCCESS" | LlmErrorClass;
export type LlmFailureReason = "OUTPUT_LIMIT" | "EMPTY_CONTENT" | "MALFORMED_COMPLETION" | "INVALID_JSON" | "SCHEMA_MISMATCH";
export interface LlmTransportResult<T> { value: T | null; status: LlmTransportStatus; attempts: number; latencyMs: number; inputTokens?: number; outputTokens?: number; failureReason?: LlmFailureReason; httpStatus?: number; }
interface ParsedCompletion { text: string; inputTokens?: number; outputTokens?: number; }
type CompletionMessage = { content?: unknown };

/** Builds a provider request only from explicit role-local compatibility settings. */
export function buildChatCompletionRequest(cfg: LlmConfig, system: string, user: string): Record<string, unknown> {
  const capabilities = { ...DEFAULT_LLM_CAPABILITIES, ...cfg.capabilities };
  const body: Record<string, unknown> = { model: cfg.model, messages: [{ role: "system", content: system }, { role: "user", content: user }], [capabilities.tokenParameter]: cfg.maxOutputTokens ?? 900 };
  if (capabilities.supportsTemperature) body.temperature = cfg.temperature ?? 0.2;
  if (capabilities.supportsJsonObject) body.response_format = { type: "json_object" };
  return body;
}
function finalContent(content: unknown): string | null {
  if (typeof content === "string") return content.trim() || null;
  if (!Array.isArray(content) || content.length === 0) return null;
  const fragments: string[] = [];
  for (const part of content) {
    if (!part || typeof part !== "object") return null;
    const typed = part as { type?: unknown; text?: unknown };
    if ((typed.type !== "text" && typed.type !== "output_text") || typeof typed.text !== "string") return null;
    fragments.push(typed.text);
  }
  return fragments.join("").trim() || null;
}
function jsonObjectCandidates(text: string): string[] {
  const candidates: string[] = [];
  for (let start = 0; start < text.length; start++) {
    if (text[start] !== "{") continue;
    let depth = 0, inString = false, escaped = false;
    for (let index = start; index < text.length; index++) {
      const char = text[index]!;
      if (inString) { if (escaped) escaped = false; else if (char === "\\") escaped = true; else if (char === '"') inString = false; continue; }
      if (char === '"') { inString = true; continue; }
      if (char === "{") depth++;
      else if (char === "}" && --depth === 0) { candidates.push(text.slice(start, index + 1)); break; }
    }
  }
  return candidates;
}
function parseStructuredOutput<T>(text: string, schema: z.ZodType<T>): { value?: T; failureReason?: LlmFailureReason } {
  const candidates = jsonObjectCandidates(text);
  if (!candidates.length) return { failureReason: "INVALID_JSON" };
  let parsedJson = false;
  for (const candidate of candidates) {
    try { const parsed: unknown = JSON.parse(candidate); parsedJson = true; const result = schema.safeParse(parsed); if (result.success) return { value: result.data }; } catch { /* continue */ }
  }
  return { failureReason: parsedJson ? "SCHEMA_MISMATCH" : "INVALID_JSON" };
}
const MAX_RETRY_AFTER_MS = 10_000;
function retryAfterMs(value: string | null, now: number): number | null {
  if (!value) return null;
  const seconds = Number(value.trim());
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(MAX_RETRY_AFTER_MS, Math.round(seconds * 1_000));
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.min(MAX_RETRY_AFTER_MS, Math.max(0, date - now)) : null;
}
function classifyHttpStatus(status: number): LlmTransportStatus { if (status === 401 || status === 403) return "AUTHENTICATION_FAILED"; if (status === 429) return "RATE_LIMIT"; if (status >= 500) return "PROVIDER_ERROR"; return "HTTP_ERROR"; }
function isRetryable(status: LlmTransportStatus): boolean { return status === "RATE_LIMIT" || status === "PROVIDER_ERROR" || status === "NETWORK_ERROR" || status === "TIMEOUT"; }
function backoffMs(attempt: number): number { return Math.min(1_000, 250 * 2 ** attempt); }
function delay(ms: number): Promise<void> { return new Promise(resolve => setTimeout(resolve, ms)); }

/** A configured timeout bounds the entire logical call, including waits and retries. */
export async function llmJsonDetailed<T>(cfg: LlmConfig, system: string, user: string, schema: z.ZodType<T>, fetchImpl: typeof fetch = fetch, sleep: (ms: number) => Promise<void> = delay): Promise<LlmTransportResult<T>> {
  const now = cfg.now ?? Date.now;
  const started = now(), deadline = started + Math.max(1, cfg.timeoutMs ?? 90_000), retries = Math.max(0, Math.min(3, Math.trunc(cfg.retryCount ?? 1)));
  let lastStatus: LlmTransportStatus = "NETWORK_ERROR", lastHttpStatus: number | undefined, inputTokens: number | undefined, outputTokens: number | undefined;
  const elapsed = () => Math.max(0, now() - started);
  const pending = (status: LlmTransportStatus, attempts: number): LlmTransportResult<T> => ({ value: null, status, attempts, latencyMs: elapsed(), ...(lastHttpStatus !== undefined ? { httpStatus: lastHttpStatus } : {}), ...(inputTokens !== undefined ? { inputTokens } : {}), ...(outputTokens !== undefined ? { outputTokens } : {}) });
  const invalid = (reason: LlmFailureReason, attempts: number): LlmTransportResult<T> => ({ ...pending("INVALID_RESPONSE", attempts), failureReason: reason });
  for (let attempt = 0; attempt <= retries; attempt++) {
    const remaining = deadline - now();
    if (remaining <= 0) return pending("TIMEOUT", attempt);
    if (cfg.beforeRequest && !cfg.beforeRequest()) return pending("BUDGET_EXHAUSTED", attempt);
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), remaining);
    try {
      const response = await fetchImpl(`${cfg.baseUrl.replace(/\/$/, "")}/chat/completions`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.apiKey}` }, body: JSON.stringify(buildChatCompletionRequest(cfg, system, user)), signal: controller.signal });
      const raw = await response.text();
      if (!response.ok) {
        lastStatus = classifyHttpStatus(response.status); lastHttpStatus = response.status;
        if (!isRetryable(lastStatus) || attempt >= retries) return pending(lastStatus, attempt + 1);
        const providerWait = lastStatus === "RATE_LIMIT" ? retryAfterMs(response.headers.get("retry-after"), now()) : null;
        const wait = Math.min(providerWait ?? backoffMs(attempt), Math.max(0, deadline - now()));
        if (wait <= 0) return pending("TIMEOUT", attempt + 1);
        await sleep(wait); continue;
      }
      try {
        const data = JSON.parse(raw) as { choices?: Array<{ finish_reason?: unknown; message?: CompletionMessage }>; usage?: { prompt_tokens?: unknown; completion_tokens?: unknown } };
        const tokens = (value: unknown): number | undefined => typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
        inputTokens = tokens(data.usage?.prompt_tokens); outputTokens = tokens(data.usage?.completion_tokens);
        const choice = data.choices?.[0];
        if (!choice?.message) return invalid("MALFORMED_COMPLETION", attempt + 1);
        if (choice.finish_reason === "length") return invalid("OUTPUT_LIMIT", attempt + 1);
        const text = finalContent(choice.message.content);
        if (text === null) return invalid(choice.message.content === null || choice.message.content === undefined || typeof choice.message.content === "string" ? "EMPTY_CONTENT" : "MALFORMED_COMPLETION", attempt + 1);
        const decoded = parseStructuredOutput(cfg.apiKey ? text.replaceAll(cfg.apiKey, "[REDACTED]") : text, schema);
        if (decoded.value === undefined) return invalid(decoded.failureReason ?? "INVALID_JSON", attempt + 1);
        return { value: decoded.value, status: "SUCCESS", attempts: attempt + 1, latencyMs: elapsed(), ...(inputTokens !== undefined ? { inputTokens } : {}), ...(outputTokens !== undefined ? { outputTokens } : {}) };
      } catch { return invalid("MALFORMED_COMPLETION", attempt + 1); }
    } catch (error) {
      lastStatus = error instanceof Error && error.name === "AbortError" ? "TIMEOUT" : "NETWORK_ERROR";
      if (!isRetryable(lastStatus) || attempt >= retries) return pending(lastStatus, attempt + 1);
      const wait = Math.min(backoffMs(attempt), Math.max(0, deadline - now()));
      if (wait <= 0) return pending("TIMEOUT", attempt + 1);
      await sleep(wait);
    } finally { clearTimeout(timer); }
  }
  return pending(lastStatus, retries + 1);
}
export async function llmJson<T>(cfg: LlmConfig, system: string, user: string, schema: z.ZodType<T>, fetchImpl: typeof fetch = fetch): Promise<T | null> { return (await llmJsonDetailed(cfg, system, user, schema, fetchImpl)).value; }
