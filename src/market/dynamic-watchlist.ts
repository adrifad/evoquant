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

export interface DynamicMetrics { momentum1hPct: number; momentum4hPct: number; adx14: number; emaSeparationPct: number; relativeVolume: number; spreadPct: number; liquidityUsdt: number; }
export interface DynamicEntry { rank: number; symbol: string; score: number; trendDirection: TrendDirection; metrics: DynamicMetrics; instrument: InstrumentInfo; selectionReason: string; }
export interface DiscoveryStats { discovered: number; basic: number; analyzed: number; qualifying: number; selected: number; requestCount: number; durationMs: number; universeRequests?: number; tickerRequests?: number; candleRequestsAttempted?: number; candleRequestsSucceeded?: number; candleRequestsFailed?: number; totalHttpAttempts?: number; jobAttempts?: number; partialFailure?: boolean; }
export interface WatchlistProjection { generated_at: string | null; stale: boolean; stale_age_ms: number | null; next_refresh: string; status: "CURRENT" | "STALE" | "UNAVAILABLE" | "DISABLED"; core: Array<{ symbol: string; kind: "CORE" }>; dynamic: Array<{ rank: number; symbol: string; score: number; trend_direction: TrendDirection; metrics: DynamicMetrics; status: "DYNAMIC" }>; historical_dynamic?: Array<{ rank: number; symbol: string; score: number; trend_direction: TrendDirection; metrics: DynamicMetrics; status: "HISTORICAL" }>; dynamic_selected?: string[]; entry_universe?: string[]; management_universe?: string[]; active: string[]; statistics: DiscoveryStats; }
export interface RankedResult { selected: DynamicEntry[]; qualifying: number; rejected: Record<string, number>; }
export class DynamicWatchlistError extends Error {
  readonly code: "DYNAMIC_WATCHLIST_DISABLED" | "DYNAMIC_WATCHLIST_REFRESH_FAILED";
  readonly httpStatus: 409 | 503;
  readonly staleSnapshotPreserved: boolean;
  constructor(code: "DYNAMIC_WATCHLIST_DISABLED" | "DYNAMIC_WATCHLIST_REFRESH_FAILED", httpStatus: 409 | 503, staleSnapshotPreserved: boolean) {
    super(code); this.name = "DynamicWatchlistError"; this.code = code; this.httpStatus = httpStatus; this.staleSnapshotPreserved = staleSnapshotPreserved;
  }
}
class DiscoveryTransportError extends Error {
  readonly universeRequests: number;
  readonly tickerRequests: number;
  constructor(message: string, universeRequests: number, tickerRequests: number) { super(message); this.name = "DiscoveryTransportError"; this.universeRequests = universeRequests; this.tickerRequests = tickerRequests; }
}

const finitePositive = (n: number): boolean => Number.isFinite(n) && n > 0;
const bounded = (value: number, ceiling: number): number => Math.max(0, Math.min(100, value / ceiling * 100));
const pct = (a: number, b: number): number => (a / b - 1) * 100;
const utcDate = (now: Date): string => now.toISOString().slice(0, 10);
const emptyStats = (): DiscoveryStats => ({ discovered: 0, basic: 0, analyzed: 0, qualifying: 0, selected: 0, requestCount: 0, durationMs: 0, universeRequests: 0, tickerRequests: 0, candleRequestsAttempted: 0, candleRequestsSucceeded: 0, candleRequestsFailed: 0, totalHttpAttempts: 0, jobAttempts: 0, partialFailure: false });
function validMeta(i: InstrumentInfo): boolean { return Boolean(i.instId && finitePositive(Number(i.tickSz)) && finitePositive(Number(i.lotSz)) && finitePositive(Number(i.minSz)) && finitePositive(Number(i.ctVal))); }
function technicalMetrics(candles: Candle[], ticker: Ticker): Omit<DynamicMetrics, "spreadPct" | "liquidityUsdt"> | null {
  const cs = toChronological(candles.filter((c) => c.confirm === "1")); if (cs.length < 60) return null;
  const closes = cs.map((c) => c.c), vols = cs.map((c) => c.volCcy > 0 ? c.volCcy : c.vol), last = closes.at(-1)!, one = closes.at(-2)!, four = closes.at(-5)!;
  const e20 = ema(closes, 20).at(-1)!, e50 = ema(closes, 50).at(-1)!, strength = adx(cs, 14).adx.at(-1)!, prior = vols.slice(-21, -1), average = prior.reduce((a, b) => a + b, 0) / prior.length;
  const result = { momentum1hPct: pct(last, one), momentum4hPct: pct(last, four), adx14: strength, emaSeparationPct: Math.abs(e20 - e50) / last * 100, relativeVolume: average > 0 ? vols.at(-1)! / average : NaN };
  return Object.values(result).every(Number.isFinite) && finitePositive(last) && finitePositive(ticker.last) ? result : null;
}

