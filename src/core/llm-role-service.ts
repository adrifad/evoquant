import { z } from "zod";
import type { Store } from "../memory/db.ts";
import { logSystemEvent } from "../memory/db.ts";
import { llmJsonDetailed, type LlmErrorClass, type LlmTransportResult } from "./llm.ts";
import {
  getLlmConfigForRole, LLM_ROLES, maskApiKey, roleEnvKey,
  type LlmRole, type ResolvedRoleConfig, type RoleLlmConfig, type RuntimeRoleConfig,
} from "./llm-roles.ts";

const BudgetUpdateSchema = z.object({
  maxCallsPerHour: z.number().int().positive().max(100_000).optional(),
  maxCallsPerDay: z.number().int().positive().max(1_000_000).optional(),
}).strict();

export const RoleUpdateSchema = z.object({
  enabled: z.boolean().optional(),
  provider: z.string().max(120).refine((value) => !/[\r\n\u0000]/.test(value)).optional(),
  baseUrl: z.string().max(500).optional(),
  apiKey: z.string().max(4096).refine((value) => !/[\r\n\u0000]/.test(value)).optional(),
  model: z.string().trim().min(1).max(200).refine((value) => !/[\r\n\u0000]/.test(value)).optional(),
  temperature: z.number().min(0).max(2).optional(),
  timeoutMs: z.number().int().min(500).max(120_000).optional(),
  maxOutputTokens: z.number().int().min(1).max(16_000).optional(),
  retryCount: z.number().int().min(0).max(3).optional(),
  budget: BudgetUpdateSchema.optional(),
  maxRevisionRounds: z.number().int().min(0).max(1).optional(),
}).strict();
export type RoleUpdate = z.infer<typeof RoleUpdateSchema>;

export interface RoleLlmServiceOptions {
  root: string;
  store: Store;
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface SafeRoleSettings {
  role: LlmRole;
  enabled: boolean;
  provider: string;
  baseUrl: string;
  baseUrlHost: string;
  model: string;
  temperature: number;
  timeoutMs: number;
  maxOutputTokens: number;
  retryCount: number;
  budget: { maxCallsPerHour?: number; maxCallsPerDay?: number };
  maxRevisionRounds: 0 | 1;
  apiKeyConfigured: boolean;
  apiKeyMasked: string;
  status: "AVAILABLE" | "UNCONFIGURED" | "DISABLED" | "ERROR" | "BUDGET_EXHAUSTED";
  lastSuccess: string | null;
  lastFailure: string | null;
  lastLatencyMs: number | null;
  callsThisHour: number;
  callsToday: number;
  providerRequestsThisHour: number;
  providerRequestsToday: number;
  legacyBudgetChargesThisHour: number;
  legacyBudgetChargesToday: number;
  budgetRequestsThisHour: number;
  budgetRequestsToday: number;
  retriesToday: number;
  inputTokensToday: number | null;
  outputTokensToday: number | null;
  errorClass: string | null;
}

const TestSchema = z.object({ ok: z.literal(true) }).strict();
const COUNTED_STATUSES = ["SUCCESS", "TIMEOUT", "RATE_LIMIT", "AUTHENTICATION_FAILED", "PROVIDER_ERROR", "HTTP_ERROR", "INVALID_RESPONSE", "NETWORK_ERROR"];

export class RoleLlmService {
  private readonly runtime: Partial<Record<LlmRole, RuntimeRoleConfig>> = {};
  private readonly options: RoleLlmServiceOptions;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: RoleLlmServiceOptions) {
    this.options = options;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    options.store.db.exec(`CREATE TABLE IF NOT EXISTS llm_provider_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, role TEXT NOT NULL, retry INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS idx_llm_provider_requests_role_ts ON llm_provider_requests(role,ts)`);
    const columns = options.store.db.prepare("PRAGMA table_info(llm_runs)").all() as Array<{ name: string }>;
    if (!columns.some(column => column.name === "provider_requests")) {
      options.store.db.exec("ALTER TABLE llm_runs ADD COLUMN provider_requests INTEGER");
    }
  }

