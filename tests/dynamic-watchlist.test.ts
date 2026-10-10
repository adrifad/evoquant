import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadTradingConfig } from "../src/core/config.ts";
import { DynamicWatchlistService, CORE_WATCHLIST, rankDynamicCandidates } from "../src/market/dynamic-watchlist.ts";
import { validationHistoriesFromTrading } from "../src/core/main.ts";
import { openStore } from "../src/memory/db.ts";
import type { Candle, InstrumentInfo } from "../src/exchange/okx/types.ts";
import type { Ticker } from "../src/exchange/okx/market.ts";
import type { OkxClient } from "../src/exchange/okx/client.ts";

const now = new Date("2026-10-10T01:00:00.000Z");
// Most fixture cases validate universe mechanics rather than final-score
// qualification. Threshold behavior has its own explicit regression below.
const config = { ...structuredClone(loadTradingConfig().dynamic_watchlist), filters: { ...structuredClone(loadTradingConfig().dynamic_watchlist).filters, min_trend_score: 0 } };
const instrument = (instId: string): InstrumentInfo => ({ instId, tickSz: "0.001", lotSz: "1", minSz: "1", ctVal: "1", ctValCcy: "USDT", state: "live", settleCcy: "USDT", listTime: now.getTime() - 20 * 86_400_000 });
const ticker = (instId: string, last = 100): Ticker => ({ instId, last, bidPx: last * 0.9995, askPx: last * 1.0005, ts: now.getTime(), volCcy24h: 50_000, vol24h: 50_000 });
function candles(direction = 1): Candle[] {
  return Array.from({ length: 80 }, (_, i) => { const c = 100 + direction * i * 0.25; return { ts: now.getTime() - (80 - i) * 3_600_000, o: c - direction * 0.1, h: c + 0.4, l: c - 0.4, c, vol: i === 79 ? 400 : 100, volCcy: i === 79 ? 400 : 100, confirm: "1" as const }; });
}
function raw(c: Candle): string[] { return [c.ts, c.o, c.h, c.l, c.c, c.vol, c.volCcy, "1"].map(String); }

test("deterministic rank keeps core out, accepts bullish and bearish quality trends, and never fills low quality slots", () => {
  const bull = instrument("SUI-USDT-SWAP"), bear = instrument("AVAX-USDT-SWAP"), low = instrument("TINY-USDT-SWAP"), wide = instrument("WIDE-USDT-SWAP"), invalid = { ...instrument("BAD-USDT-SWAP"), ctVal: "0" };
  const poorTicker = { ...ticker(low.instId), volCcy24h: 1 };
  const wideTicker = { ...ticker(wide.instId), bidPx: 90, askPx: 110 };
  const result = rankDynamicCandidates([
    { instrument: instrument("BTC-USDT-SWAP"), ticker: ticker("BTC-USDT-SWAP"), candles: candles(1) },
    { instrument: bull, ticker: ticker(bull.instId), candles: candles(1) },
    { instrument: bear, ticker: ticker(bear.instId), candles: candles(-1) },
    { instrument: low, ticker: poorTicker, candles: candles(1) },
    { instrument: wide, ticker: wideTicker, candles: candles(1) },
    { instrument: invalid, ticker: ticker(invalid.instId), candles: candles(1) },
  ], config, CORE_WATCHLIST, now);
  assert.deepEqual(result.selected.map((x) => x.symbol).sort(), ["AVAX-USDT-SWAP", "SUI-USDT-SWAP"]);
  assert.deepEqual(new Set(result.selected.map((x) => x.trendDirection)), new Set(["BULLISH", "BEARISH"]));
  assert.ok(result.selected.every((x) => x.score >= 0 && x.score <= 100));
  assert.ok((result.rejected.LOW_LIQUIDITY ?? 0) >= 1);
  assert.ok((result.rejected.SPREAD_OR_PRICE ?? 0) >= 1);
  assert.ok((result.rejected.INVALID_METADATA ?? 0) >= 1);
  const repeat = rankDynamicCandidates([{ instrument: bull, ticker: ticker(bull.instId), candles: candles(1) }, { instrument: bear, ticker: ticker(bear.instId), candles: candles(-1) }], config, CORE_WATCHLIST, now);
  assert.deepEqual(repeat.selected, result.selected);
});

test("selection is capped at eight dynamic names and the entry universe at fifteen", () => {
  const candidates = Array.from({ length: 12 }, (_, index) => {
    const item = instrument(`DYN${index}-USDT-SWAP`);
    return { instrument: item, ticker: ticker(item.instId, 100 + index), candles: candles(index % 2 ? -1 : 1) };
  });
  const ranked = rankDynamicCandidates(candidates, config, CORE_WATCHLIST, now);
  assert.equal(ranked.selected.length, 8);
  assert.equal(new Set(ranked.selected.map((entry) => entry.symbol)).size, 8);
  assert.ok(ranked.selected.every((entry) => !CORE_WATCHLIST.includes(entry.symbol as typeof CORE_WATCHLIST[number])));
});