/** `volCcy24h` is SWAP base volume; price × volume is comparable USDT turnover. */
export function tickerLiquidityUsdt(ticker: Ticker): number { return ticker.last * Number(ticker.volCcy24h); }

/** Pure, input-order-independent scoring used by the daily job and regression tests. */
export function rankDynamicCandidates(input: Array<{ instrument: InstrumentInfo; ticker: Ticker; candles: Candle[] }>, cfg: Config, core: readonly string[] = CORE_WATCHLIST, now = new Date()): RankedResult {
  const rejected: Record<string, number> = {}, reject = (why: string) => { rejected[why] = (rejected[why] ?? 0) + 1; }, qualified: DynamicEntry[] = [], minListing = now.getTime() - cfg.filters.min_listing_age_days * 86_400_000;
  for (const { instrument, ticker, candles } of input) {
    if (core.includes(instrument.instId)) { reject("CORE_SYMBOL"); continue; }
    if (!instrument.instId.endsWith("-USDT-SWAP") || instrument.state !== "live" || instrument.settleCcy !== "USDT" || !validMeta(instrument)) { reject("INVALID_METADATA"); continue; }
    if (!Number.isFinite(instrument.listTime) || Number(instrument.listTime) > minListing) { reject("LISTING_TOO_NEW"); continue; }
    const mid = (ticker.bidPx + ticker.askPx) / 2, spreadPct = (ticker.askPx - ticker.bidPx) / mid * 100, liquidityUsdt = tickerLiquidityUsdt(ticker);
    if (!finitePositive(mid) || !finitePositive(ticker.last) || ticker.askPx < ticker.bidPx || !Number.isFinite(spreadPct) || spreadPct > cfg.filters.max_spread_pct) { reject("SPREAD_OR_PRICE"); continue; }
    if (!Number.isFinite(liquidityUsdt) || liquidityUsdt < cfg.filters.min_liquidity_usdt) { reject("LOW_LIQUIDITY"); continue; }
    const metrics = technicalMetrics(candles, ticker); if (!metrics) { reject("INSUFFICIENT_OR_INVALID_CANDLES"); continue; }
    if (Math.abs(metrics.momentum1hPct) > 20 || Math.abs(metrics.momentum4hPct) > 35) { reject("EXTREME_EXTENSION"); continue; }
    const closes = toChronological(candles.filter((c) => c.confirm === "1")).map((c) => c.c), e20 = ema(closes, 20).at(-1)!, e50 = ema(closes, 50).at(-1)!;
    const direction: TrendDirection = e20 > e50 && metrics.momentum4hPct >= 0 ? "BULLISH" : e20 < e50 && metrics.momentum4hPct <= 0 ? "BEARISH" : "NEUTRAL";
    if (direction === "NEUTRAL") { reject("NEUTRAL_TREND"); continue; }
    const score = 0.25 * bounded(metrics.adx14, 40) + 0.20 * bounded(Math.abs(metrics.momentum4hPct), 10) + 0.15 * bounded(Math.abs(metrics.momentum1hPct), 4) + 0.15 * bounded(Math.max(0, metrics.relativeVolume - 1), 2) + 0.10 * bounded(metrics.emaSeparationPct, 2) + 0.10 * bounded(Math.log10(liquidityUsdt / cfg.filters.min_liquidity_usdt + 1), Math.log10(51)) + 0.05 * Math.max(0, 100 * (1 - spreadPct / cfg.filters.max_spread_pct));
    if (!Number.isFinite(score)) { reject("INVALID_SCORE"); continue; }
    if (score < cfg.filters.min_trend_score) { reject("TREND_SCORE_TOO_LOW"); continue; }
    qualified.push({ rank: 0, symbol: instrument.instId, score: Math.round(score * 100) / 100, trendDirection: direction, metrics: { ...metrics, spreadPct, liquidityUsdt }, instrument, selectionReason: "QUALITY_AND_TREND_SCORE" });
  }
  qualified.sort((a, b) => b.score - a.score || a.symbol.localeCompare(b.symbol));
  return { selected: qualified.slice(0, Math.min(cfg.dynamic_slots, cfg.max_total_symbols - core.length)).map((entry, index) => ({ ...entry, rank: index + 1 })), qualifying: qualified.length, rejected };
}
async function boundedSettled<T, R>(values: readonly T[], limit: number, work: (value: T) => Promise<R>): Promise<Array<{ value: T; result?: R; error?: unknown }>> { const out: Array<{ value: T; result?: R; error?: unknown }> = new Array(values.length); let next = 0; await Promise.all(Array.from({ length: Math.min(limit, values.length) }, async () => { for (;;) { const index = next++; if (index >= values.length) return; const value = values[index]!; try { out[index] = { value, result: await work(value) }; } catch (error) { out[index] = { value, error }; } } })); return out; }

