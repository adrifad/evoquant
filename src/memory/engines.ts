export const TRADING_ENGINES = ["SWING_15M", "SCALP_5M"] as const;
export type TradingEngine = typeof TRADING_ENGINES[number];

export function isTradingEngine(value: unknown): value is TradingEngine {
  return typeof value === "string" && (TRADING_ENGINES as readonly string[]).includes(value);
}

// Historical V1 rows predate explicit engine ownership. Preserve their original
// timeframe and derive ownership once during migration using this stable rule.
export function inferTradingEngine(timeframe: unknown): TradingEngine {
  return String(timeframe).toLowerCase() === "scalp" ? "SCALP_5M" : "SWING_15M";
}

export function tradeEngine(row: { engine?: unknown; timeframe?: unknown }): TradingEngine {
  return isTradingEngine(row.engine) ? row.engine : inferTradingEngine(row.timeframe);
}

export function isTradeOwnedBy(row: { engine?: unknown; timeframe?: unknown }, engine: TradingEngine): boolean {
  return tradeEngine(row) === engine;
}
