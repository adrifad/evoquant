// M2-M7 deterministic core tests — indicators, regime, risk engine, sizing,
// kill switches, backtest, lessons, weights, calibration, promotion, DB.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { ema, rsi, atr, adx } from "../src/market/indicators.ts";
import { buildFeatures, type FeatureSnapshot } from "../src/market/features.ts";
import { classifyRegime, DEFAULT_REGIME_PARAMS } from "../src/market/regime.ts";
import { evaluateEntry } from "../src/risk/engine.ts";
import { sizePosition, stopPriceFor, takeProfitPriceFor } from "../src/risk/position-sizing.ts";
import { evaluateKillSwitch } from "../src/risk/limits.ts";
import { openStore, kvSet, kvGet, persistMarketSnapshot } from "../src/memory/db.ts";
import { recordDecision, openTrade, computeClosedMetrics, closeTrade } from "../src/memory/trades.ts";
import { persistFills } from "../src/execution/executor.ts";
import { upsertLesson, addLessonEvidence, recomputeLesson, getActiveLessons } from "../src/memory/lessons.ts";
import { getWeights, maybeEvolveWeights } from "../src/learning/signal-weights.ts";
import { calibrate, recomputeCalibration } from "../src/learning/confidence.ts";
import { backtest, walkForward } from "../src/evaluation/backtest.ts";
import { compareAndMaybePromote } from "../src/evaluation/champion-challenger.ts";
import { loadStrategies, saveStrategy, BASE_STRATEGIES, type StrategyDef } from "../src/strategy/library.ts";
import { validateProposal } from "../src/agents/evolution-agent.ts";
import { scoreStrategy } from "../src/strategy/library.ts";
import type { Candle } from "../src/exchange/okx/types.ts";
import type { RiskConfig, TradingConfig } from "../src/core/config.ts";
import { loadRiskConfig, loadTradingConfig } from "../src/core/config.ts";

const tmpRoot = (): string => mkdtempSync(path.join(os.tmpdir(), "evoq-"));
const trading = loadTradingConfig();
const risk = loadRiskConfig();

function synthTrend(n: number, start: number, slope: number, vol: number, seed = 7): Candle[] {
  let s = seed;
  const rnd = (): number => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648) - 0.5;
  const out: Candle[] = [];
  let px = start;
  for (let i = 0; i < n; i++) {
    const o = px;
    px = px * (1 + slope / 100) + rnd() * vol;
    const c = px;
    const h = Math.max(o, c) + Math.abs(rnd()) * vol;
    const l = Math.min(o, c) - Math.abs(rnd()) * vol;
    out.push({ ts: 1759334400000 + i * 900_000, o, h, l, c, vol: 100 + Math.abs(rnd()) * 50, volCcy: 1, confirm: "1" });
  }
  return out;
}

function feat(p: Partial<FeatureSnapshot>): FeatureSnapshot {
  return {
    ts: 0, instrument: "BTC-USDT-SWAP", price: 100, ema20: 101, ema50: 100, emaSpreadPct: 1,
    rsi14: 60, adx14: 30, atr14: 1, atrPct: 1, volume: 100, volumeSma20: 100, volumeRatio: 1.2,
    sufficientData: true, ...p,
  };
}

// ---- indicators (§17/§18) --------------------------------------------------
test("ema converges above sma on rising series", () => {
  const v = Array.from({ length: 60 }, (_, i) => 100 + i);
  const e = ema(v, 20);
  assert.ok(!Number.isNaN(e[19]));
  assert.ok(e[59]! > 128); // ~mid of last window
});

test("rsi in [0,100], extremes saturate", () => {
  const up = Array.from({ length: 40 }, (_, i) => 100 + i * 2);
  const down = up.slice().reverse();
  assert.ok(rsi(up)[39]! > 95);
  assert.ok(rsi(down)[39]! < 15);
  for (const r of rsi(up)) assert.ok(Number.isNaN(r) || (r >= 0 && r <= 100));
});

test("atr/adx defined after warm-up and positive", () => {
  const cs = synthTrend(120, 100, 0.4, 3);
  const a = atr(cs, 14);
  assert.ok(a[20]! > 0);
  const x = adx(cs, 14);
  assert.ok(x.adx[40]! >= 0 && x.adx[40]! <= 100);
});