  resolve(role: LlmRole): ResolvedRoleConfig {
    return getLlmConfigForRole(role, { root: this.options.root, ...(this.options.env ? { env: this.options.env } : {}), runtime: this.runtime });
  }

  validateUpdate(role: LlmRole, input: unknown): RoleUpdate {
    const parsed = RoleUpdateSchema.parse(input);
    const update = updateToRuntime(parsed);
    const apiKey = parsed.apiKey;
    // A blank password field means KEEP. Clearing requires the explicit action.
    if (typeof apiKey === "string" && apiKey.length > 0) update.apiKey = apiKey;
    const candidateRuntime = { ...this.runtime, [role]: mergeRoleConfig(this.runtime[role], update) };
    const candidate = getLlmConfigForRole(role, { root: this.options.root, ...(this.options.env ? { env: this.options.env } : {}), runtime: candidateRuntime });
    if (candidate.status === "ERROR") throw new Error(candidate.errorClass ?? "INVALID_ROLE_CONFIG");
    return parsed;
  }

  updateRuntime(role: LlmRole, input: RoleUpdate): void {
    const update = updateToRuntime(input);
    const apiKey = input.apiKey;
    if (typeof apiKey === "string" && apiKey.length > 0) update.apiKey = apiKey;
    this.runtime[role] = mergeRoleConfig(this.runtime[role], update);
  }

  clearApiKey(role: LlmRole): void {
    this.runtime[role] = mergeRoleConfig(this.runtime[role], { apiKey: "" });
  }

  settings(): SafeRoleSettings[] {
    return LLM_ROLES.map((role) => this.safeSettings(role));
  }

  async json<T>(role: LlmRole, system: string, user: string, schema: z.ZodType<T>, contextRef: string): Promise<T | null> {
    const resolved = this.resolve(role);
    const result = await this.execute(role, resolved, system, user, schema, contextRef);
    return result.value;
  }

  async testConnection(role: LlmRole, input: unknown): Promise<{ success: boolean; role: LlmRole; provider?: string; model?: string; latency_ms?: number; error?: string; detail?: string }> {
    let parsed: RoleUpdate;
    try { parsed = this.validateUpdate(role, input); }
    catch (error) {
      return { success: false, role, error: safeConfigError(error) };
    }
    const patch = updateToRuntime(parsed);
    // A connection probe is diagnostic and does not change the persisted
    // trading role's enabled state, so disabled roles may still be tested.
    patch.enabled = true;
    const apiKey = parsed.apiKey;
    if (typeof apiKey === "string" && apiKey.length > 0) patch.apiKey = apiKey;
    const candidate = getLlmConfigForRole(role, { root: this.options.root, ...(this.options.env ? { env: this.options.env } : {}),
      runtime: { ...this.runtime, [role]: mergeRoleConfig(this.runtime[role], patch) } });
    if (candidate.status !== "AVAILABLE") {
      const error = candidate.status === "DISABLED" ? "ROLE_DISABLED" : candidate.status === "ERROR" ? candidate.errorClass ?? "INVALID_ROLE_CONFIG" : "NOT_CONFIGURED";
      this.recordUnavailable(role, candidate, "test_connection", error);
      return { success: false, role, error };
    }
    // Connection checks are bounded and inexpensive regardless of role settings.
    const testConfig = { ...candidate.config, timeoutMs: Math.min(candidate.config.timeoutMs, 60_000),
      maxOutputTokens: Math.min(candidate.config.maxOutputTokens, 2048), retryCount: 0 };
    const result = await this.execute(role, { config: testConfig, status: candidate.status },
      "Return only JSON: {\"ok\":true}", "{}", TestSchema, "test_connection");
    if (result.status !== "SUCCESS") {
      const details = {
        OUTPUT_LIMIT: `Provider reached the ${testConfig.maxOutputTokens}-token output limit before a complete reply. ${testConfig.maxOutputTokens < 2048 ? "Increase Max output tokens; the connection probe is capped at 2048 tokens." : "This probe is already at its 2048-token cap. Raising the role limit further will not extend this test; use a model that can complete this short structured check within the cap."}`,
        EMPTY_CONTENT: "Provider returned no final answer. Reasoning-only output is not a valid structured reply.",
        MALFORMED_COMPLETION: "Provider did not return the expected chat completion response. Check Base URL and model compatibility.",
        INVALID_JSON: "Provider replied, but the final answer was not valid JSON. This test requires a structured reply.",
        SCHEMA_MISMATCH: 'Provider JSON did not match the required acknowledgement {"ok":true}.',
      };
      return { success: false, role, error: result.status, ...(result.failureReason ? { detail: details[result.failureReason] } : {}) };
    }
    return { success: true, role, provider: candidate.config.provider || "custom", model: candidate.config.model, latency_ms: result.latencyMs };
  }

