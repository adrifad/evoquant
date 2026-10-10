// Deterministic market discovery. It chooses markets worth scanning, never a
// direction, order, stop, leverage, or size. Core symbols are permanent.
import type { TradingConfig } from "../core/config.ts";
import { createLogger } from "../core/logger.ts";
import { getCandles, getInstruments, getTickers, type Ticker } from "../exchange/okx/market.ts";
import type { OkxClient } from "../exchange/okx/client.ts";
import type { Candle, InstrumentInfo } from "../exchange/okx/types.ts";
import { adx, ema, toChronological } from "./indicators.ts";
import { logSystemEvent, type Store } from "../memory/db.ts";

const log = createLogger("dynamic-watchlist");
export const CORE_WATCHLIST = ["BTC-USDT-SWAP", "ETH-USDT-SWAP", "SOL-USDT-SWAP", "XRP-USDT-SWAP", "BNB-USDT-SWAP", "DOGE-USDT-SWAP", "ADA-USDT-SWAP"] as const;
export type TrendDirection = "BULLISH" | "BEARISH" | "NEUTRAL";
type Config = NonNullable<TradingConfig["dynamic_watchlist"]>;

export interface DynamicMetrics {
  momentum1hPct: number; momentum4hPct: number; adx14: number; emaSeparationPct: number;
  relativeVolume: number; spreadPct: number; liquidityUsdt: number;
}
export interface DynamicEntry { rank: number; symbol: string; score: number; trendDirection: TrendDirection; metrics: DynamicMetrics; instrument: InstrumentInfo; selectionReason: string; }
export interface WatchlistProjection {
  generated_at: string | null; stale: boolean; stale_age_ms: number | null; next_refresh: string;
  status: "CURRENT" | "STALE" | "UNAVAILABLE" | "DISABLED";
  core: Array<{ symbol: string; kind: "CORE" }>; dynamic: Array<{ rank: number; symbol: string; score: number; trend_direction: TrendDirection; metrics: DynamicMetrics; status: "DYNAMIC" }>;
  active: string[]; statistics: DiscoveryStats;
}
export interface DiscoveryStats { discovered: number; basic: number; analyzed: number; qualifying: number; selected: number; requestCount: number; durationMs: number; }
export interface RankedResult { selected: DynamicEntry[]; qualifying: number; rejected: Record<string, number>; }

const finitePositive = (n: number): boolean => Number.isFinite(n) && n > 0;
const bounded = (value: number, ceiling: number): number => Math.max(0, Math.min(100, value / ceiling * 100));
const pct = (a: number, b: number): number => (a / b - 1) * 100;
const utcDate = (now: Date): string => now.toISOString().slice(0, 10);
const asNum = (n: unknown): number | null => typeof n === "number" && Number.isFinite(n) ? n : null;

function technicalMetrics(candles: Candle[], ticker: Ticker): Omit<DynamicMetrics, "spreadPct" | "liquidityUsdt"> | null {
  const cs = toChronological(candles.filter((c) => c.confirm === "1"));
  if (cs.length < 60) return null;
  const closes = cs.map((c) => c.c), vols = cs.map((c) => c.volCcy > 0 ? c.volCcy : c.vol);
  const last = closes.at(-1)!, one = closes.at(-2)!, four = closes.at(-5)!;
  const e20 = ema(closes, 20).at(-1)!, e50 = ema(closes, 50).at(-1)!, strength = adx(cs, 14).adx.at(-1)!;
  const priorVolumes = vols.slice(-21, -1), avgVol = priorVolumes.reduce((a, b) => a + b, 0) / priorVolumes.length;
  const result = { momentum1hPct: pct(last, one), momentum4hPct: pct(last, four), adx14: strength,
    emaSeparationPct: Math.abs(e20 - e50) / last * 100, relativeVolume: avgVol > 0 ? vols.at(-1)! / avgVol : NaN };
  return Object.values(result).every(Number.isFinite) && finitePositive(last) && finitePositive(ticker.last) ? result : null;
}

