// M1 scope item 4 — public market data endpoints.
// Spec §7.1 (server time), §7.2 (instruments), §7.3 (candles + confirm flag),
// §7.4 (history candles), §7.5 (ticker).
//
// OKX payloads are strings; conversion to numbers happens ONLY here, once.
// `confirm` stays the raw flag "0"|"1" — candle-close logic must filter on
// confirm === "1" (spec §7.3: only use completed candles).

import { firstOf, type OkxClient } from "./client.ts";
import type { Candle, InstrumentInfo } from "./types.ts";

export type InstrumentType = "SPOT" | "MARGIN" | "SWAP" | "FUTURES" | "OPTION";

export type Bar =
  | "1m"
  | "3m"
  | "5m"
  | "15m"
  | "30m"
  | "1H"
  | "2H"
  | "4H"
  | "6H"
  | "12H"
  | "1D"
  | "1W";

export interface Ticker {
  instId: string;
  last: number;
  bidPx: number;
  askPx: number;
  ts: number;
  volCcy24h?: number;
  vol24h?: number;
}

// Spec §7.1 — server time (epoch ms); used at startup and for clock drift.
export async function getServerTime(client: OkxClient): Promise<number> {
  const data = await client.get<Array<{ ts: string }>>("/api/v5/public/time");
  return Number(firstOf(data, "server time").ts);
}

// Spec §7.2 — instrument metadata (tickSz/lotSz/minSz/ctVal/ctValCcy).
// Cache before sizing any order; never assume sz = coin quantity.
export async function getInstruments(
  client: OkxClient,
  instType: InstrumentType = "SWAP",
  instId?: string,
): Promise<InstrumentInfo[]> {
  const data = await client.get<RawInstrument[]>("/api/v5/public/instruments", {
    instType,
    instId,
  });
  return data.map(mapInstrument);
}

interface RawInstrument {
  instId?: string;
  tickSz?: string;
  lotSz?: string;
  minSz?: string;
  ctVal?: string;
  ctValCcy?: string;
  state?: string;
  settleCcy?: string;
  listTime?: string;
}

function mapInstrument(raw: RawInstrument): InstrumentInfo {
  return {
    instId: String(raw.instId ?? ""),
    tickSz: String(raw.tickSz ?? ""),
    lotSz: String(raw.lotSz ?? ""),
    minSz: String(raw.minSz ?? ""),
    ctVal: String(raw.ctVal ?? ""),
    ctValCcy: String(raw.ctValCcy ?? ""),
    state: String(raw.state ?? ""),
    settleCcy: String(raw.settleCcy ?? ""),
    listTime: Number(raw.listTime),
  };
}

// Spec §7.5 — ticker: latest price / bid / ask sanity checks.
export async function getTicker(client: OkxClient, instId: string): Promise<Ticker> {
  const data = await client.get<RawTicker[]>("/api/v5/market/ticker", { instId });
  const raw = firstOf(data, `ticker ${instId}`);
  return {
    instId: String(raw.instId ?? instId),
    last: Number(raw.last),
    bidPx: Number(raw.bidPx),
    askPx: Number(raw.askPx),
    ts: Number(raw.ts),
    volCcy24h: Number(raw.volCcy24h),
    vol24h: Number(raw.vol24h),
  };
}

/** One batched SWAP ticker request for daily discovery. For derivatives,
 * volCcy24h is base-currency volume; callers normalize it using last price. */
export async function getTickers(client: OkxClient, instType: InstrumentType = "SWAP"): Promise<Ticker[]> {
  const data = await client.get<RawTicker[]>("/api/v5/market/tickers", { instType });
  return data.map((raw) => ({ instId: String(raw.instId ?? ""), last: Number(raw.last), bidPx: Number(raw.bidPx),
    askPx: Number(raw.askPx), ts: Number(raw.ts), volCcy24h: Number(raw.volCcy24h), vol24h: Number(raw.vol24h) }));
}

interface RawTicker {
  instId?: string;
  last?: string;
  bidPx?: string;
  askPx?: string;
  ts?: string;
  volCcy24h?: string;
  vol24h?: string;
}

// Spec §7.3 — candles. Raw row: [ts, o, h, l, c, vol, volCcy, (volCcyQuote),
// confirm]; history-candles omits volCcyQuote, so confirm is always the last
// field of the row.
function mapCandle(row: string[]): Candle {
  const confirm = row[row.length - 1] === "1" ? "1" : "0";
  return {
    ts: Number(row[0]),
    o: Number(row[1]),
    h: Number(row[2]),
    l: Number(row[3]),
    c: Number(row[4]),
    vol: Number(row[5]),
    volCcy: Number(row[6]),
    confirm,
  };
}

// Spec §7.3 — recent candles (newest first from OKX).
export async function getCandles(
  client: OkxClient,
  instId: string,
  bar: Bar,
  limit: number = 100,
): Promise<Candle[]> {
  const data = await client.get<string[][]>("/api/v5/market/candles", {
    instId,
    bar,
    limit,
  });
  return data.map(mapCandle);
}

// Spec §7.3/§7.4 — candle-close strategies use ONLY completed candles
// (confirm === "1"); returns the newest confirmed candle.
export async function latestClosedCandle(
  client: OkxClient,
  instId: string,
  bar: Bar,
): Promise<Candle> {
  const candles = await getCandles(client, instId, bar, 3);
  const closed = candles.filter((c) => c.confirm === "1");
  if (closed.length === 0) {
    throw new Error(`no confirmed (confirm === "1") candle for ${instId} ${bar}`);
  }
  return closed.reduce((a, b) => (b.ts > a.ts ? b : a));
}

// Spec §7.4 — historical candles (backtesting / warm-up / evaluation).
export async function getHistoryCandles(
  client: OkxClient,
  instId: string,
  bar: Bar,
  limit: number = 100,
  opts: { after?: number; before?: number } = {},
): Promise<Candle[]> {
  const data = await client.get<string[][]>("/api/v5/market/history-candles", {
    instId,
    bar,
    limit,
    after: opts.after,
    before: opts.before,
  });
  return data.map(mapCandle);
}

/** Paginate historical bars backward without exceeding OKX's 300-row page cap. */
export async function getHistoryCandlesPaged(
  client: OkxClient, instId: string, bar: Bar, sinceTs: number,
  options: { pageSize?: number; maxPages?: number; requestDelayMs?: number } = {},
): Promise<Candle[]> {
  const pageSize = Math.max(1, Math.min(300, Math.floor(options.pageSize ?? 300)));
  const maxPages = Math.max(1, Math.floor(options.maxPages ?? 1000));
  const delayMs = Math.max(0, options.requestDelayMs ?? 100);
  let cursor: number | undefined;
  let previousOldest = Number.POSITIVE_INFINITY;
  const byTs = new Map<number, Candle>();
  for (let page = 0; page < maxPages; page++) {
    const batch = await getHistoryCandles(client, instId, bar, pageSize, cursor === undefined ? {} : { after: cursor });
    if (batch.length === 0) break;
    for (const c of batch) if (c.ts >= sinceTs) byTs.set(c.ts, c);
    const oldest = Math.min(...batch.map((c) => c.ts));
    if (!(oldest < previousOldest) || oldest <= sinceTs || batch.length < pageSize) break;
    previousOldest = oldest;
    cursor = oldest;
    if (delayMs > 0) await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
  }
  return [...byTs.values()].sort((a, b) => a.ts - b.ts);
}