test("features require warm-up and compute spread/ratio (§18)", () => {
  const thin = buildFeatures("BTC-USDT-SWAP", synthTrend(10, 100, 0.4, 2));
  assert.equal(thin.sufficientData, false);
  const rich = buildFeatures("BTC-USDT-SWAP", [...synthTrend(100, 100, 0.4, 2)].reverse());
  assert.equal(rich.sufficientData, true);
  assert.ok(rich.emaSpreadPct > 0);
  assert.ok(rich.volumeRatio > 0);
});

// ---- regime (§19) ----------------------------------------------------------
test("regime classification baselines", () => {
  assert.equal(classifyRegime(feat({ adx14: 30, emaSpreadPct: 0.8, atrPct: 0.9 })), "TRENDING_BULLISH");
  assert.equal(classifyRegime(feat({ adx14: 30, emaSpreadPct: -0.8, atrPct: 0.9 })), "TRENDING_BEARISH");
  assert.equal(classifyRegime(feat({ adx14: 10, emaSpreadPct: 0.05 })), "SIDEWAYS");
  assert.equal(classifyRegime(feat({ atrPct: 2.5 })), "HIGH_VOLATILITY");
  assert.equal(classifyRegime(feat({ sufficientData: false })), "UNKNOWN");
});

// ---- risk engine (§22/§23) --------------------------------------------------
const state = { equity: 100, dayStartEquity: 101, peakEquity: 110, openPositions: 0, killSwitchActive: null };

// pin policy values for engine tests — independent of live config edits
const tradingStrict = { ...trading, decision: { ...trading.decision, minimum_confidence: 0.70 } };
const riskStrict = { ...risk, hard_limits: { ...risk.hard_limits, allowed_symbols: ["BTC-USDT-SWAP"] } };

test("entry approved when all checks pass", () => {
  const v = evaluateEntry(
    { action: "LONG", strategy: "TREND_FOLLOWING_V1", confidence: 0.8, regime: "TRENDING_BULLISH", instrument: "BTC-USDT-SWAP", stopDistancePct: 0.01 },
    state, trading, risk,
  );
  assert.equal(v.approved, true);
});

test("arbitrary strings rejected (§21/§19)", () => {
  const a = evaluateEntry({ action: "YOLO", confidence: 0.9, regime: "TRENDING_BULLISH", instrument: "BTC-USDT-SWAP" }, state, trading, risk);
  assert.equal(a.approved, false); assert.equal(a.reason, "INVALID_ACTION");
  const b = evaluateEntry({ action: "LONG", confidence: 0.9, regime: "VIBES", instrument: "BTC-USDT-SWAP" }, state, trading, risk);
  assert.equal(b.approved, false); assert.equal(b.reason, "INVALID_REGIME");
});

test("confidence floor + calibrated (§22/§33)", () => {
  const v = evaluateEntry({ action: "LONG", confidence: 0.69, regime: "TRENDING_BULLISH", instrument: "BTC-USDT-SWAP", stopDistancePct: 0.01 }, state, tradingStrict, riskStrict);
  assert.equal(v.reason, "CONFIDENCE_BELOW_MIN");
});

test("kill switch blocks; daily loss and drawdown block (§22 diagram)", () => {
  const v1 = evaluateEntry({ action: "LONG", confidence: 0.9, regime: "TRENDING_BULLISH", instrument: "BTC-USDT-SWAP", stopDistancePct: 0.01 },
    { ...state, killSwitchActive: "CLOCK_DRIFT" }, trading, risk);
  assert.equal(v1.reason, "KILL_SWITCH_ACTIVE");
  const v2 = evaluateEntry({ action: "LONG", confidence: 0.9, regime: "TRENDING_BULLISH", instrument: "BTC-USDT-SWAP", stopDistancePct: 0.01 },
    { ...state, equity: 97, dayStartEquity: 100 }, trading, risk);
  assert.equal(v2.reason, "MAX_DAILY_LOSS_REACHED");
  const v3 = evaluateEntry({ action: "LONG", confidence: 0.9, regime: "TRENDING_BULLISH", instrument: "BTC-USDT-SWAP", stopDistancePct: 0.01 },
    { ...state, equity: 89, dayStartEquity: 89.5, peakEquity: 100 }, trading, risk);
  assert.equal(v3.reason, "MAX_DRAWDOWN_REACHED");
});

