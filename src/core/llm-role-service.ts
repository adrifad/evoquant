import { z } from "zod";
import type { Store } from "../memory/db.ts";
import { logSystemEvent } from "../memory/db.ts";
import { llmJsonDetailed, type LlmErrorClass, type LlmTransportResult } from "./llm.ts";
import { CandidateGateSchema } from "../agents/decision-agent.ts";
import { StanceSchema, ScalpCandidateGateSchema } from "../agents/scalp-agent.ts";
import { ReviewSchema } from "../agents/reviewer-agent.ts";
import { ProposalSchema } from "../agents/v2-evolution.ts";
import { CriticSchema } from "../agents/critic-agent.ts";
import {
  getLlmConfigForRole, LLM_ROLES, maskApiKey, roleEnvKey,
  type LlmRole, type ResolvedRoleConfig, type RoleLlmConfig, type RuntimeRoleConfig,
} from "./llm-roles.ts";

const BudgetUpdateSchema = z.object({
  maxCallsPerHour: z.number().int().positive().max(100_000).optional(),
  maxCallsPerDay: z.number().int().positive().max(1_000_000).optional(),
}).strict();
const CapabilityUpdateSchema = z.object({
  supportsJsonObject: z.boolean().optional(),
  supportsTemperature: z.boolean().optional(),
  tokenParameter: z.enum(["max_tokens", "max_completion_tokens"]).optional(),
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
  capabilities: CapabilityUpdateSchema.optional(),
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
  capabilities: { supportsJsonObject: boolean; supportsTemperature: boolean; tokenParameter: "max_tokens" | "max_completion_tokens" };
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
  lastStatus: string | null;
  lastRequestAt: string | null;
  lastFailureReason: string | null;
  lastFailureStatus: string | null;
  lastFailureHttpStatus: number | null;
  /** @deprecated Use lastFailureHttpStatus for explicitly historical context. */
  lastHttpStatus: number | null;
}

const TestSchema = z.object({ ok: z.literal(true) }).strict();
const COUNTED_STATUSES = ["SUCCESS", "TIMEOUT", "RATE_LIMIT", "AUTHENTICATION_FAILED", "PROVIDER_ERROR", "HTTP_ERROR", "INVALID_RESPONSE", "NETWORK_ERROR"];
export interface RoleProbeCheck { success: boolean; latency_ms: number; attempts: number; failure_class: string | null; failure_reason: string | null; http_status: number | null; }
export interface RoleProbeResult extends RoleProbeCheck { role: LlmRole; mode: "connection" | "schema"; provider?: string; model?: string; checks?: Record<string, RoleProbeCheck>; error?: string; detail?: string; }
interface SchemaProbe { name: string; system: string; user: string; schema: z.ZodType<unknown>; contextRef: string; }

function toProbeCheck(result: LlmTransportResult<unknown>): RoleProbeCheck { return { success: result.status === "SUCCESS", latency_ms: result.latencyMs, attempts: result.attempts, failure_class: result.status === "SUCCESS" ? null : result.status, failure_reason: result.failureReason ?? null, http_status: result.httpStatus ?? null }; }
function probeSuccess(role: LlmRole, mode: "connection" | "schema", config: RoleLlmConfig, result: LlmTransportResult<unknown>): RoleProbeResult { return { role, mode, provider: config.provider || "custom", model: config.model, ...toProbeCheck(result) }; }
function probeResult(role: LlmRole, mode: "connection" | "schema", config: RoleLlmConfig, result: LlmTransportResult<unknown>): RoleProbeResult { const check = toProbeCheck(result); return { role, mode, provider: config.provider || "custom", model: config.model, ...check, ...(check.success ? {} : { error: check.failure_class ?? "INVALID_RESPONSE" }) }; }
function probeFailure(role: LlmRole, mode: "connection" | "schema", failure: string, config?: RoleLlmConfig): RoleProbeResult { return { success: false, role, mode, ...(config ? { provider: config.provider || "custom", model: config.model } : {}), latency_ms: 0, attempts: 0, failure_class: failure, failure_reason: null, http_status: null, error: failure }; }
function roleSchemaProbes(role: LlmRole): SchemaProbe[] {
  const instruction = "Return only one JSON object matching this schema. This is a harmless diagnostic; do not propose an action.";
  if (role === "gate") return [{ name: "gate", system: instruction, user: '{"verdict":"ALLOW","confidence":0.8,"reasoning":[],"risk_flags":[]}', schema: CandidateGateSchema, contextRef: "diagnostic_schema_gate" }];
  if (role === "scalp") return [
    { name: "stance", system: instruction, user: '{"stance":"NEUTRAL","confidence":0.8,"reason":"diagnostic"}', schema: StanceSchema, contextRef: "diagnostic_schema_scalp_stance" },
    { name: "candidate_gate", system: instruction, user: '{"verdict":"ALLOW","confidence":0.8,"reason":"diagnostic"}', schema: ScalpCandidateGateSchema, contextRef: "diagnostic_schema_scalp_gate" },
  ];
  if (role === "reviewer") return [{ name: "review", system: instruction, user: '{"observations":[],"assumptions_check":{},"lesson_candidates":[]}', schema: ReviewSchema, contextRef: "diagnostic_schema_reviewer" }];
  if (role === "evolution") return [{ name: "proposal", system: instruction, user: '{"proposals":[],"no_change_reason":"diagnostic"}', schema: ProposalSchema, contextRef: "diagnostic_schema_evolution" }];
  return [{ name: "critic", system: instruction, user: '{"verdict":"ACCEPT","confidence":0.8,"issues":[],"reasoning_summary":[]}', schema: CriticSchema, contextRef: "diagnostic_schema_critic" }];
}

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
      id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, role TEXT NOT NULL, retry INTEGER NOT NULL, context_ref TEXT);
      CREATE INDEX IF NOT EXISTS idx_llm_provider_requests_role_ts ON llm_provider_requests(role,ts)`);
    const columns = options.store.db.prepare("PRAGMA table_info(llm_runs)").all() as Array<{ name: string }>;
    if (!columns.some(column => column.name === "provider_requests")) {
      options.store.db.exec("ALTER TABLE llm_runs ADD COLUMN provider_requests INTEGER");
    }
    if (!columns.some(column => column.name === "http_status")) options.store.db.exec("ALTER TABLE llm_runs ADD COLUMN http_status INTEGER");
    if (!columns.some(column => column.name === "failure_reason")) options.store.db.exec("ALTER TABLE llm_runs ADD COLUMN failure_reason TEXT");
    const requestColumns = options.store.db.prepare("PRAGMA table_info(llm_provider_requests)").all() as Array<{ name: string }>;
    if (!requestColumns.some(column => column.name === "context_ref")) options.store.db.exec("ALTER TABLE llm_provider_requests ADD COLUMN context_ref TEXT");
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

  diagnostics(): Record<LlmRole, { lastHour: Record<string, number>; last24Hours: Record<string, number>; byContext: Record<string, number> }> {
    const sinceHour = new Date(this.now() - 3_600_000).toISOString();
    const sinceDay = new Date(this.now() - 86_400_000).toISOString();
    return Object.fromEntries(LLM_ROLES.map(role => {
      const grouped = (since: string, context: boolean) => this.options.store.db.prepare(`SELECT ${context ? "context_ref" : "COALESCE(failure_reason,status) key"} key, COUNT(*) count FROM llm_runs WHERE role=? AND ts>=? GROUP BY key`).all(role, since) as Array<{ key: string; count: number }>;
      return [role, { lastHour: Object.fromEntries(grouped(sinceHour, false).map(row => [row.key, row.count])), last24Hours: Object.fromEntries(grouped(sinceDay, false).map(row => [row.key, row.count])), byContext: Object.fromEntries(grouped(sinceDay, true).map(row => [row.key, row.count])) }];
    })) as Record<LlmRole, { lastHour: Record<string, number>; last24Hours: Record<string, number>; byContext: Record<string, number> }>;
  }

  async json<T>(role: LlmRole, system: string, user: string, schema: z.ZodType<T>, contextRef: string): Promise<T | null> {
    const resolved = this.resolve(role);
    const result = await this.execute(role, resolved, system, user, schema, contextRef);
    return result.value;
  }

  async testConnection(role: LlmRole, input: unknown): Promise<RoleProbeResult> {
    return this.testRole(role, input);
  }

  async testRole(role: LlmRole, input: unknown): Promise<RoleProbeResult> {
    const raw = input && typeof input === "object" ? input as Record<string, unknown> : {};
    const mode = raw.mode === "schema" ? "schema" : "connection";
    const updateInput = { ...raw }; delete updateInput.mode;
    let parsed: RoleUpdate;
    try { parsed = this.validateUpdate(role, updateInput); } catch (error) { return probeFailure(role, mode, safeConfigError(error)); }
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
      this.recordUnavailable(role, candidate, mode === "schema" ? `diagnostic_schema_${role}` : "diagnostic_connection", error);
      return probeFailure(role, mode, error, candidate.config);
    }
    // Connection checks are bounded and inexpensive regardless of role settings.
    const testConfig = { ...candidate.config, timeoutMs: Math.min(candidate.config.timeoutMs, 60_000),
      maxOutputTokens: Math.min(candidate.config.maxOutputTokens, 2048), retryCount: 0 };
    if (mode === "connection") {
      const result = await this.execute(role, { config: testConfig, status: candidate.status }, "Return only JSON: {\"ok\":true}", "{}", TestSchema, "diagnostic_connection");
      return result.status === "SUCCESS" ? probeSuccess(role, mode, candidate.config, result) : probeResult(role, mode, candidate.config, result);
    }
    const probes = roleSchemaProbes(role);
    const checks: Record<string, RoleProbeCheck> = {};
    for (const probe of probes) {
      const result = await this.execute(role, { config: testConfig, status: candidate.status }, probe.system, probe.user, probe.schema, probe.contextRef);
      checks[probe.name] = toProbeCheck(result);
      if (result.status !== "SUCCESS") return { ...probeResult(role, mode, candidate.config, result), checks };
    }
    const successful = probes.length ? checks[probes[0]!.name]! : { success: true, latency_ms: 0, attempts: 0, failure_class: null, failure_reason: null, http_status: null };
    return { success: true, role, mode, provider: candidate.config.provider || "custom", model: candidate.config.model, latency_ms: successful.latency_ms, attempts: probes.reduce((total, probe) => total + checks[probe.name]!.attempts, 0), failure_class: null, failure_reason: null, http_status: null, checks };
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
        capabilities: config.capabilities, now: this.now,
        retryCount: config.retryCount, beforeRequest: () => {
          // Synchronous reservation is shared by all service instances using this DB.
          return this.options.store.db.transaction(() => {
            if (this.budgetState(role, config, this.now()).exhausted) return false;
            this.options.store.db.prepare("INSERT INTO llm_provider_requests(ts,role,retry,context_ref) VALUES(?,?,?,?)")
              .run(new Date(this.now()).toISOString(), role, requests > 0 ? 1 : 0, safeContextRef(contextRef));
            requests++;
            return true;
          }).immediate();
        } }, system, user, schema, this.fetchImpl, this.sleep);
    } catch {
      result = { value: null, status: "NETWORK_ERROR", attempts: 1, latencyMs: 0 };
    }
    const errorClass = result.status === "SUCCESS" ? null : result.failureReason ?? result.status;
    this.recordRun(role, config, result.status, result.latencyMs, requests === 1 ? result.inputTokens ?? null : null,
      requests === 1 ? result.outputTokens ?? null : null, errorClass, contextRef, requests, result.failureReason ?? null, result.httpStatus ?? null);
    const payload = { role, provider: config.provider || "custom", model: config.model, latency_ms: result.latencyMs,
      attempt: result.attempts, success: result.status === "SUCCESS", ...(result.inputTokens !== undefined ? { input_tokens: result.inputTokens } : {}),
      ...(result.outputTokens !== undefined ? { output_tokens: result.outputTokens } : {}), ...(errorClass ? { error_class: errorClass } : {}),
      ...(result.failureReason ? { failure_reason: result.failureReason } : {}), ...(result.httpStatus ? { http_status: result.httpStatus } : {}), contextRef: safeContextRef(contextRef) };
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
    const recent = this.options.store.db.prepare("SELECT ts,status,latency_ms,error_class,failure_reason,http_status FROM llm_runs WHERE role=? ORDER BY id DESC LIMIT 1")
      .get(role) as { ts: string; status: string; latency_ms: number; error_class: string | null; failure_reason: string | null; http_status: number | null } | undefined;
    const success = this.options.store.db.prepare("SELECT ts FROM llm_runs WHERE role=? AND status='SUCCESS' ORDER BY id DESC LIMIT 1")
      .get(role) as { ts: string } | undefined;
    const failure = this.options.store.db.prepare("SELECT ts,status,error_class,failure_reason,http_status FROM llm_runs WHERE role=? AND status NOT IN ('SUCCESS','DISABLED','UNCONFIGURED','INVALID_CONFIG','BUDGET_EXHAUSTED') ORDER BY id DESC LIMIT 1")
      .get(role) as { ts: string; status: string; error_class: string | null; failure_reason: string | null; http_status: number | null } | undefined;
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
      maxRevisionRounds: config.maxRevisionRounds, capabilities: config.capabilities, apiKeyConfigured: Boolean(config.apiKey), apiKeyMasked: maskApiKey(config.apiKey),
      status, lastSuccess: success?.ts ?? null, lastFailure: failure?.ts ?? null, lastLatencyMs: recent?.latency_ms ?? null,
      callsThisHour, callsToday, errorClass: status === "AVAILABLE" ? null : recent?.error_class ?? resolved.errorClass ?? null,
      lastStatus: recent?.status ?? null, lastRequestAt: recent?.ts ?? null,
      lastFailureReason: failure?.failure_reason ?? failure?.error_class ?? null,
      lastFailureStatus: failure?.status ?? null,
      lastFailureHttpStatus: failure?.http_status ?? null,
      lastHttpStatus: failure?.http_status ?? null,
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
    outputTokens: number | null, errorClass: string | null, contextRef: string, requests = 0, failureReason: string | null = null, httpStatus: number | null = null): void {
    this.options.store.db.prepare(`INSERT INTO llm_runs(ts,role,provider,model,status,latency_ms,input_tokens,output_tokens,error_class,context_ref,provider_requests,failure_reason,http_status)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(new Date(this.now()).toISOString(), role, config.provider || "custom", config.model,
      status, Math.max(0, Math.trunc(latencyMs)), inputTokens, outputTokens, errorClass, safeContextRef(contextRef), requests, failureReason, httpStatus);
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
  put("SUPPORTS_JSON_OBJECT", input.capabilities?.supportsJsonObject);
  put("SUPPORTS_TEMPERATURE", input.capabilities?.supportsTemperature);
  put("TOKEN_PARAMETER", input.capabilities?.tokenParameter);
  return updates;
}

function mergeRoleConfig(current: RuntimeRoleConfig | undefined, next: RuntimeRoleConfig): RuntimeRoleConfig {
  return { ...current, ...next,
    ...(current?.budget || next.budget ? { budget: { ...current?.budget, ...next.budget } } : {}),
    ...(current?.capabilities || next.capabilities ? { capabilities: { ...current?.capabilities, ...next.capabilities } } : {}),
  };
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
  if (input.capabilities !== undefined) result.capabilities = {
    ...(input.capabilities.supportsJsonObject !== undefined ? { supportsJsonObject: input.capabilities.supportsJsonObject } : {}),
    ...(input.capabilities.supportsTemperature !== undefined ? { supportsTemperature: input.capabilities.supportsTemperature } : {}),
    ...(input.capabilities.tokenParameter !== undefined ? { tokenParameter: input.capabilities.tokenParameter } : {}),
  };
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