/** Pure, input-order-independent scoring used by the daily job and regression tests. */
export function rankDynamicCandidates(input: Array<{ instrument: InstrumentInfo; ticker: Ticker; candles: Candle[] }>, cfg: Config, core: readonly string[] = CORE_WATCHLIST, now = new Date()): RankedResult {
  const rejected: Record<string, number> = {};
  const reject = (why: string) => { rejected[why] = (rejected[why] ?? 0) + 1; };
  const qualified: DynamicEntry[] = [];
  const minListing = now.getTime() - cfg.filters.min_listing_age_days * 86_400_000;
  for (const { instrument, ticker, candles } of input) {
    if (core.includes(instrument.instId)) { reject("CORE_SYMBOL"); continue; }
    if (!instrument.instId.endsWith("-USDT-SWAP") || instrument.state !== "live" || instrument.settleCcy !== "USDT") { reject("INVALID_METADATA"); continue; }
    if (!finitePositive(Number(instrument.tickSz)) || !finitePositive(Number(instrument.lotSz)) || !finitePositive(Number(instrument.minSz)) || !finitePositive(Number(instrument.ctVal))) { reject("INVALID_METADATA"); continue; }
    if (!Number.isFinite(instrument.listTime) || Number(instrument.listTime) > minListing) { reject("LISTING_TOO_NEW"); continue; }
    const mid = (ticker.bidPx + ticker.askPx) / 2, spreadPct = (ticker.askPx - ticker.bidPx) / mid * 100;
    // OKX SWAP volCcy24h is base currency, so price × base volume gives comparable USDT turnover.
    const liquidityUsdt = ticker.last * Number(ticker.volCcy24h);
    if (!finitePositive(mid) || !finitePositive(ticker.last) || ticker.askPx < ticker.bidPx || !Number.isFinite(spreadPct) || spreadPct > cfg.filters.max_spread_pct) { reject("SPREAD_OR_PRICE"); continue; }
    if (!Number.isFinite(liquidityUsdt) || liquidityUsdt < cfg.filters.min_liquidity_usdt) { reject("LOW_LIQUIDITY"); continue; }
    const metrics0 = technicalMetrics(candles, ticker);
    if (!metrics0) { reject("INSUFFICIENT_OR_INVALID_CANDLES"); continue; }
    // A broad discovery guard prevents one abnormal hourly move from taking rank #1.
    if (Math.abs(metrics0.momentum1hPct) > 20 || Math.abs(metrics0.momentum4hPct) > 35) { reject("EXTREME_EXTENSION"); continue; }
    const e20 = ema(toChronological(candles.filter((c) => c.confirm === "1")).map((c) => c.c), 20).at(-1)!;
    const e50 = ema(toChronological(candles.filter((c) => c.confirm === "1")).map((c) => c.c), 50).at(-1)!;
    const direction: TrendDirection = e20 > e50 && metrics0.momentum4hPct >= 0 ? "BULLISH" : e20 < e50 && metrics0.momentum4hPct <= 0 ? "BEARISH" : "NEUTRAL";
    if (direction === "NEUTRAL") { reject("NEUTRAL_TREND"); continue; }
    const score = 0.25 * bounded(metrics0.adx14, 40) + 0.20 * bounded(Math.abs(metrics0.momentum4hPct), 10)
      + 0.15 * bounded(Math.abs(metrics0.momentum1hPct), 4) + 0.15 * bounded(Math.max(0, metrics0.relativeVolume - 1), 2)
      + 0.10 * bounded(metrics0.emaSeparationPct, 2) + 0.10 * bounded(Math.log10(liquidityUsdt / cfg.filters.min_liquidity_usdt + 1), Math.log10(51))
      + 0.05 * Math.max(0, 100 * (1 - spreadPct / cfg.filters.max_spread_pct));
    if (!Number.isFinite(score)) { reject("INVALID_SCORE"); continue; }
    qualified.push({ rank: 0, symbol: instrument.instId, score: Math.round(score * 100) / 100, trendDirection: direction,
      metrics: { ...metrics0, spreadPct, liquidityUsdt }, instrument, selectionReason: "QUALITY_AND_TREND_SCORE" });
  }
  qualified.sort((a, b) => b.score - a.score || a.symbol.localeCompare(b.symbol));
  return { selected: qualified.slice(0, Math.min(cfg.dynamic_slots, cfg.max_total_symbols - core.length)).map((v, index) => ({ ...v, rank: index + 1 })), qualifying: qualified.length, rejected };
}

