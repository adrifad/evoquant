import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { z } from "zod";

export const LLM_ROLES = ["gate", "scalp", "reviewer", "evolution", "critic"] as const;
export type LlmRole = typeof LLM_ROLES[number];

const BudgetSchema = z.object({
  max_calls_per_hour: z.number().int().positive().max(100_000).optional(),
  max_calls_per_day: z.number().int().positive().max(1_000_000).optional(),
}).default({});

const DefaultsSchema = z.object({
  enabled: z.boolean(),
  provider: z.string().max(120).refine((value) => !/[\r\n\u0000]/.test(value)).default(""),
  base_url: z.string().max(500).default(""),
  model: z.string().trim().min(1).max(200).refine((value) => !/[\r\n\u0000]/.test(value)),
  temperature: z.number().min(0).max(2),
  timeout_ms: z.number().int().min(500).max(120_000),
  max_output_tokens: z.number().int().min(1).max(16_000),
  retries: z.number().int().min(0).max(3),
  budget: BudgetSchema,
  max_revision_rounds: z.number().int().min(0).max(1).optional(),
  capabilities: z.object({
    supports_json_object: z.boolean().default(true),
    supports_temperature: z.boolean().default(true),
    token_parameter: z.enum(["max_tokens", "max_completion_tokens"]).default("max_tokens"),
  }).default({ supports_json_object: true, supports_temperature: true, token_parameter: "max_tokens" }),
}).strict();

const RolesFileSchema = z.object({ llm: z.object({ roles: z.record(z.string(), z.unknown()) }) });

export interface RoleBudget {
  maxCallsPerHour?: number;
  maxCallsPerDay?: number;
}

export interface RoleLlmConfig {
  role: LlmRole;
  enabled: boolean;
  provider: string;
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature: number;
  timeoutMs: number;
  maxOutputTokens: number;
  retryCount: number;
  budget: RoleBudget;
  maxRevisionRounds: 0 | 1;
  capabilities: { supportsJsonObject: boolean; supportsTemperature: boolean; tokenParameter: "max_tokens" | "max_completion_tokens" };
}

export type RoleHealthStatus = "AVAILABLE" | "UNCONFIGURED" | "DISABLED" | "ERROR";
export interface ResolvedRoleConfig {
  config: RoleLlmConfig;
  status: RoleHealthStatus;
  errorClass?: "INVALID_ROLE_CONFIG" | "INVALID_BASE_URL";
}

export type RuntimeRoleConfig = Partial<Omit<RoleLlmConfig, "role" | "budget" | "capabilities">> & {
  budget?: RoleBudget;
  capabilities?: Partial<RoleLlmConfig["capabilities"]>;
};

export interface RoleResolutionOptions {
  root: string;
  env?: Record<string, string | undefined>;
  runtime?: Partial<Record<LlmRole, RuntimeRoleConfig>>;
  defaults?: unknown;
}

const ROLE_ENV_NAMES = ["ENABLED", "PROVIDER", "BASE_URL", "API_KEY", "MODEL", "TEMPERATURE", "TIMEOUT_MS", "MAX_OUTPUT_TOKENS", "RETRIES", "MAX_CALLS_PER_HOUR", "MAX_CALLS_PER_DAY", "MAX_REVISION_ROUNDS", "SUPPORTS_JSON_OBJECT", "SUPPORTS_TEMPERATURE", "TOKEN_PARAMETER"] as const;

export function roleEnvKey(role: LlmRole, name: typeof ROLE_ENV_NAMES[number]): string {
  return `LLM_${role.toUpperCase()}_${name}`;
}