  private async execute<T>(role: LlmRole, resolved: ResolvedRoleConfig, system: string, user: string,
    schema: z.ZodType<T>, contextRef: string): Promise<LlmTransportResult<T>> {
    const config = resolved.config;
    if (resolved.status !== "AVAILABLE") {
      const status = resolved.status === "DISABLED" ? "DISABLED" : resolved.status === "ERROR" ? "INVALID_CONFIG" : "UNCONFIGURED";
      this.recordUnavailable(role, resolved, contextRef, resolved.errorClass ?? status);
      return { value: null, status: "INVALID_RESPONSE", attempts: 0, latencyMs: 0 };
    }
    const now = this.now();
    const quota = this.budgetState(role, config, now);
    if (quota.exhausted) {
      this.recordRun(role, config, "BUDGET_EXHAUSTED", 0, null, null, null, contextRef);
      logSystemEvent(this.options.store, "LLM_BUDGET_EXHAUSTED", { role, provider: config.provider || "custom", model: config.model, contextRef: safeContextRef(contextRef) });
      return { value: null, status: "BUDGET_EXHAUSTED", attempts: 0, latencyMs: 0 };
    }
    logSystemEvent(this.options.store, "LLM_REQUEST", { role, provider: config.provider || "custom", model: config.model, contextRef: safeContextRef(contextRef) });
    let result: LlmTransportResult<T>;
    let requests = 0;
    try {
      result = await llmJsonDetailed({ baseUrl: config.baseUrl, apiKey: config.apiKey, model: config.model,
        temperature: config.temperature, timeoutMs: config.timeoutMs, maxOutputTokens: config.maxOutputTokens,
        retryCount: config.retryCount, beforeRequest: () => {
          // Synchronous reservation is shared by all service instances using this DB.
          return this.options.store.db.transaction(() => {
            if (this.budgetState(role, config, this.now()).exhausted) return false;
            this.options.store.db.prepare("INSERT INTO llm_provider_requests(ts,role,retry) VALUES(?,?,?)")
              .run(new Date(this.now()).toISOString(), role, requests > 0 ? 1 : 0);
            requests++;
            return true;
          }).immediate();
        } }, system, user, schema, this.fetchImpl, this.sleep);
    } catch {
      result = { value: null, status: "NETWORK_ERROR", attempts: 1, latencyMs: 0 };
    }
    this.recordRun(role, config, result.status, result.latencyMs, requests === 1 ? result.inputTokens ?? null : null,
      requests === 1 ? result.outputTokens ?? null : null,
      result.status === "SUCCESS" ? null : result.status, contextRef, requests);
    const payload = { role, provider: config.provider || "custom", model: config.model, latency_ms: result.latencyMs,
      attempt: result.attempts, success: result.status === "SUCCESS", ...(result.inputTokens !== undefined ? { input_tokens: result.inputTokens } : {}),
      ...(result.outputTokens !== undefined ? { output_tokens: result.outputTokens } : {}), ...(result.status !== "SUCCESS" ? { error_class: result.status } : {}),
      ...(result.failureReason ? { failure_reason: result.failureReason } : {}), contextRef: safeContextRef(contextRef) };
    if (result.status === "SUCCESS") logSystemEvent(this.options.store, "LLM_SUCCESS", payload);
    else logSystemEvent(this.options.store, eventKind(result.status), payload);
    return result;
  }