async function boundedMap<T, R>(values: readonly T[], limit: number, work: (value: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(values.length); let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, async () => {
    for (;;) { const index = next++; if (index >= values.length) return; out[index] = await work(values[index]!); }
  }));
  return out;
}

export class DynamicWatchlistService {
  private entries: DynamicEntry[] = []; private catalog: Record<string, InstrumentInfo> = {}; private generatedAt: string | null = null;
  private stale = false; private lastStats: DiscoveryStats = { discovered: 0, basic: 0, analyzed: 0, qualifying: 0, selected: 0, requestCount: 0, durationMs: 0 };
  private readonly core: string[]; private readonly now: () => Date;
  private readonly d: { store: Store; client: OkxClient; config: Config; core?: readonly string[]; now?: () => Date; sleep?: (ms: number) => Promise<void> };
  constructor(d: { store: Store; client: OkxClient; config: Config; core?: readonly string[]; now?: () => Date; sleep?: (ms: number) => Promise<void> }) {
    this.d = d;
    this.core = [...(d.core ?? CORE_WATCHLIST)]; this.now = d.now ?? (() => new Date());
  }
  async initialize(): Promise<void> {
    await this.loadLatest();
    const today = utcDate(this.now());
    const todaySuccess = this.d.store.db.prepare("SELECT 1 FROM dynamic_watchlist_snapshots WHERE snapshot_date=? ORDER BY id DESC LIMIT 1").get(today);
    if (!todaySuccess && this.d.config.enabled) await this.refreshAutomatic();
    await this.loadCoreMetadata();
  }
  currentEntryUniverse(): string[] { return [...new Set([...this.core, ...this.entries.map((e) => e.symbol)])].slice(0, this.d.config.max_total_symbols); }
  currentActiveUniverse(openSymbols: readonly string[] = []): string[] { return [...new Set([...this.currentEntryUniverse(), ...openSymbols])]; }
  metadata(): Record<string, InstrumentInfo> { return { ...this.catalog }; }
  syncCatalog(target: Record<string, InstrumentInfo>): void { Object.assign(target, this.catalog); }
  applyRiskAllowlist(allowed: string[]): void { allowed.splice(0, allowed.length, ...this.currentEntryUniverse()); }
  projection(): WatchlistProjection {
    const age = this.generatedAt ? Math.max(0, this.now().getTime() - Date.parse(this.generatedAt)) : null;
    const status = !this.d.config.enabled ? "DISABLED" : this.generatedAt ? (this.stale ? "STALE" : "CURRENT") : "UNAVAILABLE";
    return { generated_at: this.generatedAt, stale: this.stale, stale_age_ms: age, status, next_refresh: this.nextRefresh().toISOString(),
      core: this.core.map((symbol) => ({ symbol, kind: "CORE" })), dynamic: this.entries.map((e) => ({ rank: e.rank, symbol: e.symbol, score: e.score, trend_direction: e.trendDirection, metrics: e.metrics, status: "DYNAMIC" })),
      active: this.currentEntryUniverse(), statistics: this.lastStats };
  }
  async refreshAutomatic(): Promise<void> { if (this.automaticAlreadyAttempted()) return; await this.discover("AUTOMATIC"); }
  async refreshManual(): Promise<WatchlistProjection> { await this.discover("MANUAL"); return this.projection(); }
  async refreshIfDue(): Promise<void> { const now = this.now(), threshold = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), this.d.config.refresh_hour_utc, this.d.config.refresh_minute_utc)); if (now >= threshold) await this.refreshAutomatic(); }
  private automaticAlreadyAttempted(): boolean {
    const date = utcDate(this.now());
    // A successful manual refresh is today's authoritative selection; an
    // automatic failure is also terminal until tomorrow to avoid hammering OKX.
    return Boolean(this.d.store.db.prepare("SELECT 1 FROM dynamic_watchlist_snapshots WHERE snapshot_date=? LIMIT 1").get(date)
      ?? this.d.store.db.prepare("SELECT 1 FROM dynamic_watchlist_runs WHERE snapshot_date=? AND source='AUTOMATIC' AND status='FAILED' LIMIT 1").get(date));
  }
  private async loadCoreMetadata(): Promise<void> {
    const missing = this.core.filter((symbol) => !this.catalog[symbol]);
    for (const symbol of missing) {
      try { const item = (await getInstruments(this.d.client, "SWAP", symbol))[0]; if (item) this.catalog[symbol] = item; }
      catch (error) { log.warn({ event: "core_metadata_unavailable", symbol, error: error instanceof Error ? error.message.slice(0, 100) : "UNKNOWN" }); }
    }
  }
  private async loadLatest(): Promise<void> {
    const snap = this.d.store.db.prepare("SELECT id,generated_at,snapshot_date FROM dynamic_watchlist_snapshots ORDER BY generated_at DESC,id DESC LIMIT 1").get() as { id: number; generated_at: string; snapshot_date: string } | undefined;
    if (!snap) return;
    const rows = this.d.store.db.prepare("SELECT rank,symbol,score,trend_direction,metrics_json,instrument_json,selection_reason FROM dynamic_watchlist_entries WHERE snapshot_id=? ORDER BY rank").all(snap.id) as Array<Record<string, string | number>>;
    this.entries = rows.map((row) => ({ rank: Number(row.rank), symbol: String(row.symbol), score: Number(row.score), trendDirection: String(row.trend_direction) as TrendDirection,
      metrics: JSON.parse(String(row.metrics_json)) as DynamicMetrics, instrument: JSON.parse(String(row.instrument_json)) as InstrumentInfo, selectionReason: String(row.selection_reason ?? "QUALITY_AND_TREND_SCORE") }));
    for (const e of this.entries) this.catalog[e.symbol] = e.instrument;
    this.generatedAt = snap.generated_at; this.stale = snap.snapshot_date !== utcDate(this.now());
  }
  private async discover(source: "AUTOMATIC" | "MANUAL"): Promise<void> {
    const started = Date.now(); const date = utcDate(this.now()); logSystemEvent(this.d.store, source === "MANUAL" ? "DYNAMIC_WATCHLIST_MANUAL_REFRESH" : "DYNAMIC_WATCHLIST_REFRESH_STARTED", { source, date });
    let attempts = 0;
    try {
      let result: { all: InstrumentInfo[]; tickers: Ticker[]; selected: DynamicEntry[]; basic: number; analyzed: number; qualifying: number; requests: number } | undefined;
      while (attempts < 2 && !result) {
        attempts++;
        try { result = await this.discoverOnce(); }
        catch (error) { if (attempts < 2) await (this.d.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms))))(250); else throw error; }
      }
      const data = result!;
      // Keep only executable/current metadata plus previously known symbols so
      // a position removed from tomorrow's selection can still be managed.
      const byId = new Map(data.all.map((item) => [item.instId, item]));
      for (const symbol of [...this.core, ...data.selected.map((entry) => entry.symbol)]) {
        const item = byId.get(symbol); if (item) this.catalog[symbol] = item;
      }
      this.entries = data.selected; this.generatedAt = this.now().toISOString(); this.stale = false;
      this.lastStats = { discovered: data.all.length, basic: data.basic, analyzed: data.analyzed, qualifying: data.qualifying, selected: data.selected.length, requestCount: data.requests, durationMs: Date.now() - started };
      this.persistSuccess(date, source); logSystemEvent(this.d.store, "DYNAMIC_WATCHLIST_REFRESH_COMPLETED", { source, selectedSymbols: this.entries.map((e) => e.symbol), ...this.lastStats, rejectedCount: Math.max(0, data.all.length - this.core.length - data.qualifying) });
    } catch (error) {
      this.persistFailure(date, source, attempts, Date.now() - started, error); this.stale = this.entries.length > 0;
      logSystemEvent(this.d.store, "DYNAMIC_WATCHLIST_REFRESH_FAILED", { source, reason: error instanceof Error ? error.message.slice(0, 180) : "UNKNOWN", stale: this.stale });
      if (this.stale) logSystemEvent(this.d.store, "DYNAMIC_WATCHLIST_STALE", { generatedAt: this.generatedAt, ageMs: this.generatedAt ? Date.now() - Date.parse(this.generatedAt) : null });
    }
  }
  private async discoverOnce() {
    const all = await getInstruments(this.d.client, "SWAP"); const tickers = await getTickers(this.d.client, "SWAP");
    const tickerBySymbol = new Map(tickers.map((ticker) => [ticker.instId, ticker]));
    const cfg = this.d.config, now = this.now(), listingMin = now.getTime() - cfg.filters.min_listing_age_days * 86_400_000;
    const basic = all.filter((i) => !this.core.includes(i.instId) && i.instId.endsWith("-USDT-SWAP") && i.state === "live" && i.settleCcy === "USDT" && Number(i.listTime) <= listingMin && finitePositive(Number(i.tickSz)) && finitePositive(Number(i.lotSz)) && finitePositive(Number(i.minSz)) && finitePositive(Number(i.ctVal))).map((i) => ({ instrument: i, ticker: tickerBySymbol.get(i.instId)! })).filter(({ ticker }) => {
      const mid = (ticker?.bidPx + ticker?.askPx) / 2, spread = (ticker?.askPx - ticker?.bidPx) / mid, liquidity = ticker?.last * Number(ticker?.volCcy24h);
      return !!ticker && finitePositive(mid) && ticker.askPx >= ticker.bidPx && spread * 100 <= cfg.filters.max_spread_pct && Number.isFinite(liquidity) && liquidity >= cfg.filters.min_liquidity_usdt;
    }).sort((a, b) => (b.ticker.last * Number(b.ticker.volCcy24h)) - (a.ticker.last * Number(a.ticker.volCcy24h))).slice(0, cfg.filters.candidate_analysis_limit);
    const analyzed = await boundedMap(basic, 4, async ({ instrument, ticker }) => ({ instrument, ticker, candles: await getCandles(this.d.client, instrument.instId, "1H", 80) }));
    const ranked = rankDynamicCandidates(analyzed, cfg, this.core, now);
    return { all, tickers, selected: ranked.selected, basic: basic.length, analyzed: analyzed.length, qualifying: ranked.qualifying, requests: 2 + analyzed.length };
  }
  private persistSuccess(date: string, source: string): void {
    const generatedAt = this.generatedAt!;
    this.d.store.db.transaction(() => {
      const run = this.d.store.db.prepare("INSERT INTO dynamic_watchlist_runs(snapshot_date,generated_at,source,status,attempts,candidate_count,analyzed_count,qualifying_count,selected_count,request_count,duration_ms) VALUES(?,?,?,?,?,?,?,?,?,?,?)")
        .run(date, generatedAt, source, "SUCCESS", 1, this.lastStats.basic, this.lastStats.analyzed, this.lastStats.qualifying, this.lastStats.selected, this.lastStats.requestCount, this.lastStats.durationMs);
      void run;
      const snapshot = this.d.store.db.prepare("INSERT INTO dynamic_watchlist_snapshots(snapshot_date,generated_at,source,status) VALUES(?,?,?,?)").run(date, generatedAt, source, "SUCCESS");
      const insert = this.d.store.db.prepare("INSERT INTO dynamic_watchlist_entries(snapshot_id,symbol,rank,score,trend_direction,selected,metrics_json,instrument_json,selection_reason) VALUES(?,?,?,?,?,?,?,?,?)");
      for (const e of this.entries) insert.run(snapshot.lastInsertRowid, e.symbol, e.rank, e.score, e.trendDirection, 1, JSON.stringify(e.metrics), JSON.stringify(e.instrument), e.selectionReason);
    })();
  }
  private persistFailure(date: string, source: string, attempts: number, durationMs: number, error: unknown): void {
    this.d.store.db.prepare("INSERT INTO dynamic_watchlist_runs(snapshot_date,generated_at,source,status,attempts,duration_ms,error_reason) VALUES(?,?,?,?,?,?,?)")
      .run(date, this.now().toISOString(), source, "FAILED", attempts, durationMs, error instanceof Error ? error.message.slice(0, 300) : "UNKNOWN");
  }
  private nextRefresh(): Date { const now = this.now(); let next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), this.d.config.refresh_hour_utc, this.d.config.refresh_minute_utc)); if (next <= now) next = new Date(next.getTime() + 86_400_000); return next; }
}
