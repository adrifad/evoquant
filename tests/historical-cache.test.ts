import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { kvGet, kvSet, openStore } from "../src/memory/db.ts";
import { DEFAULT_V2_PARAMS } from "../src/strategy/core-v2.ts";
import { createV2Challenger, ensureV2Registry } from "../src/strategy/v2-registry.ts";
import { DEFAULT_V2_COSTS } from "../src/evaluation/backtest.ts";
import { evaluateV2Lifecycle, historicalFingerprint, HISTORICAL_CACHE_REVISION, type V2PromotionCriteria } from "../src/evaluation/v2-promotion.ts";
import type { Candle } from "../src/exchange/okx/types.ts";

const symbol = "BTC-USDT-SWAP";
const version = { strategy: "TREND_FOLLOWING_V2" as const, version: 3, params: { ...DEFAULT_V2_PARAMS.TREND_FOLLOWING_V2, max_extension_atr: 0.8 } };
const ticks = new Map([[symbol, 0.1]]);
const criteria: V2PromotionCriteria = { historicalMinTrades: 10_000, outOfSampleMinTrades: 15, shadowForwardMinTrades: 15,
  championShadowMinTrades: 15, outOfSampleFraction: 0.3, minimumSymbols: 1, minPositiveSymbolFraction: 0.5,
  minPositiveWalkForwardFraction: 0.5, minimumWalkForwardFolds: 2, maxDrawdownDegradationPct: 0.5,
  requireOutOfSample: true, requireWalkForward: true, requireMultiSymbol: true, automaticPromotionEnabled: true };
function history(length = 1200): Map<string, Candle[]> {
  const price = (i: number) => 100 + 0.02 * i + 0.2 * Math.sin(i / 3);
  return new Map([[symbol, Array.from({ length }, (_, i) => {
    const o = price(i), c = price(i + 1);
    return { ts: Date.UTC(2025, 0, 1) + i * 900_000, o, c, h: Math.max(o, c) + 0.06, l: Math.min(o, c) - 0.06,
      vol: i % 5 === 0 ? 200 : 100, volCcy: 130, confirm: "1" as const };
  })]]);
}

test("fingerprints include every candle field, parameters, revision, costs, timeframe and tick size", () => {
  assert.ok(HISTORICAL_CACHE_REVISION >= 2);
  const source = history(3);
  const baseline = historicalFingerprint(version, source, "15m", DEFAULT_V2_COSTS, ticks);
  for (const field of ["ts", "o", "h", "l", "c", "vol", "volCcy", "confirm"] as const) {
    const candles = structuredClone(source.get(symbol)!);
    const middle = candles[1]!;
    if (field === "confirm") middle.confirm = "0";
    else middle[field] += 1;
    assert.notEqual(historicalFingerprint(version, new Map([[symbol, candles]]), "15m", DEFAULT_V2_COSTS, ticks), baseline, field);
  }
  assert.notEqual(historicalFingerprint({ ...version, params: { ...version.params, max_extension_atr: 0.9 } }, source, "15m", DEFAULT_V2_COSTS, ticks), baseline);
  assert.notEqual(historicalFingerprint(version, source, "5m", DEFAULT_V2_COSTS, ticks), baseline);
  assert.notEqual(historicalFingerprint(version, source, "15m", { ...DEFAULT_V2_COSTS, entryFeePct: 0.1 }, ticks), baseline);
  assert.notEqual(historicalFingerprint(version, source, "15m", DEFAULT_V2_COSTS, new Map([[symbol, 0.01]])), baseline);
  assert.notEqual(historicalFingerprint({ ...version, version: 4 }, source, "15m", DEFAULT_V2_COSTS, ticks), baseline);
  const two = new Map([...source, ["ETH-USDT-SWAP", source.get(symbol)!] as [string, Candle[]]]);
  assert.notEqual(historicalFingerprint(version, two, "15m", DEFAULT_V2_COSTS, ticks), historicalFingerprint(version, new Map([...two].reverse()), "15m", DEFAULT_V2_COSTS, ticks), "symbol order affects existing drawdown semantics");
});

test("real lifecycle cache survives reopen, preserves metrics and infinity, and recomputes corrupted entries", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "evoq-history-cache-"));
  let store = openStore(root);
  try {
    ensureV2Registry(store);
    createV2Challenger(store, { strategy: version.strategy, parentVersion: 2, params: version.params,
      changedParameter: "max_extension_atr", oldValue: 1.2, newValue: 0.8,
      hypothesis: "Exercise historical persistence with deterministic candles.", evidence: { evidenceCutoffTs: "2026-01-01T00:00:00.000Z" } });
    const source = history();
    const costs = { ...DEFAULT_V2_COSTS, entryFeePct: 0, exitFeePct: 0, spreadBps: 0, slippageBps: 0 };
    const evaluate = () => evaluateV2Lifecycle(store, source, "15m", costs, criteria, ticks);
    const original = evaluate();
    assert.ok(original[0]!.historicalTrades > 0, "fixture produces trades rather than a vacuous zero cache");
    assert.ok(original[0]!.outOfSampleTrades > 0);
    const slots = store.db.prepare("SELECT key,value FROM kv WHERE key LIKE 'historical_validation:%' ORDER BY key").all() as Array<{ key: string; value: string }>;
    assert.equal(slots.length, 4);
    assert.ok(slots.some(row => row.value.includes("__POSITIVE_INFINITY__")), "a real all-winning sample exercises the Infinity encoding");
    store.close(); store = openStore(root);
    store.db.exec(`CREATE TRIGGER forbid_cache_rewrite BEFORE UPDATE ON kv WHEN OLD.key LIKE 'historical_validation:%'
      BEGIN SELECT RAISE(ABORT, 'unexpected historical cache miss'); END`);
    assert.deepEqual(evaluate(), original, "cache reuse must preserve real lifecycle outputs after reopening SQLite");
    store.db.exec("DROP TRIGGER forbid_cache_rewrite");
    const selected = slots.find(row => row.key.endsWith(":3:train"))!;
    for (const corrupt of ["{broken", JSON.stringify({ ...JSON.parse(selected.value), value: { trades: 1, bySymbol: [] } }),
      JSON.stringify({ ...JSON.parse(selected.value), value: { ...JSON.parse(selected.value).value, folds: [null] } }),
      JSON.stringify({ ...JSON.parse(selected.value), value: { ...JSON.parse(selected.value).value,
        folds: JSON.parse(selected.value).value.folds.map((n: number) => n * 100) } })]) {
      kvSet(store, selected.key, corrupt);
      assert.deepEqual(evaluate(), original);
      assert.equal(kvGet(store, selected.key), selected.value, "bad cache must be replaced from source evidence");
    }
    source.get(symbol)![300]!.vol += 50;
    const changed = evaluate();
    const changedSlot = kvGet(store, selected.key)!;
    assert.notEqual(JSON.parse(changedSlot).fingerprint, JSON.parse(selected.value).fingerprint);
    store.db.prepare("DELETE FROM kv WHERE key LIKE 'historical_validation:%'").run();
    assert.deepEqual(evaluate(), changed, "recomputed and cached paths have identical results after source correction");
    assert.equal(kvGet(store, selected.key), changedSlot);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});
