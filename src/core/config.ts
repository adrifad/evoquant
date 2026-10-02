// M1 — config loading with ABSOLUTE hard maximums hardcoded here (spec §23,
// §43, §44, §48). Config files can tighten limits but can NEVER exceed the
// absolute maxes; a config outside them aborts startup. The environment flag
// must be "demo" — assertDemo() is called by every entrypoint (spec §44).

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import YAML from "yaml";
import { z } from "zod";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

// spec §48 — these may NEVER be relaxed via config/evolution; outside = refuse.
export const ABSOLUTE_MAX = {
  leverage: 10,
  riskPerTradePct: 2.0,
  maxDailyLossPct: 5.0,
  maxDrawdownPct: 20.0,
  maxConcurrentPositions: 3,
} as const;

const TradingSchema = z.object({
  exchange: z.literal("okx"),
  environment: z.literal("demo"),
  instrument: z.object({ id: z.string(), type: z.literal("SWAP") }),
  timeframe: z.enum(["1m", "3m", "5m", "15m", "30m", "1H", "2H", "4H", "6H", "12H", "1D", "1W"]),
  account: z.object({
    margin_mode: z.literal("isolated"),
    position_mode: z.literal("long_short_mode"),
  }),
  leverage: z.object({
    default: z.number().int().min(1).lte(ABSOLUTE_MAX.leverage),
    hard_max: z.number().int().min(1).lte(ABSOLUTE_MAX.leverage),
  }),
  decision: z.object({ minimum_confidence: z.number().min(0).max(1) }),
  sizing: z.object({
    mode: z.enum(["risk_based", "percent_of_equity"]).default("risk_based"),
    position_pct: z.number().min(0.1).max(50).default(1),
  }).default({ mode: "risk_based", position_pct: 1 }),
  strategies_enabled: z.array(z.string()).min(1),
});

const RiskSchema = z.object({
  hard_limits: z.object({
    risk_per_trade_pct: z.number().positive().lte(ABSOLUTE_MAX.riskPerTradePct),
    max_daily_loss_pct: z.number().positive().lte(ABSOLUTE_MAX.maxDailyLossPct),
    max_drawdown_pct: z.number().positive().lte(ABSOLUTE_MAX.maxDrawdownPct),
    max_leverage: z.number().int().min(1).lte(ABSOLUTE_MAX.leverage),
    max_concurrent_positions: z.number().int().min(1).lte(ABSOLUTE_MAX.maxConcurrentPositions),
    allowed_symbols: z.array(z.string()).min(1),
  }),
  kill_switch: z.array(z.string()).min(1),
  clock_drift_max_ms: z.number().int().min(100).max(5000),
});

export type TradingConfig = z.infer<typeof TradingSchema>;
export type RiskConfig = z.infer<typeof RiskSchema>;

function loadYaml(rel: string): unknown {
  return YAML.parse(readFileSync(path.join(ROOT, rel), "utf8"));
}

export function loadTradingConfig(): TradingConfig {
  return TradingSchema.parse(loadYaml("config/trading.yaml"));
}

export function loadRiskConfig(): RiskConfig {
  return RiskSchema.parse(loadYaml("config/risk.yaml"));
}

// spec §44 — demo-only hard guard from the configuration side (client.ts
// enforces it from the transport side; both must hold).
export function assertDemo(env: Record<string, string | undefined> | undefined = process.env): void {
  if (env?.OKX_ENV !== "demo") {
    throw new Error(
      `spec §44 DEMO ONLY: OKX_ENV must equal "demo", got "${String(env?.OKX_ENV)}" — refusing to start`,
    );
  }
}