  private safeSettings(role: LlmRole): SafeRoleSettings {
    const resolved = this.resolve(role);
    const { config } = resolved;
    const now = this.now();
    const hourStart = new Date(now - 3_600_000).toISOString();
    const todayStart = new Date(now).toISOString().slice(0, 10) + "T00:00:00.000Z";
    const callsThisHour = this.countCalls(role, hourStart);
    const callsToday = this.countCalls(role, todayStart);
    const recent = this.options.store.db.prepare("SELECT ts,status,latency_ms,error_class FROM llm_runs WHERE role=? ORDER BY id DESC LIMIT 1")
      .get(role) as { ts: string; status: string; latency_ms: number; error_class: string | null } | undefined;
    const success = this.options.store.db.prepare("SELECT ts FROM llm_runs WHERE role=? AND status='SUCCESS' ORDER BY id DESC LIMIT 1")
      .get(role) as { ts: string } | undefined;
    const failure = this.options.store.db.prepare("SELECT ts,error_class FROM llm_runs WHERE role=? AND status NOT IN ('SUCCESS','DISABLED','UNCONFIGURED','INVALID_CONFIG','BUDGET_EXHAUSTED') ORDER BY id DESC LIMIT 1")
      .get(role) as { ts: string; error_class: string | null } | undefined;
    const budgetRequestsThisHour = this.countRequests(role, hourStart);
    const budgetRequestsToday = this.countRequests(role, todayStart);
    const legacyBudgetChargesThisHour = this.countLegacyCharges(role, hourStart);
    const legacyBudgetChargesToday = this.countLegacyCharges(role, todayStart);
    const providerRequestsThisHour = budgetRequestsThisHour - legacyBudgetChargesThisHour;
    const providerRequestsToday = budgetRequestsToday - legacyBudgetChargesToday;
    const usage = this.options.store.db.prepare(`SELECT
      CASE WHEN COUNT(*)=COUNT(input_tokens) THEN SUM(input_tokens) END input,
      CASE WHEN COUNT(*)=COUNT(output_tokens) THEN SUM(output_tokens) END output,
      COALESCE(SUM(provider_requests),0) completed_requests
      FROM llm_runs WHERE role=? AND ts>=? AND (provider_requests>0 OR (provider_requests IS NULL AND status IN (${COUNTED_STATUSES.map(() => "?").join(",")})))`)
      .get(role, todayStart, ...COUNTED_STATUSES) as { input: number | null; output: number | null; completed_requests: number };
    const retry = this.options.store.db.prepare("SELECT COALESCE(SUM(retry),0) count FROM llm_provider_requests WHERE role=? AND ts>=?").get(role, todayStart) as { count: number };
    const overBudget = (config.budget.maxCallsPerHour !== undefined && budgetRequestsThisHour >= config.budget.maxCallsPerHour)
      || (config.budget.maxCallsPerDay !== undefined && budgetRequestsToday >= config.budget.maxCallsPerDay);
    const status = resolved.status !== "AVAILABLE" ? resolved.status : overBudget ? "BUDGET_EXHAUSTED"
      : recent && recent.status !== "SUCCESS" && recent.status !== "UNCONFIGURED" && recent.status !== "DISABLED" && recent.status !== "BUDGET_EXHAUSTED" ? "ERROR" : "AVAILABLE";
    let baseUrlHost = "";
    try { baseUrlHost = new URL(config.baseUrl).hostname; } catch { /* not configured */ }
    return {
      role, enabled: config.enabled, provider: config.provider || (config.baseUrl ? "custom" : ""), baseUrl: config.baseUrl,
      baseUrlHost, model: config.model, temperature: config.temperature, timeoutMs: config.timeoutMs,
      maxOutputTokens: config.maxOutputTokens, retryCount: config.retryCount, budget: config.budget,
      maxRevisionRounds: config.maxRevisionRounds, apiKeyConfigured: Boolean(config.apiKey), apiKeyMasked: maskApiKey(config.apiKey),
      status, lastSuccess: success?.ts ?? null, lastFailure: failure?.ts ?? null, lastLatencyMs: recent?.latency_ms ?? null,
      callsThisHour, callsToday, errorClass: status === "AVAILABLE" ? null : recent?.error_class ?? resolved.errorClass ?? null,
      providerRequestsThisHour, providerRequestsToday, retriesToday: retry.count,
      legacyBudgetChargesThisHour, legacyBudgetChargesToday, budgetRequestsThisHour, budgetRequestsToday,
      inputTokensToday: usage.completed_requests === providerRequestsToday && !legacyBudgetChargesToday ? usage.input : null,
      outputTokensToday: usage.completed_requests === providerRequestsToday && !legacyBudgetChargesToday ? usage.output : null,
    };
  }