test("minimum final trend score rejects weak candidates without filling slots", () => {
  const ranked = rankDynamicCandidates([
    { instrument: instrument("HIGH-USDT-SWAP"), ticker: ticker("HIGH-USDT-SWAP"), candles: candles(1) },
    { instrument: instrument("LOW-USDT-SWAP"), ticker: ticker("LOW-USDT-SWAP"), candles: candles(1) },
  ], { ...config, filters: { ...config.filters, min_trend_score: 60 } }, CORE_WATCHLIST, now);
  assert.ok(ranked.selected.every((entry) => entry.score >= 60));
  assert.ok((ranked.rejected.TREND_SCORE_TOO_LOW ?? 0) + ranked.selected.length === 2);
});

function fixture(t: test.TestContext) {
  const root = mkdtempSync(path.join(os.tmpdir(), "evoq-dynamic-watchlist-")); const store = openStore(root);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const all = [...CORE_WATCHLIST.map(instrument), instrument("SUI-USDT-SWAP"), instrument("AVAX-USDT-SWAP")];
  let universe = 0, tickers = 0, candlesCalls = 0, current = new Date(now);
  const client = { get: async <T>(url: string, query?: Record<string, unknown>) => {
    if (url === "/api/v5/public/instruments") {
      if (!query?.instId) { universe++; return all.map((x) => ({ ...x, listTime: String(x.listTime) })) as T; }
      return all.filter((x) => x.instId === query.instId).map((x) => ({ ...x, listTime: String(x.listTime) })) as T;
    }
    if (url === "/api/v5/market/tickers") { tickers++; return [...CORE_WATCHLIST.map((id) => ticker(id)), ticker("SUI-USDT-SWAP"), ticker("AVAX-USDT-SWAP")] as T; }
    if (url === "/api/v5/market/candles") { candlesCalls++; return candles(String(query?.instId).startsWith("AVAX") ? -1 : 1).map(raw) as T; }
    throw new Error(`unexpected ${url}`);
  }, post: async () => { throw new Error("no mutation"); } } as unknown as OkxClient;
  const service = () => new DynamicWatchlistService({ store, client, config, now: () => new Date(current), sleep: async () => {} });
  return { store, service, setNow: (value: Date) => { current = value; }, counts: () => ({ universe, tickers, candlesCalls }) };
}

test("automatic discovery runs once per UTC day, restart reuses snapshot, and core remains permanent", async t => {
  const f = fixture(t); const first = f.service(); await first.initialize();
  assert.equal(first.currentEntryUniverse().length, 9);
  assert.deepEqual(first.currentEntryUniverse().slice(0, 7), [...CORE_WATCHLIST]);
  assert.equal(f.counts().universe, 1); assert.equal(f.counts().tickers, 1);
  assert.equal(first.projection().statistics.requestCount, 4);
  for (let i = 0; i < 100; i++) await first.refreshIfDue();
  assert.equal(f.counts().universe, 1, "ordinary cycles do not rediscover the universe");
  const before = f.counts(); const restarted = f.service(); await restarted.initialize();
  assert.equal(f.counts().universe, before.universe, "same-day restart performs zero full universe discovery calls");
  assert.equal(f.counts().tickers, before.tickers);
  f.setNow(new Date("2026-10-11T01:00:00.000Z"));
  const nextDay = f.service(); await nextDay.initialize();
  assert.equal(f.counts().universe, before.universe + 1, "the next UTC date triggers exactly one new discovery cycle");
  assert.ok(restarted.currentActiveUniverse(["SUI-USDT-SWAP"]).includes("SUI-USDT-SWAP"));
});

test("failed daily discovery preserves prior dynamic selection as stale and manual refresh is audited", async t => {
  const f = fixture(t); const service = f.service(); await service.initialize();
  const tomorrow = new Date("2026-10-11T01:00:00.000Z");
  const broken = new DynamicWatchlistService({ store: f.store, client: { get: async () => { throw new Error("temporary OKX outage"); }, post: async () => { throw new Error("no mutation"); } } as unknown as OkxClient, config, now: () => tomorrow, sleep: async () => {} });
  await broken.initialize();
  assert.equal(broken.projection().status, "STALE");
  assert.equal(broken.currentEntryUniverse().length, 9);
  const events = f.store.db.prepare("SELECT kind FROM system_events WHERE kind='DYNAMIC_WATCHLIST_STALE'").all() as Array<{ kind: string }>;
  assert.equal(events.length, 1);
  await service.refreshManual();
  const manual = f.store.db.prepare("SELECT source,status FROM dynamic_watchlist_runs WHERE source='MANUAL' ORDER BY id DESC LIMIT 1").get() as { source: string; status: string };
  assert.deepEqual(manual, { source: "MANUAL", status: "SUCCESS" });
});