export class DynamicWatchlistService {
  private entries: DynamicEntry[] = []; private historicalEntries: DynamicEntry[] = []; private catalog: Record<string, InstrumentInfo> = {}; private managementSymbols: string[] = []; private generatedAt: string | null = null; private stale = false; private lastStats = emptyStats(); private readonly core: string[]; private readonly now: () => Date;
  private readonly d: { store: Store; client: OkxClient; config: Config; core?: readonly string[]; now?: () => Date; sleep?: (ms: number) => Promise<void> };
  constructor(d: { store: Store; client: OkxClient; config: Config; core?: readonly string[]; now?: () => Date; sleep?: (ms: number) => Promise<void> }) { this.d = d; this.core = [...(d.core ?? CORE_WATCHLIST)]; this.now = d.now ?? (() => new Date()); }
  async initialize(): Promise<void> { await this.loadLatest(); if (this.d.config.enabled && !this.automaticAlreadyAttempted()) await this.refreshAutomatic(); await this.loadCoreMetadata(); }
  setManagementSymbols(symbols: readonly string[]): void { this.managementSymbols = [...new Set(symbols.filter(Boolean))]; }
  currentEntryUniverse(): string[] { return [...new Set([...this.core, ...(this.d.config.enabled ? this.entries.map((entry) => entry.symbol) : [])])].slice(0, this.d.config.max_total_symbols); }
  currentManagementUniverse(extra: readonly string[] = []): string[] { return [...new Set([...this.currentEntryUniverse(), ...this.managementSymbols, ...extra])]; }
  /** compatibility alias: active has always meant the management universe. */
  currentActiveUniverse(openSymbols: readonly string[] = []): string[] { return this.currentManagementUniverse(openSymbols); }
  metadata(): Record<string, InstrumentInfo> { return { ...this.catalog }; }
  syncCatalog(target: Record<string, InstrumentInfo>): void { Object.assign(target, this.catalog); }
  applyRiskAllowlist(allowed: string[]): void { allowed.splice(0, allowed.length, ...this.currentEntryUniverse()); }
  async hydrateManagementMetadata(symbols: readonly string[]): Promise<string[]> {
    const unresolved: string[] = [];
    for (const symbol of [...new Set(symbols)]) {
      if (validMeta(this.catalog[symbol] ?? {} as InstrumentInfo)) continue;
      const cached = this.readCachedMetadata(symbol) ?? this.readSnapshotMetadata(symbol);
      if (cached && validMeta(cached)) { this.catalog[symbol] = cached; this.persistMetadata(cached); continue; }
      try { const exact = (await getInstruments(this.d.client, "SWAP", symbol)).find((item) => item.instId === symbol); if (exact && validMeta(exact)) { this.catalog[symbol] = exact; this.persistMetadata(exact); continue; } }
      catch (error) { log.warn({ event: "instrument_metadata_lookup_failed", symbol, error: error instanceof Error ? error.message.slice(0, 100) : "UNKNOWN" }); }
      unresolved.push(symbol); logSystemEvent(this.d.store, "STATE", { state: "STATE_UNCERTAIN", symbol, reason: "INSTRUMENT_METADATA_UNAVAILABLE" });
    }
    return unresolved;
  }
  projection(): WatchlistProjection {
    const age = this.generatedAt ? Math.max(0, this.now().getTime() - Date.parse(this.generatedAt)) : null, status = !this.d.config.enabled ? "DISABLED" : this.generatedAt ? (this.stale ? "STALE" : "CURRENT") : "UNAVAILABLE";
    const dynamic = this.entries.map((e) => ({ rank: e.rank, symbol: e.symbol, score: e.score, trend_direction: e.trendDirection, metrics: e.metrics, status: "DYNAMIC" as const })), historicalDynamic = this.historicalEntries.map((e) => ({ rank: e.rank, symbol: e.symbol, score: e.score, trend_direction: e.trendDirection, metrics: e.metrics, status: "HISTORICAL" as const })), entry = this.currentEntryUniverse(), management = this.currentManagementUniverse();
    return { generated_at: this.generatedAt, stale: this.stale, stale_age_ms: age, status, next_refresh: this.nextRefresh().toISOString(), core: this.core.map((symbol) => ({ symbol, kind: "CORE" })), dynamic, historical_dynamic: !this.d.config.enabled ? historicalDynamic : [], dynamic_selected: this.entries.map((entry) => entry.symbol), entry_universe: entry, management_universe: management, active: management, statistics: this.lastStats };
  }
  async refreshAutomatic(): Promise<void> { if (!this.d.config.enabled || this.automaticAlreadyAttempted()) return; await this.discover("AUTOMATIC", false); }
  async refreshManual(): Promise<WatchlistProjection> { if (!this.d.config.enabled) throw new DynamicWatchlistError("DYNAMIC_WATCHLIST_DISABLED", 409, this.historicalEntries.length > 0); await this.discover("MANUAL", true); return this.projection(); }
  async refreshIfDue(): Promise<void> { const now = this.now(), due = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), this.d.config.refresh_hour_utc, this.d.config.refresh_minute_utc)); if (now >= due) await this.refreshAutomatic(); }
  private automaticAlreadyAttempted(): boolean { const date = utcDate(this.now()); return Boolean(this.d.store.db.prepare("SELECT 1 FROM dynamic_watchlist_snapshots WHERE snapshot_date=? LIMIT 1").get(date) ?? this.d.store.db.prepare("SELECT 1 FROM dynamic_watchlist_runs WHERE snapshot_date=? AND source='AUTOMATIC' AND status='FAILED' LIMIT 1").get(date)); }
  private async loadCoreMetadata(): Promise<void> { await this.hydrateManagementMetadata(this.core); }
  private async loadLatest(): Promise<void> { const snap = this.d.store.db.prepare("SELECT id,generated_at,snapshot_date FROM dynamic_watchlist_snapshots ORDER BY generated_at DESC,id DESC LIMIT 1").get() as { id: number; generated_at: string; snapshot_date: string } | undefined; if (!snap) return; const rows = this.d.store.db.prepare("SELECT rank,symbol,score,trend_direction,metrics_json,instrument_json,selection_reason FROM dynamic_watchlist_entries WHERE snapshot_id=? ORDER BY rank").all(snap.id) as Array<Record<string, string | number>>; const entries = rows.map((row) => ({ rank: Number(row.rank), symbol: String(row.symbol), score: Number(row.score), trendDirection: String(row.trend_direction) as TrendDirection, metrics: JSON.parse(String(row.metrics_json)) as DynamicMetrics, instrument: JSON.parse(String(row.instrument_json)) as InstrumentInfo, selectionReason: String(row.selection_reason ?? "QUALITY_AND_TREND_SCORE") })); this.historicalEntries = entries; this.entries = this.d.config.enabled ? entries : []; for (const entry of entries) { this.catalog[entry.symbol] = entry.instrument; this.persistMetadata(entry.instrument); } this.generatedAt = snap.generated_at; this.stale = snap.snapshot_date !== utcDate(this.now()); }
  private async discover(source: "AUTOMATIC" | "MANUAL", throwOnFailure: boolean): Promise<void> {
    const started = Date.now(), date = utcDate(this.now()); logSystemEvent(this.d.store, source === "MANUAL" ? "DYNAMIC_WATCHLIST_MANUAL_REFRESH" : "DYNAMIC_WATCHLIST_REFRESH_STARTED", { source, date }); let attempts = 0, priorUniverseRequests = 0, priorTickerRequests = 0;
    try { let data: Awaited<ReturnType<DynamicWatchlistService["discoverOnce"]>> | undefined; while (!data && attempts < 2) { attempts++; try { data = await this.discoverOnce(); } catch (error) { if (error instanceof DiscoveryTransportError) { priorUniverseRequests += error.universeRequests; priorTickerRequests += error.tickerRequests; } if (attempts >= 2) throw error; await (this.d.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms))))(250); } } const result = data!, byId = new Map(result.all.map((item) => [item.instId, item])); for (const symbol of [...this.core, ...result.selected.map((entry) => entry.symbol)]) { const meta = byId.get(symbol); if (meta && validMeta(meta)) { this.catalog[symbol] = meta; this.persistMetadata(meta); } } this.entries = result.selected; this.historicalEntries = result.selected; this.generatedAt = this.now().toISOString(); this.stale = false; const stats = { ...result.stats, universeRequests: result.stats.universeRequests + priorUniverseRequests, tickerRequests: result.stats.tickerRequests + priorTickerRequests }; this.lastStats = { discovered: result.all.length, basic: result.basic, analyzed: result.analyzed, qualifying: result.qualifying, selected: result.selected.length, requestCount: stats.totalHttpAttempts + priorUniverseRequests + priorTickerRequests, durationMs: Date.now() - started, ...stats, totalHttpAttempts: stats.totalHttpAttempts + priorUniverseRequests + priorTickerRequests, jobAttempts: attempts }; this.persistSuccess(date, source); logSystemEvent(this.d.store, "DYNAMIC_WATCHLIST_REFRESH_COMPLETED", { source, selectedSymbols: this.entries.map((entry) => entry.symbol), ...this.lastStats, rejectedCount: Object.values(result.rejected).reduce((a, b) => a + b, 0) }); }
    catch (error) { this.persistFailure(date, source, attempts, Date.now() - started, error); this.stale = this.historicalEntries.length > 0; logSystemEvent(this.d.store, "DYNAMIC_WATCHLIST_REFRESH_FAILED", { source, reason: error instanceof Error ? error.message.slice(0, 180) : "UNKNOWN", stale: this.stale }); if (this.stale) logSystemEvent(this.d.store, "DYNAMIC_WATCHLIST_STALE", { generatedAt: this.generatedAt, ageMs: this.generatedAt ? Date.now() - Date.parse(this.generatedAt) : null }); if (throwOnFailure) throw new DynamicWatchlistError("DYNAMIC_WATCHLIST_REFRESH_FAILED", 503, this.stale); }
  }
  private async discoverOnce() {
    let all: InstrumentInfo[], tickers: Ticker[];
    try { all = await getInstruments(this.d.client, "SWAP"); } catch (error) { throw new DiscoveryTransportError(error instanceof Error ? error.message : "INSTRUMENT_UNIVERSE_UNAVAILABLE", 1, 0); }
    try { tickers = await getTickers(this.d.client, "SWAP"); } catch (error) { throw new DiscoveryTransportError(error instanceof Error ? error.message : "TICKER_UNIVERSE_UNAVAILABLE", 1, 1); }
    const tickerBySymbol = new Map(tickers.map((ticker) => [ticker.instId, ticker])), cfg = this.d.config, now = this.now(), listingMin = now.getTime() - cfg.filters.min_listing_age_days * 86_400_000;
    const basic = all.filter((i) => !this.core.includes(i.instId) && i.instId.endsWith("-USDT-SWAP") && i.state === "live" && i.settleCcy === "USDT" && Number(i.listTime) <= listingMin && validMeta(i)).map((instrument) => ({ instrument, ticker: tickerBySymbol.get(instrument.instId) })).filter((row): row is { instrument: InstrumentInfo; ticker: Ticker } => { const ticker = row.ticker; if (!ticker) return false; const mid = (ticker.bidPx + ticker.askPx) / 2, spread = (ticker.askPx - ticker.bidPx) / mid * 100, liquidity = tickerLiquidityUsdt(ticker); return finitePositive(mid) && ticker.askPx >= ticker.bidPx && Number.isFinite(spread) && spread <= cfg.filters.max_spread_pct && Number.isFinite(liquidity) && liquidity >= cfg.filters.min_liquidity_usdt; }).sort((a, b) => tickerLiquidityUsdt(b.ticker) - tickerLiquidityUsdt(a.ticker)).slice(0, cfg.filters.candidate_analysis_limit);
    const settled = await boundedSettled(basic, 4, async ({ instrument, ticker }) => ({ instrument, ticker, candles: await getCandles(this.d.client, instrument.instId, "1H", 80) })); const successes = settled.filter((row): row is { value: { instrument: InstrumentInfo; ticker: Ticker }; result: { instrument: InstrumentInfo; ticker: Ticker; candles: Candle[] } } => Boolean(row.result)).map((row) => row.result), failed = settled.filter((row) => row.error); if (basic.length > 0 && successes.length === 0) throw new Error("DYNAMIC_WATCHLIST_CANDLE_ANALYSIS_UNAVAILABLE"); const ranked = rankDynamicCandidates(successes, cfg, this.core, now), rejected = { ...ranked.rejected, ...(failed.length ? { CANDLE_FETCH_FAILED: failed.length } : {}) };
    return { all, selected: ranked.selected, basic: basic.length, analyzed: successes.length, qualifying: ranked.qualifying, rejected, stats: { universeRequests: 1, tickerRequests: 1, candleRequestsAttempted: basic.length, candleRequestsSucceeded: successes.length, candleRequestsFailed: failed.length, totalHttpAttempts: 2 + basic.length, partialFailure: failed.length > 0 } };
  }
  private persistSuccess(date: string, source: string): void { const s = this.lastStats, generatedAt = this.generatedAt!; this.d.store.db.transaction(() => { this.d.store.db.prepare("INSERT INTO dynamic_watchlist_runs(snapshot_date,generated_at,source,status,attempts,candidate_count,analyzed_count,qualifying_count,selected_count,request_count,duration_ms,universe_requests,ticker_requests,candle_requests_attempted,candle_requests_succeeded,candle_requests_failed,total_http_attempts) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(date, generatedAt, source, "SUCCESS", s.jobAttempts ?? 1, s.basic, s.analyzed, s.qualifying, s.selected, s.requestCount, s.durationMs, s.universeRequests ?? 0, s.tickerRequests ?? 0, s.candleRequestsAttempted ?? 0, s.candleRequestsSucceeded ?? 0, s.candleRequestsFailed ?? 0, s.totalHttpAttempts ?? s.requestCount); const snapshot = this.d.store.db.prepare("INSERT INTO dynamic_watchlist_snapshots(snapshot_date,generated_at,source,status) VALUES(?,?,?,?)").run(date, generatedAt, source, "SUCCESS"); const insert = this.d.store.db.prepare("INSERT INTO dynamic_watchlist_entries(snapshot_id,symbol,rank,score,trend_direction,selected,metrics_json,instrument_json,selection_reason) VALUES(?,?,?,?,?,?,?,?,?)"); for (const e of this.entries) insert.run(snapshot.lastInsertRowid, e.symbol, e.rank, e.score, e.trendDirection, 1, JSON.stringify(e.metrics), JSON.stringify(e.instrument), e.selectionReason); })(); }
  private persistFailure(date: string, source: string, attempts: number, durationMs: number, error: unknown): void { this.d.store.db.prepare("INSERT INTO dynamic_watchlist_runs(snapshot_date,generated_at,source,status,attempts,duration_ms,error_reason) VALUES(?,?,?,?,?,?,?)").run(date, this.now().toISOString(), source, "FAILED", attempts, durationMs, error instanceof Error ? error.message.slice(0, 300) : "UNKNOWN"); }
  private persistMetadata(meta: InstrumentInfo): void { if (!validMeta(meta)) return; this.d.store.db.prepare("INSERT INTO instruments(instId,instType,tickSz,lotSz,minSz,ctVal,ctValCcy,state,settleCcy,listTime,cached_ts) VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(instId) DO UPDATE SET instType=excluded.instType,tickSz=excluded.tickSz,lotSz=excluded.lotSz,minSz=excluded.minSz,ctVal=excluded.ctVal,ctValCcy=excluded.ctValCcy,state=excluded.state,settleCcy=excluded.settleCcy,listTime=excluded.listTime,cached_ts=excluded.cached_ts").run(meta.instId, "SWAP", meta.tickSz, meta.lotSz, meta.minSz, meta.ctVal, meta.ctValCcy, meta.state ?? null, meta.settleCcy ?? null, meta.listTime ?? null, new Date().toISOString()); }
  private readCachedMetadata(symbol: string): InstrumentInfo | null { const row = this.d.store.db.prepare("SELECT instId,tickSz,lotSz,minSz,ctVal,ctValCcy,state,settleCcy,listTime FROM instruments WHERE instId=?").get(symbol) as InstrumentInfo | undefined; return row?.instId === symbol ? row : null; }
  private readSnapshotMetadata(symbol: string): InstrumentInfo | null { const row = this.d.store.db.prepare("SELECT instrument_json FROM dynamic_watchlist_entries WHERE symbol=? ORDER BY snapshot_id DESC LIMIT 1").get(symbol) as { instrument_json?: string } | undefined; if (!row?.instrument_json) return null; try { const meta = JSON.parse(row.instrument_json) as InstrumentInfo; return meta.instId === symbol ? meta : null; } catch { return null; } }
  private nextRefresh(): Date { const now = this.now(); let next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), this.d.config.refresh_hour_utc, this.d.config.refresh_minute_utc)); if (next <= now) next = new Date(next.getTime() + 86_400_000); return next; }
}
