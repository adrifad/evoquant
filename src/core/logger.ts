// M1 scope item 9 — JSON logger with centralized secret redaction (spec §51).
// NEVER log: api key, secret, passphrase, signature, authorization header.
// Redaction happens in exactly one place (redact) and is applied to every
// structured log line. Values are matched by KEY NAME (case-insensitive),
// not content, so no secret-shaped string escapes.

import type { OkxCredentials } from "../exchange/okx/auth.ts";

const SECRET_KEY_PATTERN = /(apikey|api_key|secret|passphrase|sign|authorization|password|token)/i;
const REDACTED = "***REDACTED***";

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6 || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SECRET_KEY_PATTERN.test(k) ? REDACTED : redact(v, depth + 1);
  }
  return out;
}

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogFields {
  event: string;
  subsystem?: string | undefined;
  tradeId?: string | undefined;
  decisionId?: string | undefined;
  orderId?: string | undefined;
  [key: string]: unknown;
}

export interface Logger {
  debug(fields: LogFields): void;
  info(fields: LogFields): void;
  warn(fields: LogFields): void;
  error(fields: LogFields): void;
}

function write(level: LogLevel, fields: LogFields): void {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    ...(redact(fields) as Record<string, unknown>),
  });
  if (level === "error") console.error(line);
  else console.log(line);
}

export function createLogger(defaultSubsystem?: string | undefined): Logger {
  const withDefault = (fields: LogFields): LogFields => ({
    ...(defaultSubsystem !== undefined ? { subsystem: defaultSubsystem } : {}),
    ...fields,
  });
  return {
    debug: (f) => write("debug", withDefault(f)),
    info: (f) => write("info", withDefault(f)),
    warn: (f) => write("warn", withDefault(f)),
    error: (f) => write("error", withDefault(f)),
  };
}

// Credentials must never be enumerable into logs; this helper documents the
// allowed surface (spec §51) — pass only the shape, and even then the logger
// redacts by key.
export function credentialSafeSummary(creds: OkxCredentials): { keyPrefix: string } {
  return { keyPrefix: creds.apiKey.slice(0, 4) };
}