test("disabled mode retains snapshots for audit but admits only core entries and still manages an old open symbol", async t => {
  const f = fixture(t); const enabled = f.service(); await enabled.initialize();
  const disabledConfig = { ...config, enabled: false };
  const disabled = new DynamicWatchlistService({ store: f.store, client: { get: async () => { throw new Error("disabled must not discover"); }, post: async () => { throw new Error("no mutation"); } } as unknown as OkxClient, config: disabledConfig, now: () => now });
  await disabled.initialize();
  disabled.setManagementSymbols(["SUI-USDT-SWAP"]);
  assert.deepEqual(disabled.currentEntryUniverse(), [...CORE_WATCHLIST]);
  assert.ok(disabled.currentManagementUniverse().includes("SUI-USDT-SWAP"));
  assert.equal(disabled.projection().status, "DISABLED");
  assert.ok(disabled.projection().historical_dynamic?.some(entry => entry.symbol === "SUI-USDT-SWAP"));
  await assert.rejects(() => disabled.refreshManual(), (error: unknown) => error instanceof Error && error.message === "DYNAMIC_WATCHLIST_DISABLED");
});

test("one candle failure is recorded per symbol while the daily discovery stays current", async t => {
  const root = mkdtempSync(path.join(os.tmpdir(), "evoq-dynamic-partial-")); const store = openStore(root); t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const all = [...CORE_WATCHLIST.map(instrument), instrument("SUI-USDT-SWAP"), instrument("AVAX-USDT-SWAP")];
  const client = { get: async <T>(url: string, query?: Record<string, unknown>) => {
    if (url === "/api/v5/public/instruments") return (query?.instId ? all.filter(item => item.instId === query.instId) : all).map(item => ({ ...item, listTime: String(item.listTime) })) as T;
    if (url === "/api/v5/market/tickers") return all.map(item => ticker(item.instId)) as T;
    if (url === "/api/v5/market/candles") { if (query?.instId === "AVAX-USDT-SWAP") throw new Error("timeout"); return candles(1).map(raw) as T; }
    throw new Error(url);
  }, post: async () => { throw new Error("no mutation"); } } as unknown as OkxClient;
  const service = new DynamicWatchlistService({ store, client, config, now: () => now, sleep: async () => {} }); await service.initialize();
  const p = service.projection();
  assert.equal(p.status, "CURRENT");
  assert.equal(p.statistics.candleRequestsFailed, 1);
  assert.equal(p.statistics.candleRequestsSucceeded, 1);
  assert.equal(p.statistics.partialFailure, true);
  assert.ok(p.dynamic.every(entry => entry.symbol !== "AVAX-USDT-SWAP"));
});

test("exact persisted metadata is recovered for management without cross-symbol fallback", async t => {
  const f = fixture(t); const service = f.service(); await service.initialize();
  f.store.db.prepare("INSERT OR REPLACE INTO instruments(instId,instType,tickSz,lotSz,minSz,ctVal,ctValCcy,cached_ts) VALUES(?,?,?,?,?,?,?,?)")
    .run("OLD-USDT-SWAP", "SWAP", "0.01", "2", "2", "7", "OLD", new Date().toISOString());
  service.setManagementSymbols(["OLD-USDT-SWAP"]);
  assert.deepEqual(await service.hydrateManagementMetadata(["OLD-USDT-SWAP"]), []);
  const catalog: Record<string, InstrumentInfo> = {}; service.syncCatalog(catalog);
  assert.equal(catalog["OLD-USDT-SWAP"]?.ctVal, "7");
  assert.equal(catalog["OLD-USDT-SWAP"]?.instId, "OLD-USDT-SWAP");
});

test("short dynamic history cannot enter or shrink the stable Core validation universe", () => {
  const hour = 3_600_000;
  const coreHistory = Array.from({ length: 24 * 180 }, (_, index) => ({ ts: index * hour })) as Candle[];
  const dynamicHistory = Array.from({ length: 24 * 3 }, (_, index) => ({ ts: index * hour })) as Candle[];
  const validated = validationHistoriesFromTrading(new Map([["BTC-USDT-SWAP", coreHistory], ["SUI-USDT-SWAP", dynamicHistory]]));
  assert.deepEqual([...validated.keys()], ["BTC-USDT-SWAP"]);
  assert.equal(validated.get("BTC-USDT-SWAP")?.length, 24 * 180);
});
