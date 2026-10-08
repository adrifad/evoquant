// Dashboard trading settings remain bounded by deterministic entry limits (§22/§23/§45).
import { z } from "zod";
import { ABSOLUTE_MAX, type RiskConfig, type TradingConfig } from "./config.ts";
import { kvGet, kvSet, type Store } from "../memory/db.ts";
import { riskFingerprint, selectedEntryLeverage } from "./runtime-risk.ts";

export const RUNTIME_TRADING_KEY = "runtime_trading_v1";
const SettingsSchema = z.object({
  instrument_id: z.string().min(1),
  leverage_default: z.number().int().min(1).max(ABSOLUTE_MAX.leverage),
  leverage_cap: z.number().int().min(1).max(ABSOLUTE_MAX.leverage),
  sizing_mode: z.enum(["risk_based", "percent_of_equity"]),
  position_pct: z.number().min(0.1).max(100),
}).strict().refine((s) => s.leverage_default <= s.leverage_cap, {
  message: "Default leverage must not exceed the trading leverage cap.", path: ["leverage_default"],
});
export type RuntimeTradingSettings = z.infer<typeof SettingsSchema>;
const StoredSchema = z.object({ revision: z.number().int().nonnegative(), settings: SettingsSchema }).strict();
const UpdateSchema = StoredSchema.extend({ confirmIncrease: z.boolean().optional() }).strict();

export class RuntimeTradingError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message); this.name = "RuntimeTradingError"; this.status = status; this.code = code;
  }
}

export function tradingSettings(trading: TradingConfig): RuntimeTradingSettings {
  return { instrument_id: trading.instrument.id, leverage_default: trading.leverage.default,
    leverage_cap: trading.leverage.hard_max, sizing_mode: trading.sizing.mode,
    position_pct: trading.sizing.position_pct };
}

/** Covers settings used while both engines await leverage synchronization (§45). */
export function entrySettingsFingerprint(trading: TradingConfig, risk: RiskConfig): string {
  return JSON.stringify({ trading: tradingSettings(trading), risk: riskFingerprint(risk) });
}

export class RuntimeTradingService {
  private revision = 0;
  private readonly store: Store;
  private readonly instruments: readonly string[];
  readonly trading: TradingConfig;
  readonly risk: RiskConfig;
  constructor(options: { store: Store; trading: TradingConfig; risk: RiskConfig; instruments: string[] }) {
    this.store = options.store; this.trading = options.trading; this.risk = options.risk;
    this.instruments = [...new Set(options.instruments)];
    const raw = kvGet(this.store, RUNTIME_TRADING_KEY);
    const saved = raw === null ? { revision: 0, settings: SettingsSchema.parse(tradingSettings(this.trading)) }
      : StoredSchema.parse(JSON.parse(raw));
    this.validateInstrument(saved.settings.instrument_id);
    this.apply(saved.settings);
    this.revision = saved.revision;
  }
  private allowedInstruments(): string[] {
    return this.instruments.filter((id) => this.risk.hard_limits.allowed_symbols.includes(id));
  }
  private validateInstrument(id: string): void {
    if (!this.allowedInstruments().includes(id)) {
      throw new RuntimeTradingError(400, "INVALID_TRADING_INSTRUMENT", "Select an instrument in the available watchlist and risk allowlist.");
    }
  }
  private apply(settings: RuntimeTradingSettings): void {
    this.trading.instrument.id = settings.instrument_id;
    Object.assign(this.trading.leverage, { default: settings.leverage_default, hard_max: settings.leverage_cap });
    Object.assign(this.trading.sizing, { mode: settings.sizing_mode, position_pct: settings.position_pct });
  }
  snapshot() {
    return { revision: this.revision, settings: tradingSettings(this.trading),
      constraints: { instruments: this.allowedInstruments(), max_leverage: ABSOLUTE_MAX.leverage,
        min_position_pct: 0.1, max_position_pct: 100 },
      effective_leverage: selectedEntryLeverage(this.trading, this.risk), timeframe: this.trading.timeframe,
      margin_mode: this.trading.account.margin_mode, position_mode: this.trading.account.position_mode,
      audit: this.store.db.prepare("SELECT ts,kind,payload FROM system_events WHERE kind='TRADING_SETTING_CHANGED' ORDER BY id DESC LIMIT 30").all(),
    };
  }
  update(input: unknown) {
    const parsed = UpdateSchema.safeParse(input);
    if (!parsed.success) {
      throw new RuntimeTradingError(400, "INVALID_TRADING_SETTINGS",
        "Submit all trading settings: integer leverage from 1 to 10, default within cap, and allocation from 0.1% to 100%.");
    }
    const request = parsed.data;
    const result = this.store.db.transaction(() => {
      const raw = kvGet(this.store, RUNTIME_TRADING_KEY);
      const saved = raw === null ? null : StoredSchema.parse(JSON.parse(raw));
      if (request.revision !== this.revision || request.revision !== (saved?.revision ?? 0)) {
        throw new RuntimeTradingError(409, "TRADING_REVISION_CONFLICT", "Trading settings changed; reload before saving.");
      }
      this.validateInstrument(request.settings.instrument_id);
      const old = tradingSettings(this.trading);
      const fields = Object.keys(old) as Array<keyof RuntimeTradingSettings>;
      const changed = fields.filter((field) => old[field] !== request.settings[field]);
      const increases = request.settings.leverage_default > old.leverage_default ||
        request.settings.leverage_cap > old.leverage_cap || request.settings.position_pct > old.position_pct ||
        request.settings.sizing_mode !== old.sizing_mode;
      if (increases && request.confirmIncrease !== true) {
        throw new RuntimeTradingError(400, "TRADING_INCREASE_CONFIRMATION_REQUIRED",
          "Increasing leverage or allocation, or changing sizing mode, requires confirmIncrease: true.");
      }
      if (!changed.length) return { revision: this.revision, settings: old };
      const next = { revision: this.revision + 1, settings: request.settings };
      kvSet(this.store, RUNTIME_TRADING_KEY, JSON.stringify(next));
      const timestamp = new Date().toISOString();
      const insert = this.store.db.prepare("INSERT INTO system_events(ts,kind,payload) VALUES(?,?,?)");
      for (const field of changed) insert.run(timestamp, "TRADING_SETTING_CHANGED", JSON.stringify({
        field, oldValue: old[field], newValue: next.settings[field], timestamp, revision: next.revision, source: "dashboard",
      }));
      return next;
    }).immediate();
    // Existing nested references stay shared; applying after commit never resizes an open position.
    this.apply(result.settings);
    this.revision = result.revision;
    return this.snapshot();
  }
}