test("position conflict + disallowed symbol (§23)", () => {
  const v1 = evaluateEntry({ action: "LONG", confidence: 0.9, regime: "TRENDING_BULLISH", instrument: "BTC-USDT-SWAP", stopDistancePct: 0.01 },
    { ...state, openPositions: risk.hard_limits.max_concurrent_positions }, trading, risk);
  assert.equal(v1.reason, "POSITION_ALREADY_OPEN");
  const v2 = evaluateEntry({ action: "LONG", confidence: 0.9, regime: "TRENDING_BULLISH", instrument: "DOGE-USDT-SWAP", stopDistancePct: 0.01 },
    state, tradingStrict, riskStrict);
  assert.equal(v2.reason, "INSTRUMENT_NOT_ALLOWED");
});

test("HOLD passes, CLOSE needs a position (§22)", () => {
  const h = evaluateEntry({ action: "HOLD", confidence: 0, regime: "SIDEWAYS", instrument: "BTC-USDT-SWAP" }, state, trading, risk);
  assert.equal(h.approved, true);
  const c = evaluateEntry({ action: "CLOSE", confidence: 0.9, regime: "SIDEWAYS", instrument: "BTC-USDT-SWAP" }, state, trading, risk);
  assert.equal(c.reason, "NO_POSITION_TO_CLOSE");
});

test("kill switch evaluator ordering + emergency store (§23)", () => {
  assert.equal(evaluateKillSwitch({
    apiOk: true, positionMismatch: false, orderFailuresRecent: 0, clockDriftMs: 50, dbOk: true,
    instrumentMetaOk: true, unexpectedPosition: false, dailyLossPct: 0, drawdownPct: 0,
  }, risk), null);
  assert.equal(evaluateKillSwitch({
    apiOk: false, positionMismatch: false, orderFailuresRecent: 0, clockDriftMs: 50, dbOk: false,
    instrumentMetaOk: false, unexpectedPosition: false, dailyLossPct: 0, drawdownPct: 0,
  }, risk), "DATABASE_UNAVAILABLE");
  const s = openStore(tmpRoot());
  s.db.exec("SELECT 1"); // smoke
  s.close();
});

// ---- sizing (§24) ----------------------------------------------------------
test("risk budget → contracts honors the configured risk cap", () => {
  const inst = { instId: "BTC-USDT-SWAP", tickSz: "0.01", lotSz: "0.01", minSz: "0.01", ctVal: "0.01", ctValCcy: "BTC" };
  // pin to 0.5% so the clamp MATH is tested independently of live tuning (§48 max 2%)
  const pinnedRisk = { ...risk, hard_limits: { ...risk.hard_limits, risk_per_trade_pct: 0.5 } };
  const res = sizePosition({ equity: 1000, entryPrice: 100_000, stopPrice: 98_500, leverage: 3, instrument: inst }, pinnedRisk);
  // risk budget = $5; loss per contract = 0.01×1500 = $15 → 0 contracts after floor → minSz path or below-min throw?
  // 5/15 = 0.333 contracts → floored to lotSz 0.01 → 0.33; margin ok. Verify consistency:
  const perContractLoss = 0.01 * (100_000 - 98_500);
  assert.ok(Number(res.contracts) * perContractLoss <= 5 + 1e-9);
  assert.equal(res.clampedByMargin, false);
});

test("stop/tp symmetric by side", () => {
  assert.equal(stopPriceFor(100, 2, 1.5, "LONG"), 97);
  assert.equal(stopPriceFor(100, 2, 1.5, "SHORT"), 103);
  assert.equal(takeProfitPriceFor(100, 2, 3, "LONG"), 106);
});

// ---- percent-of-equity sizing (user request: % dari modal) ---------------
test("percent_of_equity sizing: 1% of $1000 equity = $10 notional", () => {
  const inst = { instId: "BTC-USDT-SWAP", tickSz: "0.01", lotSz: "0.01", minSz: "0.01", ctVal: "0.01", ctValCcy: "BTC" };
  const res = sizePosition({ equity: 1000, entryPrice: 100_000, stopPrice: 98_500, leverage: 3, instrument: inst }, risk, { mode: "percent_of_equity", position_pct: 1 });
  // $10 target / ($1000 per contract) = 0.01 contracts exactly; notional = 0.01×0.01×100k = $10
  assert.equal(res.contracts, "0.01");
  assert.equal(res.mode, "percent_of_equity");
  assert.ok(Math.abs(res.notionalUsdt - 10) < 0.01);
});