  private budgetState(role: LlmRole, config: RoleLlmConfig, now: number): { exhausted: boolean } {
    const hour = this.countRequests(role, new Date(now - 3_600_000).toISOString());
    const midnight = new Date(now).toISOString().slice(0, 10) + "T00:00:00.000Z";
    const day = this.countRequests(role, midnight);
    return { exhausted: (config.budget.maxCallsPerHour !== undefined && hour >= config.budget.maxCallsPerHour)
      || (config.budget.maxCallsPerDay !== undefined && day >= config.budget.maxCallsPerDay) };
  }

  private countCalls(role: LlmRole, since: string): number {
    const placeholders = COUNTED_STATUSES.map(() => "?").join(",");
    const row = this.options.store.db.prepare(`SELECT COUNT(*) count FROM llm_runs WHERE role=? AND ts>=? AND (provider_requests>0 OR (provider_requests IS NULL AND status IN (${placeholders})))`)
      .get(role, since, ...COUNTED_STATUSES) as { count: number };
    return row.count;
  }

  private countRequests(role: LlmRole, since: string): number {
    const requests = (this.options.store.db.prepare("SELECT COUNT(*) count FROM llm_provider_requests WHERE role=? AND ts>=?").get(role, since) as { count: number }).count;
    // Legacy runs predate attempt accounting. Preserve their existing budget
    // charge rather than resetting a role's allowance during migration.
    return requests + this.countLegacyCharges(role, since);
  }

  private countLegacyCharges(role: LlmRole, since: string): number {
    return (this.options.store.db.prepare(`SELECT COUNT(*) count FROM llm_runs WHERE role=? AND ts>=?
      AND provider_requests IS NULL AND status IN (${COUNTED_STATUSES.map(() => "?").join(",")})`)
      .get(role, since, ...COUNTED_STATUSES) as { count: number }).count;
  }