export function getLlmConfigForRole(role: LlmRole, options: RoleResolutionOptions): ResolvedRoleConfig {
  const fileEnv = options.env ? {} : readEnvFile(options.root);
  const processEnv = options.env ?? process.env;
  const roleRuntime = options.runtime?.[role] ?? {};
  let rawDefaults: unknown;
  try { rawDefaults = options.defaults ?? readDefaults(options.root); }
  catch { return unavailable(role, roleRuntime, "INVALID_ROLE_CONFIG"); }
  const roleDefaults = readRoleDefaults(rawDefaults, role);
  if (!roleDefaults) return unavailable(role, roleRuntime, "INVALID_ROLE_CONFIG");

  const roleSpecificSetting = ROLE_ENV_NAMES.some((name) => {
    const key = roleEnvKey(role, name);
    return key in fileEnv || key in processEnv;
  }) || Object.keys(roleRuntime).length > 0;
  const legacyMode = !roleSpecificSetting;
  const legacyEnvValue = (name: typeof ROLE_ENV_NAMES[number]): string | undefined => {
    const legacyNames: Partial<Record<typeof ROLE_ENV_NAMES[number], string>> = {
      PROVIDER: "LLM_PROVIDER", BASE_URL: "LLM_BASE_URL", API_KEY: "LLM_API_KEY", MODEL: "LLM_MODEL",
      TEMPERATURE: "LLM_TEMPERATURE", TIMEOUT_MS: "LLM_TIMEOUT_MS", MAX_OUTPUT_TOKENS: "LLM_MAX_OUTPUT_TOKENS", RETRIES: "LLM_RETRIES",
    };
    const legacyName = legacyNames[name];
    if (!legacyName) return undefined;
    if (legacyName in processEnv) return processEnv[legacyName];
    return fileEnv[legacyName];
  };
  const envValue = (name: typeof ROLE_ENV_NAMES[number]): string | undefined => {
    const key = roleEnvKey(role, name);
    // An explicit blank saved by the dashboard is a durable clear marker and
    // must suppress a stale process key after restart.
    if (key in fileEnv && fileEnv[key] === "") return "";
    if (key in processEnv) return processEnv[key];
    if (key in fileEnv) return fileEnv[key];
    return undefined;
  };
  const selected = (runtimeValue: unknown, envName: typeof ROLE_ENV_NAMES[number], fallback: unknown): unknown => {
    if (runtimeValue !== undefined) return runtimeValue;
    const fromEnv = envValue(envName);
    if (fromEnv !== undefined) return fromEnv;
    // Legacy credentials/config are a migration path for the high-frequency
    // Gate only. Copying one generic key to all roles would silently defeat
    // role isolation and can leak credentials across providers.
    const generic = role === "gate" ? legacyEnvValue(envName) : undefined;
    const hasYamlDefault = fallback !== undefined && fallback !== "";
    return generic !== undefined && (legacyMode || !hasYamlDefault) ? generic : fallback;
  };
  try {
    const parseNumber = (value: unknown, fallback: number): number => value === undefined ? fallback : typeof value === "number" ? value : Number(value);
    const parseBoolean = (value: unknown, fallback: boolean): boolean => {
      if (value === undefined) return fallback;
      if (typeof value === "boolean") return value;
      const normalized = String(value).trim().toLowerCase();
      if (["true", "1", "yes"].includes(normalized)) return true;
      if (["false", "0", "no"].includes(normalized)) return false;
      throw new Error("invalid boolean");
    };
    const hourLimit = roleRuntime.budget?.maxCallsPerHour ?? envValue("MAX_CALLS_PER_HOUR") ?? roleDefaults.budget.max_calls_per_hour;
    const dayLimit = roleRuntime.budget?.maxCallsPerDay ?? envValue("MAX_CALLS_PER_DAY") ?? roleDefaults.budget.max_calls_per_day;
    const budget = {
      ...(hourLimit !== undefined ? { maxCallsPerHour: parseNumber(hourLimit, 0) } : {}),
      ...(dayLimit !== undefined ? { maxCallsPerDay: parseNumber(dayLimit, 0) } : {}),
    };
    const config: RoleLlmConfig = {
      role,
      enabled: parseBoolean(selected(roleRuntime.enabled, "ENABLED", roleDefaults.enabled), roleDefaults.enabled),
      provider: String(selected(roleRuntime.provider, "PROVIDER", roleDefaults.provider) ?? ""),
      baseUrl: String(selected(roleRuntime.baseUrl, "BASE_URL", roleDefaults.base_url) ?? "").trim(),
      apiKey: String(selected(roleRuntime.apiKey, "API_KEY", "") ?? ""),
      model: String(selected(roleRuntime.model, "MODEL", roleDefaults.model) ?? "").trim(),
      temperature: parseNumber(selected(roleRuntime.temperature, "TEMPERATURE", roleDefaults.temperature), roleDefaults.temperature),
      timeoutMs: parseNumber(selected(roleRuntime.timeoutMs, "TIMEOUT_MS", roleDefaults.timeout_ms), roleDefaults.timeout_ms),
      maxOutputTokens: parseNumber(selected(roleRuntime.maxOutputTokens, "MAX_OUTPUT_TOKENS", roleDefaults.max_output_tokens), roleDefaults.max_output_tokens),
      retryCount: parseNumber(selected(roleRuntime.retryCount, "RETRIES", roleDefaults.retries), roleDefaults.retries),
      budget,
      maxRevisionRounds: parseNumber(selected(roleRuntime.maxRevisionRounds, "MAX_REVISION_ROUNDS", roleDefaults.max_revision_rounds ?? 1), 1) as 0 | 1,
      capabilities: {
        supportsJsonObject: parseBoolean(selected(roleRuntime.capabilities?.supportsJsonObject, "SUPPORTS_JSON_OBJECT", roleDefaults.capabilities.supports_json_object), roleDefaults.capabilities.supports_json_object),
        supportsTemperature: parseBoolean(selected(roleRuntime.capabilities?.supportsTemperature, "SUPPORTS_TEMPERATURE", roleDefaults.capabilities.supports_temperature), roleDefaults.capabilities.supports_temperature),
        tokenParameter: String(selected(roleRuntime.capabilities?.tokenParameter, "TOKEN_PARAMETER", roleDefaults.capabilities.token_parameter)) as "max_tokens" | "max_completion_tokens",
      },
    };
    validateResolvedConfig(config);
    const hasRuntimeOrEnvUrl = config.baseUrl.length > 0;
    const hasKey = config.apiKey.length > 0;
    const status: RoleHealthStatus = !config.enabled ? "DISABLED" : !hasRuntimeOrEnvUrl || !hasKey ? "UNCONFIGURED" : "AVAILABLE";
    return { config, status };
  } catch (error) {
    const partial: RuntimeRoleConfig = {
      ...roleRuntime,
      provider: roleRuntime.provider ?? roleDefaults.provider,
      model: roleRuntime.model ?? roleDefaults.model,
    };
    const result = unavailable(role, partial, error instanceof Error && error.message === "invalid base URL" ? "INVALID_BASE_URL" : "INVALID_ROLE_CONFIG");
    return result;
  }
}