test("percent_of_equity below OKX minimum size throws (minSz floor)", () => {
  const inst = { instId: "BTC-USDT-SWAP", tickSz: "0.01", lotSz: "0.01", minSz: "0.01", ctVal: "0.01", ctValCcy: "BTC" };
  // $100 equity × 1% = $1 target; 1 contract-lot = 0.01 ct = $10 notional → below minSz
  assert.throws(
    () => sizePosition({ equity: 100, entryPrice: 100_000, stopPrice: 98_500, leverage: 3, instrument: inst }, risk, { mode: "percent_of_equity", position_pct: 1 }),
    /[Mm]in|Sizing/,
  );
});

test("percent_of_equity within bounds never exceeds margin budget", () => {
  const inst = { instId: "BTC-USDT-SWAP", tickSz: "0.01", lotSz: "0.01", minSz: "0.01", ctVal: "0.01", ctValCcy: "BTC" };
  const res = sizePosition({ equity: 1000, entryPrice: 100_000, stopPrice: 99_000, leverage: 3, instrument: inst }, risk, { mode: "percent_of_equity", position_pct: 50 });
  assert.equal(res.notionalUsdt, 500);        // 50% × $1000 = $500 notional
  assert.equal(res.clampedByMargin, false);   // 500 < 90%×3×1000
  assert.ok(res.marginUsdt <= res.notionalUsdt / 3 + 0.01);
});

test("percent_of_equity remains capped by the hard risk budget at a wide stop", () => {
  const inst = { instId: "BTC-USDT-SWAP", tickSz: "0.01", lotSz: "0.01", minSz: "0.01", ctVal: "0.01", ctValCcy: "BTC" };
  // The requested $500 notional would lose $50 at a 10% stop. A pinned 0.5%
  // hard limit allows at most $5 risk, therefore capped at $50 notional.
  const pinnedRisk = { ...risk, hard_limits: { ...risk.hard_limits, risk_per_trade_pct: 0.5 } };
  const res = sizePosition({ equity: 1000, entryPrice: 100_000, stopPrice: 90_000, leverage: 3, instrument: inst }, pinnedRisk, { mode: "percent_of_equity", position_pct: 50 });
  assert.equal(res.notionalUsdt, 50);
  assert.ok(res.riskBudgetUsdt <= 5);
});

// ---- closed metrics (§27) --------------------------------------------------
test("MFE/MAE/R from synthetic path", () => {
  const path = [
    { ts: 1, o: 100, h: 105, l: 99, c: 102, vol: 1, volCcy: 1, confirm: "1" as const },
    { ts: 2, o: 102, h: 108, l: 100, c: 106, vol: 1, volCcy: 1, confirm: "1" as const },
  ];
  const m = computeClosedMetrics({
    side: "LONG", entryPx: 100, stopPx: 98, exitPx: 106, contracts: 0.01, ctVal: 1,
    exitReason: "TP", entryTs: "2026-10-01T00:00:00Z", exitTs: "2026-10-01T01:00:00Z",
    candlesWhileOpen: path, fees: 0, funding: 0,
  });
  assert.equal(m.mfe, 8);  // high 108
  assert.equal(m.mae, 1);  // low 99
  assert.equal(m.resultR, 3); // +6 / stop distance 2
  assert.equal(m.durationS, 3600);
});

