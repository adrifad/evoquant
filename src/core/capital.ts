import type { InstrumentInfo, Position } from "../exchange/okx/types.ts";
import type { AccountBalance } from "../exchange/okx/account.ts";
import type { Store } from "../memory/db.ts";

export function finite(value: unknown): number | null {
  if ((typeof value !== "number" && typeof value !== "string") || (typeof value === "string" && !value.trim())) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}
export type ValueSource = "EXCHANGE" | "ESTIMATED" | "UNAVAILABLE";
type Trade = Record<string, unknown>;

export function prepareCapitalStore(store: Store): void {
  store.db.exec("CREATE TABLE IF NOT EXISTS entry_capital (trade_id TEXT PRIMARY KEY, observed_at TEXT NOT NULL, snapshot TEXT NOT NULL)");
}
export function persistEntryCapital(store: Store, tradeId: string, position: Position | undefined, meta: InstrumentInfo, equity: number, configuredLeverage: number): void {
  prepareCapitalStore(store);
  const trade = store.db.prepare("SELECT * FROM trades WHERE trade_id=?").get(tradeId) as Trade | undefined;
  if (!trade) return;
  const snapshot = positionCapital(trade, position, meta, equity, configuredLeverage);
  store.db.prepare("INSERT OR IGNORE INTO entry_capital(trade_id,observed_at,snapshot) VALUES(?,?,?)")
    .run(tradeId, new Date().toISOString(), JSON.stringify(snapshot));
}

/** Only the shipped linear USDT swaps have a supported cash-risk formula. */
export function linearContract(meta: InstrumentInfo | undefined): boolean {
  return Boolean(meta && meta.instId.endsWith("-USDT-SWAP") && meta.ctValCcy === meta.instId.split("-")[0]
    && (finite(meta.ctVal) ?? 0) > 0 && (finite(meta.lotSz) ?? 0) > 0);
}

export function positionCapital(trade: Trade, position: Position | undefined, meta: InstrumentInfo | undefined, equity: number | null, configuredLeverage: number) {
  const supported = linearContract(meta) && (!position || position.instId === meta?.instId)
    && (trade.instrument === undefined || trade.instrument === meta?.instId);
  const contracts = finite(position?.pos ?? trade.contracts);
  const entry = finite(trade.entry_px);
  const mark = finite(position?.markPx);
  const stop = finite(trade.stop_px);
  const initialStop = finite(trade.initial_stop_px ?? trade.stop_px);
  const quantity = supported && contracts !== null ? Math.abs(contracts) * Number(meta!.ctVal) : null;
  const rawNotional = finite(position?.notionalUsd);
  const actualNotional = rawNotional === null ? null : Math.abs(rawNotional);
  const estimatedNotional = quantity !== null && mark !== null ? quantity * mark : null;
  const leverage = finite(position?.lever);
  const mode = position?.mgnMode ?? "unknown";
  // Isolated margin is denominated in ccy; cross IMR is a requirement in USD,
  // not allocated collateral. Do not combine those into one 'margin used'.
  const actualMargin = mode === "isolated" && position?.ccy === "USDT" ? finite(position.margin) : null;
  const estimatedMargin = mode === "isolated" && supported && estimatedNotional !== null && leverage !== null && leverage > 0
    ? estimatedNotional / leverage : null;
  const margin = actualMargin ?? estimatedMargin;
  const direction = trade.side === "SHORT" ? -1 : trade.side === "LONG" ? 1 : null;
  const initialRisk = quantity !== null && entry !== null && initialStop !== null ? Math.abs(entry - initialStop) * quantity : null;
  const risk = quantity !== null && entry !== null && stop !== null && direction !== null ? Math.max(0, (entry - stop) * direction * quantity) : null;
  const potential = quantity !== null && mark !== null && stop !== null && direction !== null ? Math.max(0, (mark - stop) * direction * quantity) : null;
  return {
    actual_leverage: leverage, configured_leverage: configuredLeverage,
    leverage_mismatch: leverage !== null && leverage !== configuredLeverage,
    margin_mode: mode, margin_used: margin,
    margin_source: (actualMargin !== null ? "EXCHANGE" : estimatedMargin !== null ? "ESTIMATED" : "UNAVAILABLE") as ValueSource,
    margin_currency: margin !== null ? "USDT" : null,
    cross_imr_usd: mode === "cross" ? finite(position?.imr) : null,
    notional_usd: actualNotional, notional_usdt: estimatedNotional,
    notional: actualNotional ?? estimatedNotional,
    notional_currency: actualNotional !== null ? "USD" : estimatedNotional !== null ? "USDT" : null,
    notional_source: (actualNotional !== null ? "EXCHANGE" : estimatedNotional !== null ? "ESTIMATED" : "UNAVAILABLE") as ValueSource,
    risk_at_stop: risk, initial_risk: initialRisk, potential_loss_to_stop: potential,
    risk_pct: equity !== null && equity > 0 && initialRisk !== null ? initialRisk / equity * 100 : null,
    risk_source: risk === null ? "UNAVAILABLE" : "ESTIMATED",
    risk_note: "Price risk only; excludes fees, funding, slippage and gaps. Percentage uses current USDT equity.",
    mark_px: mark, upl: finite(position?.upl), live: Boolean(position),
    exchange_contracts: position?.pos ?? null,
  };
}

export function accountCapital(balance: AccountBalance | null, positions: Position[] | null, trades: Trade[], instruments: Record<string, InstrumentInfo>, leverage: number) {
  const usdt = balance?.details.find(row => row.ccy === "USDT");
  const equity = finite(usdt?.eq);
  const rows = positions?.filter(p => finite(p.pos) !== 0).map(p => {
    const trade = trades.find(t => t.instrument === p.instId && String(t.side).toLowerCase() === p.posSide);
    return { p, capital: positionCapital(trade ?? { side: p.posSide.toUpperCase() }, p, instruments[p.instId], equity, leverage) };
  });
  const sum = (values: Array<number | null> | undefined): number | null => values && values.every(v => v !== null) ? values.reduce<number>((a, b) => a + b!, 0) : null;
  const margin = sum(rows?.map(row => row.capital.margin_used));
  return {
    equity, available: finite(usdt?.availBal) ?? finite(usdt?.availEq), total_equity_usd: finite(balance?.totalEq),
    margin_used: margin, margin_currency: "USDT",
    margin_source: margin === null ? "UNAVAILABLE" : rows?.some(row => row.capital.margin_source === "ESTIMATED") ? "ESTIMATED" : "EXCHANGE",
    utilization_pct: equity !== null && equity > 0 && margin !== null ? margin / equity * 100 : null,
    notional_usd: sum(rows?.map(row => row.capital.notional_usd)),
    long_exposure_usd: sum(rows?.filter(row => row.p.posSide === "long").map(row => row.capital.notional_usd)),
    short_exposure_usd: sum(rows?.filter(row => row.p.posSide === "short").map(row => row.capital.notional_usd)),
    open_risk: sum(rows?.map(row => row.capital.risk_at_stop)),
    potential_loss_to_stop: sum(rows?.map(row => row.capital.potential_loss_to_stop)),
    exchange_positions: rows?.length ?? null,
    state: balance && positions ? "CURRENT" : "UNAVAILABLE",
    observed_at: new Date().toISOString(),
  };
}
