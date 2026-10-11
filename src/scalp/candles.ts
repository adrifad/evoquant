import type { Candle } from "../exchange/okx/types.ts";

/** Return the close of the latest confirmed candle, independent of exchange response order. */
export function latestConfirmedCandleClose(candles: readonly Candle[]): { close: number } | null {
  // getCandles preserves OKX's confirm flag; filter confirmed candles, sort oldest to newest,
  // then use the final candle so Sideways confirmation always uses the latest confirmed bar.
  const latest = candles
    .filter((candle) => candle.confirm === "1")
    .sort((a, b) => a.ts - b.ts)
    .at(-1);
  return latest ? { close: latest.c } : null;
}