  private recordRun(role: LlmRole, config: RoleLlmConfig, status: string, latencyMs: number, inputTokens: number | null,
    outputTokens: number | null, errorClass: string | null, contextRef: string, requests = 0): void {
    this.options.store.db.prepare(`INSERT INTO llm_runs(ts,role,provider,model,status,latency_ms,input_tokens,output_tokens,error_class,context_ref,provider_requests)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(new Date(this.now()).toISOString(), role, config.provider || "custom", config.model,
      status, Math.max(0, Math.trunc(latencyMs)), inputTokens, outputTokens, errorClass, safeContextRef(contextRef), requests);
  }

  private recordUnavailable(role: LlmRole, resolved: ResolvedRoleConfig, contextRef: string, errorClass: string): void {
    const { config } = resolved;
    const status = resolved.status === "DISABLED" ? "DISABLED" : resolved.status === "UNCONFIGURED" ? "UNCONFIGURED" : "INVALID_CONFIG";
    this.recordRun(role, config, status, 0, null, null, errorClass, contextRef);
    if (resolved.status === "ERROR") logSystemEvent(this.options.store, "LLM_FAILURE", {
      role, provider: config.provider || "custom", model: config.model, latency_ms: 0, attempt: 0, success: false,
      error_class: errorClass, contextRef: safeContextRef(contextRef),
    });
  }
}

export function roleEnvironmentUpdates(role: LlmRole, input: RoleUpdate, clearApiKey = false): Record<string, string> {
  const updates: Record<string, string> = {};
  const put = (name: Parameters<typeof roleEnvKey>[1], value: unknown): void => { if (value !== undefined) updates[roleEnvKey(role, name)] = String(value); };
  put("ENABLED", input.enabled);
  put("PROVIDER", input.provider);
  put("BASE_URL", input.baseUrl);
  if (typeof input.apiKey === "string" && input.apiKey.length > 0) put("API_KEY", input.apiKey);
  if (clearApiKey) put("API_KEY", "");
  put("MODEL", input.model);
  put("TEMPERATURE", input.temperature);
  put("TIMEOUT_MS", input.timeoutMs);
  put("MAX_OUTPUT_TOKENS", input.maxOutputTokens);
  put("RETRIES", input.retryCount);
  put("MAX_CALLS_PER_HOUR", input.budget?.maxCallsPerHour);
  put("MAX_CALLS_PER_DAY", input.budget?.maxCallsPerDay);
  put("MAX_REVISION_ROUNDS", input.maxRevisionRounds);
  return updates;
}

function mergeRoleConfig(current: RuntimeRoleConfig | undefined, next: RuntimeRoleConfig): RuntimeRoleConfig {
  return { ...current, ...next, ...(current?.budget || next.budget ? { budget: { ...current?.budget, ...next.budget } } : {}) };
}

function updateToRuntime(input: RoleUpdate): RuntimeRoleConfig {
  const result: RuntimeRoleConfig = {};
  if (input.enabled !== undefined) result.enabled = input.enabled;
  if (input.provider !== undefined) result.provider = input.provider;
  if (input.baseUrl !== undefined) result.baseUrl = input.baseUrl;
  if (input.model !== undefined) result.model = input.model;
  if (input.temperature !== undefined) result.temperature = input.temperature;
  if (input.timeoutMs !== undefined) result.timeoutMs = input.timeoutMs;
  if (input.maxOutputTokens !== undefined) result.maxOutputTokens = input.maxOutputTokens;
  if (input.retryCount !== undefined) result.retryCount = input.retryCount;
  if (input.budget !== undefined) result.budget = {
    ...(input.budget.maxCallsPerHour !== undefined ? { maxCallsPerHour: input.budget.maxCallsPerHour } : {}),
    ...(input.budget.maxCallsPerDay !== undefined ? { maxCallsPerDay: input.budget.maxCallsPerDay } : {}),
  };
  if (input.maxRevisionRounds !== undefined) result.maxRevisionRounds = input.maxRevisionRounds === 0 ? 0 : 1;
  return result;
}

function safeContextRef(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_:-]/g, "_").slice(0, 80) || "unspecified";
}

function eventKind(status: LlmErrorClass): string {
  if (status === "BUDGET_EXHAUSTED") return "LLM_BUDGET_EXHAUSTED";
  if (status === "TIMEOUT") return "LLM_TIMEOUT";
  if (status === "RATE_LIMIT") return "LLM_RATE_LIMIT";
  if (status === "AUTHENTICATION_FAILED") return "LLM_AUTH_FAILURE";
  return "LLM_FAILURE";
}

function safeConfigError(error: unknown): string {
  if (error instanceof z.ZodError) return "INVALID_ROLE_CONFIG";
  return error instanceof Error && ["INVALID_ROLE_CONFIG", "INVALID_BASE_URL"].includes(error.message)
    ? error.message : "INVALID_ROLE_CONFIG";
}
