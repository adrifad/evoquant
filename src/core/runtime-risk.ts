// Operational limits remain deterministic and bounded by §22/§23/§48 ceilings.
import { z } from "zod";
import { ABSOLUTE_MAX, type RiskConfig, type TradingConfig } from "./config.ts";
import { kvGet, kvSet, type Store } from "../memory/db.ts";

export const RUNTIME_RISK_KEY = "runtime_risk_v1";
export const ENTRY_RESERVATION_KEY = "unresolved_entry_v1";
const EntryReservationSchema = z.object({
  clOrdId: z.string().min(1), instId: z.string().min(1),
  posSide: z.enum(["long", "short"]), createdAt: z.string().min(1),
}).strict();
export type EntryReservation = z.infer<typeof EntryReservationSchema>;

export function unresolvedEntry(store: Store): EntryReservation | null {
  const raw = kvGet(store, ENTRY_RESERVATION_KEY);
  return raw === null ? null : EntryReservationSchema.parse(JSON.parse(raw));
}

/** Persist before the request can reach the exchange; timeouts never release this reservation (§45). */
export function reserveEntry(store: Store, entry: Omit<EntryReservation, "createdAt">): void {
  const reservation = EntryReservationSchema.parse({ ...entry, createdAt: new Date().toISOString() });
  store.db.transaction(() => {
    if (unresolvedEntry(store)) throw new Error("STATE_UNCERTAIN: unresolved entry requires reconciliation");
    kvSet(store, ENTRY_RESERVATION_KEY, JSON.stringify(reservation));
  }).immediate();
}

export function releaseEntry(store: Store, clOrdId: string): void {
  store.db.transaction(() => {
    if (unresolvedEntry(store)?.clOrdId === clOrdId) {
      store.db.prepare("DELETE FROM kv WHERE key=?").run(ENTRY_RESERVATION_KEY);
    }
  }).immediate();
}
export const RISK_CEILINGS = Object.freeze({
  risk_per_trade_pct: ABSOLUTE_MAX.riskPerTradePct,
  max_daily_loss_pct: ABSOLUTE_MAX.maxDailyLossPct,
  max_drawdown_pct: ABSOLUTE_MAX.maxDrawdownPct,
  max_leverage: ABSOLUTE_MAX.leverage,
  max_concurrent_positions: ABSOLUTE_MAX.maxConcurrentPositions,
  max_portfolio_open_risk_pct: ABSOLUTE_MAX.maxPortfolioOpenRiskPct,
});
const LimitsSchema = z.object({
  risk_per_trade_pct: z.number().positive().max(RISK_CEILINGS.risk_per_trade_pct),
  max_daily_loss_pct: z.number().positive().max(RISK_CEILINGS.max_daily_loss_pct),
  max_drawdown_pct: z.number().positive().max(RISK_CEILINGS.max_drawdown_pct),
  max_leverage: z.number().int().min(1).max(RISK_CEILINGS.max_leverage),
  max_concurrent_positions: z.number().int().min(1).max(RISK_CEILINGS.max_concurrent_positions),
  max_portfolio_open_risk_pct: z.number().positive().max(RISK_CEILINGS.max_portfolio_open_risk_pct),
}).strict();
export type OperationalRiskLimits = z.infer<typeof LimitsSchema>;
const StoredSchema = z.object({ revision: z.number().int().nonnegative(), limits: LimitsSchema }).strict();
const UpdateSchema = StoredSchema.extend({ confirmRiskIncrease: z.boolean().optional() }).strict();
export class RuntimeRiskError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message); this.name = "RuntimeRiskError"; this.status = status; this.code = code;
  }
}

export function operationalLimits(risk: RiskConfig): OperationalRiskLimits {
  const h = risk.hard_limits;
  return { risk_per_trade_pct: h.risk_per_trade_pct, max_daily_loss_pct: h.max_daily_loss_pct,
    max_drawdown_pct: h.max_drawdown_pct, max_leverage: h.max_leverage,
    max_concurrent_positions: h.max_concurrent_positions,
    max_portfolio_open_risk_pct: h.max_portfolio_open_risk_pct };
}

