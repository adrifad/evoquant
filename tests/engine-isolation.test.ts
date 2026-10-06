import test from "node:test";
import assert from "node:assert/strict";
import { evaluateGlobalEntryGate } from "../src/risk/global-entry-gate.ts";
import { isTradeOwnedBy, tradeEngine } from "../src/memory/engines.ts";
import type { RiskConfig } from "../src/core/config.ts";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { openStore } from "../src/memory/db.ts";
import { upsertLesson, addLessonEvidence, getActiveLessons } from "../src/memory/lessons.ts";

const risk = {
  hard_limits: { allowed_symbols: ["BTC-USDT-SWAP"], max_concurrent_positions: 3 },
} as RiskConfig;

test("shared global entry gate blocks PAUSED, kill switch, occupied symbols, and caps", () => {
  const input = { killSwitchActive: null, botState: "RUNNING" as const, openPositions: 0,
    instrument: "BTC-USDT-SWAP", instrumentOccupied: false };
  assert.equal(evaluateGlobalEntryGate(input, risk).allowed, true);
  assert.equal(evaluateGlobalEntryGate({ ...input, botState: "PAUSED" }, risk).reason, "BOT_PAUSED");
  assert.equal(evaluateGlobalEntryGate({ ...input, killSwitchActive: "MAX_DAILY_LOSS_REACHED" }, risk).allowed, false);
  assert.equal(evaluateGlobalEntryGate({ ...input, instrumentOccupied: true }, risk).reason, "INSTRUMENT_ALREADY_OCCUPIED");
  assert.equal(evaluateGlobalEntryGate({ ...input, openPositions: 3 }, risk).reason, "MAX_CONCURRENT_POSITIONS");
});

test("engine ownership is persisted-first with a deterministic legacy fallback", () => {
  assert.equal(tradeEngine({ timeframe: "scalp" }), "SCALP_5M");
  assert.equal(tradeEngine({ timeframe: "15m" }), "SWING_15M");
  const scalp = { engine: "SCALP_5M", timeframe: "scalp" };
  assert.equal(isTradeOwnedBy(scalp, "SCALP_5M"), true);
  assert.equal(isTradeOwnedBy(scalp, "SWING_15M"), false);
});

test("lesson evidence and retrieval cannot cross engine boundaries or guess legacy scope", () => {
  const store = openStore(mkdtempSync(path.join(os.tmpdir(), "evoq-lessons-")));
  store.db.prepare(`INSERT INTO trades(trade_id,engine,status,instrument,timeframe,side,strategy,strategy_version,regime,contracts,result_r,exit_ts)
    VALUES('SCALP-CLOSED','SCALP_5M','CLOSED','BTC-USDT-SWAP','scalp','LONG','SCALP',1,'SIDEWAYS','1',-1,'2026-10-01T00:00:00Z')`).run();
  const id = upsertLesson(store, { statement: "swing trend underperforms", confidence: 0.3,
    scope: { engine: "SWING_15M", strategy: "TREND_FOLLOWING", strategyVersion: 2, instrument: "BTC-USDT-SWAP" } });
  addLessonEvidence(store, id, "SCALP-CLOSED", true);
  assert.equal((store.db.prepare("SELECT COUNT(*) n FROM lesson_evidence WHERE lesson_id=?").get(id) as { n: number }).n, 0);
  store.db.prepare(`INSERT INTO lessons(lesson_id,statement,status,scope_strategy,confidence,observations)
    VALUES('LEGACY','old unscoped lesson','VERIFIED','TREND_FOLLOWING',1,50)`).run();
  assert.deepEqual(getActiveLessons(store, "BTC-USDT-SWAP", "SWING_15M"), []);
  store.close();
});