// ---- DB + trades + lessons --------------------------------------------------
test("decision+trade roundtrip incl. HOLD (§41)", () => {
  const st = openStore(tmpRoot());
  recordDecision(st, {
    decisionId: "DEC-1", ts: new Date().toISOString(), instrument: "BTC-USDT-SWAP",
    decision: "HOLD", regime: "SIDEWAYS", riskVerdict: { approved: true, reason: "APPROVED" },
  });
  openTrade(st, {
    tradeId: "TRD-1", instrument: "BTC-USDT-SWAP", timeframe: "15m", side: "LONG",
    strategy: "TREND_FOLLOWING", strategyVersion: 1, regime: "TRENDING_BULLISH",
    contracts: "0.01", entryPx: 100, entryTs: "2026-10-01T00:00:00Z", stopPx: 98, takeProfitPx: 106,
    clOpenId: "C1", ordOpenId: "O1", decisionId: "DEC-1", rawConfidence: 0.8, calibratedConfidence: 0.75,
    plannedRiskPct: 0.5, leverage: 3, entryFeatures: feat({}),
  });
  closeTrade(st, "TRD-1", {
    exitPx: 106, exitTs: "2026-10-01T02:00:00Z", exitReason: "TP", fees: 0, funding: 0,
    pnl: 0.06, pnlPct: 6, resultR: 3, mfe: 8, mae: 1, durationS: 7200,
  });
  assert.equal((st.db.prepare("SELECT decision_id FROM trades WHERE trade_id='TRD-1'").get() as { decision_id: string }).decision_id, "DEC-1");
  const row = st.db.prepare("SELECT * FROM trades WHERE trade_id='TRD-1'").get() as Record<string, unknown>;
  assert.equal(row.status, "CLOSED"); assert.equal(row.result_r, 3);
  st.close();
});

test("fills preserve partial executions and store reopening is idempotent", () => {
  const root = tmpRoot();
  const st = openStore(root);
  const fill = { tradeId: "OKX-FILL-1", ordId: "ORD-1", instId: "BTC-USDT-SWAP", fillPx: "100", fillSz: "0.01", side: "buy", posSide: "long" };
  persistFills(st, [{ ...fill, ts: "1" }, { ...fill, fillSz: "0.02", ts: "2" }, { ...fill, ts: "1" }]);
  assert.equal((st.db.prepare("SELECT COUNT(*) c FROM fills").get() as { c: number }).c, 2);
  st.close();
  const reopened = openStore(root);
  assert.equal((reopened.db.prepare("SELECT COUNT(*) c FROM fills").get() as { c: number }).c, 2);
  reopened.close();
});

test("market snapshots retain the same timestamp for multiple instruments", () => {
  const st = openStore(tmpRoot());
  persistMarketSnapshot(st, "2026-10-03T00:00:00.000Z", "BTC-USDT-SWAP", { price: 100 });
  persistMarketSnapshot(st, "2026-10-03T00:00:00.000Z", "ETH-USDT-SWAP", { price: 10 });
  assert.equal((st.db.prepare("SELECT COUNT(*) c FROM market_snapshots").get() as { c: number }).c, 2);
  st.close();
});

test("lesson evidence transitions (§29/§30)", () => {
  const st = openStore(tmpRoot());
  // seed 12 closed losing trades in scope
  for (let i = 0; i < 12; i++) {
    st.db.prepare(`INSERT INTO trades(trade_id,status,instrument,timeframe,side,strategy,strategy_version,regime,contracts,result_r,exit_ts)
      VALUES('TRD-L' || ${i},'CLOSED','BTC-USDT-SWAP','15m','LONG','BREAKOUT',1,'SIDEWAYS','0.01',${i < 9 ? -0.5 : 0.5},'2026-10-01T00:00:00Z')`).run();
  }
  const id = upsertLesson(st, { statement: "breakouts underperform in low volume", scope: { strategy: "BREAKOUT", instrument: "BTC-USDT-SWAP", regime: "SIDEWAYS" }, confidence: 0.4 });
  for (let i = 0; i < 12; i++) addLessonEvidence(st, id, `TRD-L${i}`, i < 9);
  recomputeLesson(st, id);
  const l = st.db.prepare("SELECT status, observations FROM lessons WHERE lesson_id=?").get(id) as { status: string; observations: number };
  assert.ok(l.observations >= 10);
  assert.ok(["REINFORCED", "CONFLICTED"].includes(l.status)); // 75% agree → REINFORCED expected
  const active = getActiveLessons(st, "BTC-USDT-SWAP");
  if (l.status === "REINFORCED") assert.equal(active.length, 1);
  st.close();
});