export class RuntimeRiskService {
  private revision = 0;
  private readonly store: Store;
  readonly risk: RiskConfig;
  readonly baselineMode: boolean;
  constructor(options: { store: Store; risk: RiskConfig; baselineMode?: boolean }) {
    this.store = options.store; this.risk = options.risk; this.baselineMode = options.baselineMode ?? false;
    const raw = kvGet(this.store, RUNTIME_RISK_KEY);
    const saved = raw === null ? { revision: 0, limits: LimitsSchema.parse(operationalLimits(this.risk)) }
      : StoredSchema.parse(JSON.parse(raw)); // Invalid persisted limits abort startup.
    this.revision = saved.revision;
    Object.assign(this.risk.hard_limits, saved.limits);
    if (this.baselineMode) this.risk.hard_limits.max_concurrent_positions = 1;
  }
  snapshot() {
    return { revision: this.revision, limits: operationalLimits(this.risk),
      ceilings: { ...RISK_CEILINGS, ...(this.baselineMode ? { max_concurrent_positions: 1 } : {}) },
      baselineMode: this.baselineMode };
  }
  update(input: unknown) {
    const parsed = UpdateSchema.safeParse(input);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const field = issue?.path.at(-1) as keyof OperationalRiskLimits;
      const labels: Record<keyof OperationalRiskLimits, [string, string]> = {
        risk_per_trade_pct: ["risk per trade", "%"], max_daily_loss_pct: ["daily loss limit", "%"],
        max_drawdown_pct: ["drawdown", "%"], max_leverage: ["leverage", "x"],
        max_concurrent_positions: ["concurrent positions", ""], max_portfolio_open_risk_pct: ["portfolio open risk", "%"],
      };
      const label = labels[field];
      const message = issue?.code === "too_big" && label
        ? `Maximum allowed ${label[0]} is ${RISK_CEILINGS[field]}${label[1]}.`
        : label ? `Enter a valid positive ${label[0]} within its safety ceiling.` : "Invalid risk settings. Reload and submit all operational limits.";
      throw new RuntimeRiskError(400, "INVALID_RISK_LIMITS", message);
    }
    const request = parsed.data;
    if (this.baselineMode && request.limits.max_concurrent_positions !== 1) {
      throw new RuntimeRiskError(400, "BASELINE_POSITION_CAP", "Baseline mode requires max_concurrent_positions = 1");
    }
    const result = this.store.db.transaction(() => {
      const raw = kvGet(this.store, RUNTIME_RISK_KEY);
      const saved = raw === null ? null : StoredSchema.parse(JSON.parse(raw));
      if (request.revision !== this.revision || request.revision !== (saved?.revision ?? 0)) {
        throw new RuntimeRiskError(409, "RISK_REVISION_CONFLICT", "Risk settings changed; reload before saving");
      }
      const old = operationalLimits(this.risk);
      const fields = Object.keys(RISK_CEILINGS) as Array<keyof OperationalRiskLimits>;
      const changed = fields.filter((field) => old[field] !== request.limits[field]);
      if (changed.some((field) => request.limits[field] > old[field]) && request.confirmRiskIncrease !== true) {
        throw new RuntimeRiskError(400, "RISK_INCREASE_CONFIRMATION_REQUIRED", "Increasing risk requires confirmRiskIncrease: true");
      }
      if (!changed.length) return { revision: this.revision, limits: old };
      const next = { revision: this.revision + 1, limits: request.limits };
      kvSet(this.store, RUNTIME_RISK_KEY, JSON.stringify(next));
      const timestamp = new Date().toISOString();
      const insert = this.store.db.prepare("INSERT INTO system_events(ts,kind,payload) VALUES(?,?,?)");
      for (const field of changed) insert.run(timestamp, "RISK_LIMIT_CHANGED", JSON.stringify({
        field, oldValue: old[field], newValue: next.limits[field], source: "dashboard", timestamp, revision: next.revision,
      }));
      return next;
    }).immediate();
    // Commit precedes hot application; both engines retain this object identity.
    Object.assign(this.risk.hard_limits, result.limits);
    this.revision = result.revision;
    return this.snapshot();
  }
}

export function selectedEntryLeverage(trading: TradingConfig, risk: RiskConfig): number {
  return Math.min(trading.leverage.default, trading.leverage.hard_max, risk.hard_limits.max_leverage, ABSOLUTE_MAX.leverage);
}

export function riskFingerprint(risk: RiskConfig): string {
  return JSON.stringify(risk.hard_limits);
}

const entryQueues = new WeakMap<object, Promise<unknown>>();
/** Serialize all engines through refresh, submission, fill and local persistence (§45). */
export async function serializeRiskEntry<T>(store: Store, work: () => Promise<T>): Promise<T> {
  const previous = entryQueues.get(store.db) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(work);
  entryQueues.set(store.db, current);
  try { return await current; }
  finally { if (entryQueues.get(store.db) === current) entryQueues.delete(store.db); }
}
