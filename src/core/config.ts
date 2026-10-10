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
  leverage: 5,
  riskPerTradePct: 2.0,
  maxDailyLossPct: 3.0,
  maxDrawdownPct: 10.0,
  maxConcurrentPositions: 5,
  maxPortfolioOpenRiskPct: 5.0,
} as const;

const TradingSchema = z.object({
  exchange: z.literal("okx"),
  environment: z.literal("demo"),
  instrument: z.object({ id: z.string(), type: z.literal("SWAP") }),
  // multi-coin scan (§17): trade any watchlist member; instrument.id stays primary/anchor
  instruments: z.object({ watchlist: z.array(z.string()).min(1).optional() }).optional(),
  dynamic_watchlist: z.object({
    enabled: z.boolean().default(true),
    dynamic_slots: z.number().int().min(0).max(8).default(8),
    max_total_symbols: z.number().int().min(7).max(15).default(15),
    refresh_hour_utc: z.number().int().min(0).max(23).default(0),
    refresh_minute_utc: z.number().int().min(0).max(59).default(15),
    filters: z.object({
      min_listing_age_days: z.number().int().min(0).max(3650).default(7),
      max_spread_pct: z.number().positive().max(2).default(0.15),
      min_liquidity_usdt: z.number().positive().max(1_000_000_000).default(1_000_000),
      candidate_analysis_limit: z.number().int().min(8).max(60).default(30),
      min_trend_score: z.number().min(0).max(100).default(60),
    }).default({ min_listing_age_days: 7, max_spread_pct: 0.15, min_liquidity_usdt: 1_000_000, candidate_analysis_limit: 30, min_trend_score: 60 }),
  }).default({ enabled: true, dynamic_slots: 8, max_total_symbols: 15, refresh_hour_utc: 0, refresh_minute_utc: 15,
    filters: { min_listing_age_days: 7, max_spread_pct: 0.15, min_liquidity_usdt: 1_000_000, candidate_analysis_limit: 30, min_trend_score: 60 } }),
  // 5m hybrid scalp engine (§46 fee guard) — deterministic signals + LLM gate/supervisor
  scalp: z.object({
    enabled: z.boolean().default(false),
    base_tf: z.enum(["1m", "5m"]).default("1m"),
    signal_tf: z.enum(["1m", "3m", "5m"]).default("5m"),
    ema_fast: z.number().int().min(3).max(50).default(9),
    ema_slow: z.number().int().min(6).max(120).default(21),
    rsi_period: z.number().int().min(4).max(14).default(7),
    rsi_long_min: z.number().min(40).max(60).default(50),
    rsi_long_max: z.number().min(60).max(75).default(68),
    rsi_short_min: z.number().min(25).max(40).default(32),
    rsi_short_max: z.number().min(40).max(60).default(50),
    vol_burst_min: z.number().min(1).max(3).default(1.25),
    min_score: z.number().min(0.4).max(0.9).default(0.6),
    stop_atr_mult: z.number().min(0.8).max(3).default(1.4),
    tp_r: z.number().min(1.2).max(3).default(2.0),
    min_tp_pct: z.number().min(0.1).max(1.5).default(0.35),
    max_hold_s: z.number().int().min(120).max(1800).default(900),
    cooldown_s: z.number().int().min(60).max(900).default(240),
    max_daily_trades: z.number().int().min(1).max(40).default(20),
    llm_gate: z.boolean().default(true),
    stance_refresh_s: z.number().int().min(300).max(1800).default(900),
    fee_pct: z.number().min(0.02).max(0.1).default(0.05),
    position_pct: z.number().min(1).max(100).default(8),
  }).optional(),
  timeframe: z.enum(["1m", "3m", "5m", "15m", "30m", "1H", "2H", "4H", "6H", "12H", "1D", "1W"]),
  account: z.object({
    margin_mode: z.literal("isolated"),
    position_mode: z.literal("long_short_mode"),
  }),
  leverage: z.object({
    default: z.number().int().min(1).lte(ABSOLUTE_MAX.leverage),
    hard_max: z.number().int().min(1).lte(ABSOLUTE_MAX.leverage),
  }).refine((v) => v.default <= v.hard_max, { message: "leverage.default must not exceed leverage.hard_max" }),
  decision: z.object({ minimum_confidence: z.number().min(0).max(1) }),
  sizing: z.object({
    mode: z.enum(["risk_based", "percent_of_equity"]).default("risk_based"),
    position_pct: z.number().min(0.1).max(100).default(1),
  }).default({ mode: "risk_based", position_pct: 1 }),
  position_management: z.object({
    sl_plus: z.object({
      enabled: z.boolean().default(true),
      activation_r: z.number().min(0.25).max(5).default(1),
      lock_in_r: z.number().min(0).max(1).default(0.05),
      min_profit_buffer_pct: z.number().min(0).max(1).default(0.12),
    }).default({ enabled: true, activation_r: 1, lock_in_r: 0.05, min_profit_buffer_pct: 0.12 }),
  }).default({ sl_plus: { enabled: true, activation_r: 1, lock_in_r: 0.05, min_profit_buffer_pct: 0.12 } }),
  strategies_enabled: z.array(z.string()).min(1).optional(), // legacy Core 1 config compatibility
  strategy_core: z.object({
    version: z.union([z.literal(1), z.literal(2)]).default(2),
    enabled_families: z.array(z.enum(["TREND_FOLLOWING", "BREAKOUT", "MEAN_REVERSION"])).min(1)
      .default(["TREND_FOLLOWING", "BREAKOUT", "MEAN_REVERSION"]),
  }).default({ version: 2, enabled_families: ["TREND_FOLLOWING", "BREAKOUT", "MEAN_REVERSION"] }),
  validation: z.object({ baseline_mode: z.boolean().default(false) }).default({ baseline_mode: false }),
});

const RiskSchema = z.object({
  hard_limits: z.object({
    risk_per_trade_pct: z.number().positive().lte(ABSOLUTE_MAX.riskPerTradePct),
    max_daily_loss_pct: z.number().positive().lte(ABSOLUTE_MAX.maxDailyLossPct),
    max_drawdown_pct: z.number().positive().lte(ABSOLUTE_MAX.maxDrawdownPct),
    max_leverage: z.number().int().min(1).lte(ABSOLUTE_MAX.leverage),
    max_concurrent_positions: z.number().int().min(1).lte(ABSOLUTE_MAX.maxConcurrentPositions),
    max_portfolio_open_risk_pct: z.number().positive().lte(ABSOLUTE_MAX.maxPortfolioOpenRiskPct),
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