export function maskApiKey(apiKey: string): string {
  if (!apiKey) return "";
  return `••••${apiKey.slice(-4)}`;
}

function readRoleDefaults(input: unknown, role: LlmRole): z.infer<typeof DefaultsSchema> | null {
  try {
    const file = RolesFileSchema.parse(input);
    const raw = file.llm.roles[role];
    return DefaultsSchema.parse(raw);
  } catch {
    return null;
  }
}

function readDefaults(root: string): unknown {
  return YAML.parse(readFileSync(path.join(root, "config/llm-roles.yaml"), "utf8"));
}

function readEnvFile(root: string): Record<string, string> {
  const filename = path.join(root, ".env");
  if (!existsSync(filename)) return {};
  const values: Record<string, string> = {};
  for (const line of readFileSync(filename, "utf8").split("\n")) {
    const match = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (match?.[1]) values[match[1]] = match[2] ?? "";
  }
  return values;
}

function validateResolvedConfig(config: RoleLlmConfig): void {
  z.object({
    enabled: z.boolean(), provider: z.string().max(120).refine((value) => !/[\r\n\u0000]/.test(value)), model: z.string().trim().min(1).max(200).refine((value) => !/[\r\n\u0000]/.test(value)),
    apiKey: z.string().max(4096).refine((key) => !/[\r\n\u0000]/.test(key)),
    temperature: z.number().min(0).max(2), timeoutMs: z.number().int().min(500).max(120_000),
    maxOutputTokens: z.number().int().min(1).max(16_000), retryCount: z.number().int().min(0).max(3),
    budget: z.object({ maxCallsPerHour: z.number().int().positive().max(100_000).optional(), maxCallsPerDay: z.number().int().positive().max(1_000_000).optional() }),
    maxRevisionRounds: z.number().int().min(0).max(1),
    capabilities: z.object({ supportsJsonObject: z.boolean(), supportsTemperature: z.boolean(), tokenParameter: z.enum(["max_tokens", "max_completion_tokens"]) }),
  }).parse(config);
  if (config.baseUrl) {
    if (/[\r\n\u0000]/.test(config.baseUrl)) throw new Error("invalid base URL");
    let parsed: URL;
    try { parsed = new URL(config.baseUrl); } catch { throw new Error("invalid base URL"); }
    if (!(["http:", "https:"].includes(parsed.protocol)) || parsed.username || parsed.password || parsed.search || parsed.hash) {
      throw new Error("invalid base URL");
    }
  }
}

function unavailable(role: LlmRole, partial: RuntimeRoleConfig, errorClass: ResolvedRoleConfig["errorClass"]): ResolvedRoleConfig {
  return {
    config: {
      role, enabled: false, provider: String(partial.provider ?? ""), baseUrl: String(partial.baseUrl ?? ""), apiKey: "",
      model: String(partial.model ?? ""), temperature: Number(partial.temperature ?? 0), timeoutMs: Number(partial.timeoutMs ?? 20_000),
      maxOutputTokens: Number(partial.maxOutputTokens ?? 250), retryCount: Number(partial.retryCount ?? 0),
      budget: partial.budget ?? {}, maxRevisionRounds: partial.maxRevisionRounds === 0 ? 0 : 1,
      capabilities: { supportsJsonObject: true, supportsTemperature: true, tokenParameter: "max_tokens", ...partial.capabilities },
    },
    status: "ERROR", ...(errorClass ? { errorClass } : {}),
  };
}
