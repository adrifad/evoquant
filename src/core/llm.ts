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
  beforeRequest?: () => boolean;
}

export type LlmErrorClass = "TIMEOUT" | "RATE_LIMIT" | "AUTHENTICATION_FAILED" | "PROVIDER_ERROR" | "HTTP_ERROR" | "INVALID_RESPONSE" | "NETWORK_ERROR" | "BUDGET_EXHAUSTED";
export type LlmTransportStatus = "SUCCESS" | LlmErrorClass;
export type LlmFailureReason = "OUTPUT_LIMIT" | "EMPTY_CONTENT" | "MALFORMED_COMPLETION" | "INVALID_JSON" | "SCHEMA_MISMATCH";
export interface LlmTransportResult<T> {
  value: T | null;
  status: LlmTransportStatus;
  attempts: number;
  latencyMs: number;
  inputTokens?: number;
  outputTokens?: number;
  failureReason?: LlmFailureReason;
}

interface ParsedCompletion {
  text: string;
  inputTokens?: number;
  outputTokens?: number;
}

type CompletionMessage = { content?: unknown };

/**
 * Only explicit final `message.content` is trusted. Some OpenAI-compatible
 * services encode that final text as typed content parts; private reasoning is
 * deliberately absent from this normalizer and can never become an answer.
 */
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
  const joined = fragments.join("").trim();
  return joined || null;
}

/** Return balanced JSON object candidates without being confused by braces in strings or prose. */
function jsonObjectCandidates(text: string): string[] {
  const candidates: string[] = [];
  for (let start = 0; start < text.length; start++) {
    if (text[start] !== "{") continue;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < text.length; index++) {
      const char = text[index]!;
      if (inString) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === '"') inString = false;
        continue;
      }
      if (char === '"') { inString = true; continue; }
      if (char === "{") depth++;
      else if (char === "}" && --depth === 0) {
        candidates.push(text.slice(start, index + 1));
        break;
      }
    }
  }
  return candidates;
}

function parseStructuredOutput<T>(text: string, schema: z.ZodType<T>): { value?: T; failureReason?: LlmFailureReason } {
  const candidates = jsonObjectCandidates(text);
  if (!candidates.length) return { failureReason: "INVALID_JSON" };
  let parsedJson = false;
  for (const candidate of candidates) {
    try {
      const parsed: unknown = JSON.parse(candidate);
      parsedJson = true;
      const result = schema.safeParse(parsed);
      if (result.success) return { value: result.data };
    } catch { /* Continue after prose braces or malformed candidate JSON. */ }
  }
  return { failureReason: parsedJson ? "SCHEMA_MISMATCH" : "INVALID_JSON" };
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
  const invalid = (failureReason: LlmFailureReason, attempts: number): LlmTransportResult<T> => ({
    value: null, status: "INVALID_RESPONSE", failureReason, attempts, latencyMs: Date.now() - started,
    ...(inputTokens !== undefined ? { inputTokens } : {}), ...(outputTokens !== undefined ? { outputTokens } : {}),
  });

  for (let attempt = 0; attempt <= retries; attempt++) {
    if (cfg.beforeRequest && !cfg.beforeRequest()) return { value: null, status: "BUDGET_EXHAUSTED", attempts: attempt, latencyMs: Date.now() - started };
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
          choices?: Array<{ finish_reason?: unknown; message?: CompletionMessage }>;
          usage?: { prompt_tokens?: unknown; completion_tokens?: unknown };
        };
        const usage = data.usage;
        const tokens = (value: unknown): number | undefined => typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
        const promptTokens = tokens(usage?.prompt_tokens);
        const completionTokens = tokens(usage?.completion_tokens);
        inputTokens = promptTokens;
        outputTokens = completionTokens;
        const choice = data.choices?.[0];
        if (!choice?.message) return invalid("MALFORMED_COMPLETION", attempt + 1);
        if (choice.finish_reason === "length") return invalid("OUTPUT_LIMIT", attempt + 1);
        const text = finalContent(choice.message.content);
        if (text === null) return invalid(choice.message.content === null || choice.message.content === undefined || typeof choice.message.content === "string"
          ? "EMPTY_CONTENT" : "MALFORMED_COMPLETION", attempt + 1);
        parsed = { text, ...(promptTokens !== undefined ? { inputTokens: promptTokens } : {}),
          ...(completionTokens !== undefined ? { outputTokens: completionTokens } : {}) };
      } catch {
        return invalid("MALFORMED_COMPLETION", attempt + 1);
      }
      inputTokens = parsed.inputTokens;
      outputTokens = parsed.outputTokens;
      // Providers should never need to echo the authorization credential, but
      // scrub it before any structured model output can reach persisted domain
      // records or system-event payloads.
      const safeText = cfg.apiKey ? parsed.text.replaceAll(cfg.apiKey, "[REDACTED]") : parsed.text;
      const decoded = parseStructuredOutput(safeText, schema);
      if (decoded.value === undefined) return invalid(decoded.failureReason ?? "INVALID_JSON", attempt + 1);
      return { value: decoded.value, status: "SUCCESS", attempts: attempt + 1, latencyMs: Date.now() - started,
        ...(inputTokens !== undefined ? { inputTokens } : {}), ...(outputTokens !== undefined ? { outputTokens } : {}) };
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
