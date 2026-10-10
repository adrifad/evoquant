import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { openStore } from "../src/memory/db.ts";
import { getLatestScanStates, recordScanState, recordScalpScanResult, recordSwingScanResults, scanStateKey } from "../src/market/scan-state.ts";
import type { ScanRow } from "../src/strategy/scanner.ts";

function fixture(t: test.TestContext) {
  const root = mkdtempSync(path.join(os.tmpdir(), "evoq-scan-state-"));
  let store = openStore(root);
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, get store() { return store; }, reopen: () => { store.close(); store = openStore(root); } };
}

test("Swing no-setup and candidate evaluations persist confirmed candle and deterministic setup fields", t => {
  const f = fixture(t);
  const rows = [
    { instrument: "BTC-USDT-SWAP", regime: "SIDEWAYS", price: 100, score: 0, strategy: null, tradable: false },
    { instrument: "ETH-USDT-SWAP", regime: "TRENDING_BULLISH", price: 200, score: 0.83, strategy: "TREND_FOLLOWING_V2", tradable: true,
      candidate: { strategy: "TREND_FOLLOWING_V2", side: "LONG", setupScore: 0.83 } },
  ] as unknown as ScanRow[];
  recordSwingScanResults(f.store, rows, new Map([["BTC-USDT-SWAP", 1_791_612_000_000], ["ETH-USDT-SWAP", 1_791_612_000_000]]), "2026-10-10T10:15:08.000Z");
  const states = getLatestScanStates(f.store, ["BTC-USDT-SWAP", "ETH-USDT-SWAP"]);
  const noSetup = states.get(scanStateKey("SWING_15M", "BTC-USDT-SWAP"))!;
  assert.equal(noSetup.result, "NO_SETUP");
  assert.equal(noSetup.last_scan_at, "2026-10-10T10:15:08.000Z");
  assert.equal(noSetup.last_success_at, "2026-10-10T10:15:08.000Z");
  assert.equal(noSetup.candle_ts, 1_791_612_000_000);
  assert.equal(noSetup.candle_timeframe, "15m");
  const candidate = states.get(scanStateKey("SWING_15M", "ETH-USDT-SWAP"))!;
  assert.equal(candidate.result, "CANDIDATE");
  assert.equal(candidate.strategy, "TREND_FOLLOWING_V2");
  assert.equal(candidate.side, "LONG");
  assert.equal(candidate.setup_score, 0.83);
});

test("fetch failure updates last attempt but preserves last successful scan time", t => {
  const f = fixture(t);
  recordScanState(f.store, { engine: "SWING_15M", instrument: "ETH-USDT-SWAP", scannedAt: "2026-10-10T10:00:00.000Z", candleTs: 1_791_611_100_000, result: "NO_SETUP" });
  recordScanState(f.store, { engine: "SWING_15M", instrument: "ETH-USDT-SWAP", scannedAt: "2026-10-10T10:15:08.000Z", result: "FETCH_FAILED", reason: "market_data_fetch_failed" });
  const state = getLatestScanStates(f.store, ["ETH-USDT-SWAP"]).get(scanStateKey("SWING_15M", "ETH-USDT-SWAP"))!;
  assert.equal(state.last_scan_at, "2026-10-10T10:15:08.000Z");
  assert.equal(state.last_success_at, "2026-10-10T10:00:00.000Z");
  assert.equal(state.result, "FETCH_FAILED");
  assert.equal(state.reason, "market_data_fetch_failed");
});

test("Scalp no-setup and signal states stay isolated from Swing state", t => {
  const f = fixture(t);
  recordScanState(f.store, { engine: "SWING_15M", instrument: "BTC-USDT-SWAP", scannedAt: "2026-10-10T10:15:00.000Z", candleTs: 1_791_612_000_000, result: "CANDIDATE", strategy: "TREND_FOLLOWING_V2", side: "LONG", setupScore: 0.8 });
  recordScalpScanResult(f.store, { instrument: "BTC-USDT-SWAP", scannedAt: "2026-10-10T10:20:00.000Z", candleTs: 1_791_612_300_000, candleTimeframe: "1m", veto: "regime:SIDEWAYS" });
  recordScalpScanResult(f.store, { instrument: "ETH-USDT-SWAP", scannedAt: "2026-10-10T10:20:00.000Z", candleTs: 1_791_612_300_000, candleTimeframe: "1m", signal: { direction: -1, score: 0.71 } });
  const states = getLatestScanStates(f.store, ["BTC-USDT-SWAP", "ETH-USDT-SWAP"]);
  assert.equal(states.get(scanStateKey("SWING_15M", "BTC-USDT-SWAP"))?.result, "CANDIDATE");
  assert.equal(states.get(scanStateKey("SCALP_5M", "BTC-USDT-SWAP"))?.result, "NO_SETUP");
  assert.equal(states.get(scanStateKey("SCALP_5M", "BTC-USDT-SWAP"))?.reason, "regime:SIDEWAYS");
  assert.equal(states.get(scanStateKey("SCALP_5M", "BTC-USDT-SWAP"))?.candle_timeframe, "1m");
  assert.equal(states.get(scanStateKey("SCALP_5M", "ETH-USDT-SWAP"))?.result, "SIGNAL");
  assert.equal(states.get(scanStateKey("SCALP_5M", "ETH-USDT-SWAP"))?.side, "SHORT");
});

test("scan state survives DB reopen and watchlist rotation", t => {
  const f = fixture(t);
  recordScanState(f.store, { engine: "SCALP_5M", instrument: "SUI-USDT-SWAP", scannedAt: "2026-10-10T10:20:00.000Z", candleTs: 1_791_612_300_000, result: "NO_SETUP", reason: "regime:SIDEWAYS" });
  f.reopen();
  assert.equal(getLatestScanStates(f.store, ["SUI-USDT-SWAP"]).get(scanStateKey("SCALP_5M", "SUI-USDT-SWAP"))?.result, "NO_SETUP");
  // A symbol leaving today's universe is not deleted; it is available if it returns later.
  assert.equal((f.store.db.prepare("SELECT COUNT(*) n FROM market_scan_state WHERE instrument=?").get("SUI-USDT-SWAP") as { n: number }).n, 1);
  assert.equal(getLatestScanStates(f.store, ["SUI-USDT-SWAP"]).get(scanStateKey("SCALP_5M", "SUI-USDT-SWAP"))?.reason, "regime:SIDEWAYS");
});