test("weights evolve bounded (±10%) after interval (§31)", () => {
  const st = openStore(tmpRoot());
  const insert = st.db.prepare(`INSERT INTO trades(trade_id,status,instrument,timeframe,side,strategy,strategy_version,regime,contracts,result_r,entry_features,exit_ts)
    VALUES(?, 'CLOSED','BTC-USDT-SWAP','15m','LONG','TREND_FOLLOWING',1,'TRENDING_BULLISH','0.01', ?, ?, '2026-10-01T00:00:00Z')`);
  for (let i = 0; i < 21; i++) {
    insert.run(`T${i}`, i % 2, JSON.stringify(feat({ emaSpreadPct: 0.6, volumeRatio: 1.4 })));
  }
  const before = getWeights(st);
  const after = maybeEvolveWeights(st, 20, 10);
  assert.ok(after);
  for (const k of Object.keys(after!) as Array<keyof typeof before>) {
    assert.ok(Math.abs(after![k] - before[k]) <= 0.1001, `${k} delta ${after![k] - before[k]}`);
    assert.ok(after![k] >= 0.5 && after![k] <= 2);
  }
  st.close();
});

test("calibration identity until sample, then shrinks (§33)", () => {
  const st = openStore(tmpRoot());
  assert.equal(calibrate(st, 0.9), 0.9);
  for (let i = 0; i < 40; i++) {
    st.db.prepare(`INSERT INTO trades(trade_id,status,instrument,timeframe,side,strategy,strategy_version,regime,contracts,raw_confidence,result_r,exit_ts)
      VALUES('C' || ${i},'CLOSED','BTC-USDT-SWAP','15m','LONG','TREND_FOLLOWING',1,'SIDEWAYS','0.01',0.95,${i % 3 === 0 ? 1 : -0.5},'2026-10-01T00:00:00Z')`).run();
  }
  const table = recomputeCalibration(st);
  assert.ok(table && table.sample >= 30);
  const cal = calibrate(st, 0.95);
  assert.ok(cal < 0.95 && cal > 0.33); // realized ≈33% win → shrink below raw
  st.close();
});

// ---- backtest + champion/challenger (§35/§36) -------------------------------
const def: StrategyDef = BASE_STRATEGIES[0]!;

test("backtest produces trades on trending series and stats consistent", () => {
  const cs = synthTrend(400, 100, 0.5, 2.5, 11);
  const res = backtest(def, cs, "15m");
  assert.ok(res.trades.length > 0);
  for (const t of res.trades) assert.ok(Math.abs(t.resultR) >= 0);
  assert.ok(Number.isFinite(res.summary.expectancy_r));
});

test("walk-forward runs folds", () => {
  const cs = synthTrend(400, 100, 0.5, 2.5, 13);
  const wf = walkForward(def, cs, "15m", 3);
  assert.equal(wf.foldExpectancies.length, 2);
});

test("proposal validator enforces bounds (§36/§48)", () => {
  const p = {
    candidate: { name: "TREND_FOLLOWING", version: 2 },
    parent: { name: "TREND_FOLLOWING", version: 1 },
    changes: { adx_min: { old: 22, new: 27 } },
    hypothesis: "weak trend filter", evidence: { trades_analyzed: 50 }, expected_effect: "+R",
  };
  assert.equal(validateProposal(p as never, def.params, 2).ok, true);
  assert.equal(validateProposal({ ...p, changes: { max_leverage: { old: 3, new: 1 } } } as never, def.params, 2).ok, false); // §48
  assert.equal(validateProposal({ ...p, changes: { adx_min: { old: 22, new: 40 } } } as never, def.params, 2).ok, false); // >25%
  assert.equal(validateProposal({ ...p, changes: { adx_min: { old: 22, new: 24 }, rsi_min: { old: 48, new: 50 }, volume_ratio_min: { old: 1.1, new: 1.2 } } } as never, def.params, 2).ok, false); // 3 changes
});

test("promotion only when challenger strictly better; else REJECTED (§35)", () => {
  const st = openStore(tmpRoot());
  loadStrategies(st);
  // identical challenger params → cannot beat champion → REJECTED
  saveStrategy(st, { ...def, version: 99, status: "CHALLENGER" }, 1, "same params");
  const cs = synthTrend(400, 100, 0.4, 2.5, 17);
  const [res] = compareAndMaybePromote(st, cs, "15m", { minSampleEachSide: 1, requireOutOfSample: true, requireWalkForward: false, wfMinPositiveFolds: 1 });
  assert.ok(res);
  assert.equal(res.promoted, false);
  const rows = st.db.prepare("SELECT status FROM strategy_versions WHERE version=99").get() as { status: string };
  assert.equal(rows.status, "REJECTED");
  assert.equal((st.db.prepare("SELECT COUNT(*) c FROM evolution_comparisons").get() as { c: number }).c, 1);
  st.close();
});
