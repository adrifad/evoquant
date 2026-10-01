// M1 scope item 3 — OKX REST base client.
// Spec §5.2 (demo REST endpoint, x-simulated-trading: 1), §6 (auth headers),
// §44 (demo-only hard guard: abort/throw unless demo; production path
// unreachable by configuration).
//
// Deterministic module: fetch is injectable for tests (default global fetch).
// All OKX payloads stay strings here; numeric mapping happens in mappers only.
// Credentials are NEVER logged (spec §51) — redaction lives in the logger.

import { buildAuthHeaders, type OkxCredentials } from "./auth.ts";
import type { OkxResponse } from "./types.ts";

// Spec §5.2 — the ONLY REST base ever configurable: the demo endpoint.
export const DEMO_BASE_URL = "https://openapi.okx.com";

// Spec §44 — production REST domain. This constant exists ONLY so the
// forbidden path is explicit and auditable; there is NO config flag, env var,
// or option that reaches it. If it is ever (erroneously) selected the process
// hard-aborts before any request is sent.
const PRODUCTION_BASE_URL = "https://www.okx.com";

export class OkxApiError extends Error {
  readonly code: string;
  readonly msg: string;
  readonly httpStatus: number | undefined;

  constructor(code: string, msg: string, httpStatus?: number) {
    super(`OKX API error ${code}: ${msg || "(no message)"}`);
    this.name = "OkxApiError";
    this.code = code;
    this.msg = msg;
    if (httpStatus !== undefined) this.httpStatus = httpStatus;
  }
}

export class OkxConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OkxConfigError";
  }
}

export type QueryParams = Record<string, string | number | boolean | undefined>;

export interface OkxClientOptions {
  // Spec §44 — must be "demo"; anything else is rejected at construction.
  environment: "demo";
  credentials?: OkxCredentials;
  // Injectable for tests (spec: no network in unit tests).
  fetchImpl?: typeof fetch;
  // Only DEMO_BASE_URL is accepted (spec §5.2/§44).
  baseUrl?: string;
  timeoutMs?: number;
}

export interface RequestOptions {
  query?: QueryParams | undefined;
  body?: unknown;
  // When true the request is signed with OK-ACCESS-* headers (spec §6) and
  // ALWAYS carries x-simulated-trading: 1 (spec §5.2/§44).
  private?: boolean;
}

// Spec §5.2/§44 — resolve the base URL. The production constant sits behind
// this guard and aborts the process if ever selected; every other value that
// is not the demo endpoint is a misconfiguration and throws.
export function resolveBaseUrl(override?: string): string {
  const selected = override ?? DEMO_BASE_URL;
  if (selected === PRODUCTION_BASE_URL) {
    console.error("ABORT: production OKX endpoint is forbidden (spec §44)");
    process.abort();
  }
  if (selected !== DEMO_BASE_URL) {
    throw new OkxConfigError(
      `base URL must be "${DEMO_BASE_URL}" (demo only, spec §5.2/§44), got "${selected}"`,
    );
  }
  return selected;
}

// Deterministic query-string building (insertion order preserved, so the
// signed requestPath matches the URL exactly, spec §6).
export function buildQuery(query?: QueryParams): string {
  if (!query) return "";
  const parts: string[] = [];
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) continue;
    parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`);
  }
  return parts.join("&");
}

// Helper for mappers: unwrap data[0] with a typed error instead of silently
// returning undefined (spec §8 — abort when expected data is missing).
export function firstOf<T>(data: T[], what: string): T {
  const item = Array.isArray(data) ? data[0] : undefined;
  if (item === undefined) {
    throw new OkxApiError("EMPTY_DATA", `no data returned for ${what}`);
  }
  return item;
}

export class OkxClient {
  readonly environment: "demo";
  readonly baseUrl: string;
  // Never logged (spec §51). Explicit `| undefined` (exactOptionalPropertyTypes).
  private readonly credentials: OkxCredentials | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(opts: OkxClientOptions) {
    // Spec §44 — DEMO ONLY hard guard: the constructor throws unless
    // environment === "demo". No production client can exist.
    if (opts.environment !== "demo") {
      throw new OkxConfigError(
        `spec §44 DEMO ONLY: environment must be "demo", got "${String(opts.environment)}"; refusing to create OKX client`,
      );
    }
    this.environment = "demo";
    this.baseUrl = resolveBaseUrl(opts.baseUrl);
    this.credentials = opts.credentials;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 15_000;
  }

  isPrivateConfigured(): boolean {
    return this.credentials !== undefined;
  }

  async request<T>(
    method: "GET" | "POST",
    path: string,
    opts: RequestOptions = {},
  ): Promise<T> {
    const query = buildQuery(opts.query);
    // requestPath(+query) is what gets signed (spec §6) and what is sent.
    const requestPath = query === "" ? path : `${path}?${query}`;
    const url = `${this.baseUrl}${requestPath}`;
    const bodyStr =
      opts.body === undefined ? (method === "POST" ? "{}" : "") : JSON.stringify(opts.body);

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (opts.private) {
      if (this.credentials === undefined) {
        throw new OkxConfigError(
          "credentials are required for private OKX endpoints (spec §6)",
        );
      }
      Object.assign(headers, buildAuthHeaders(this.credentials, method, requestPath, bodyStr));
    }
    // Spec §5.2/§44 — every demo request (public and private) carries
    // x-simulated-trading: 1. Enforced here in one place.
    headers["x-simulated-trading"] = "1";
    if (headers["x-simulated-trading"] !== "1") {
      console.error("ABORT: x-simulated-trading guard violated (spec §44)");
      process.abort();
    }

    const init: RequestInit = {
      method,
      headers,
      signal: AbortSignal.timeout(this.timeoutMs),
    };
    if (method !== "GET") init.body = bodyStr;

    const res = await this.fetchImpl(url, init);

    let json: OkxResponse<T>;
    try {
      json = (await res.json()) as OkxResponse<T>;
    } catch {
      throw new OkxApiError(
        `HTTP_${res.status}`,
        `non-JSON response from OKX (status ${res.status})`,
        res.status,
      );
    }
    // Spec §8/§14 — code !== "0" is an error, never a completed trade.
    // For batch-style endpoints (trade/order) the REAL reason sits in
    // data[].sCode/sMsg even when top-level code is "0" or "1" — surface it.
    if (json.code !== "0") {
      const detail = Array.isArray(json.data) ? JSON.stringify(json.data).slice(0, 300) : "";
      throw new OkxApiError(json.code, `${json.msg}${detail ? ` | ${detail}` : ""}`, res.status);
    }
    return json.data;
  }

  get<T>(path: string, query?: QueryParams, isPrivate: boolean = false): Promise<T> {
    return this.request<T>("GET", path, { query, private: isPrivate });
  }

  post<T>(path: string, body?: unknown, isPrivate: boolean = false): Promise<T> {
    return this.request<T>("POST", path, { body, private: isPrivate });
  }
}
