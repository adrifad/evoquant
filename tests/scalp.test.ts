// Scalp engine tests — §46 fee guard, deterministic signals, policy gating,
// LLM-budget accounting, cooldown/daily caps. Fake data, no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateSignal, stanceAllows, budgetAllows, dailyAllows, SCALP_DEFAULTS, hourKey } from "../src/scalp/signals.ts";
import type { ScalpCfg } from "../src/scalp/signals.ts";
import type { Candle } from "../src/exchange/okx/types.ts";
import type { FeatureSnapshot } from "../src/market/features.ts";
import { backtestScalp } from "../src/scalp/backtest.ts";

const cfg: ScalpCfg = { ...SCALP_DEFAULTS, watchlist: ["BTC-USDT-SWAP"] };

// zigzag with controlled up/down amplitudes → realistic RSI7 (not 100/0)
function candles(n: number, startPx: number, up: number, down: number, lastVolSpike = 1): Candle[] {
  const out: Candle[] = [];
  let px = startPx;
  for (let i = 0; i < n; i++) {
    const o = px;
    px = px + (i % 2 === 0 ? up : down);
    const h = Math.max(o, px) + Math.abs(up) * 0.4;
    const l = Math.min(o, px) - Math.abs(down) * 0.4;
    out.push({ ts: 1759334400000 + i * 60_000, o, h, l, c: px, vol: 100 * (i === n - 1 ? lastVolSpike : 1), volCcy: 1, confirm: "1" });
  }
  return out;
}
const feats = (p: Partial<FeatureSnapshot> = {}): FeatureSnapshot => ({
  ts: 0, instrument: "BTC-USDT-SWAP", price: 100, ema20: 101, ema50: 100, emaSpreadPct: 0.6,
  rsi14: 60, adx14: 30, atr14: 0.4, atrPct: 0.35, volume: 100, volumeSma20: 100, volumeRatio: 1.4,
  sufficientData: true, ...p,
});

test("uptrend + burst fires LONG scalp with fee-guarded TP", () => {
  const cs = candles(120, 100, 0.5, -0.28, 2.0); // rising zigzag + vol spike
  const r = evaluateSignal({ instrument: "BTC-USDT-SWAP", closes1m: cs, last5m: null, regime: "TRENDING_BULLISH", features: feats() }, cfg, 1e9, {});
  assert.ok(r.signal, `expected signal, got veto ${r.veto}`);
  const s = r.signal!;
  assert.equal(s.direction, 1);
  const tpPct = Math.abs(s.tpPx - s.price) / s.price * 100;
  assert.ok(tpPct >= cfg.min_tp_pct, `TP ${tpPct}% below fee guard`);
  assert.ok(Math.abs(s.stopPx - s.price) / s.price * 100 <= 1.5, "stop sane");
});

test("regime not trending → veto", () => {
  const cs = candles(120, 100, 0.5, -0.28, 2.0);
  const r = evaluateSignal({ instrument: "X", closes1m: cs, last5m: null, regime: "SIDEWAYS", features: feats() }, cfg, 1e9, {});
  assert.ok(r.veto?.startsWith("regime"));
});

test("ATR too calm → veto (no scalp juice)", () => {
  const cs = candles(120, 100, 0.5, -0.28, 2.0);
  const r = evaluateSignal({ instrument: "X", closes1m: cs, last5m: null, regime: "TRENDING_BULLISH", features: feats({ atrPct: 0.03 }) }, cfg, 1e9, {});
  assert.ok(r.veto?.startsWith("atr15"));
});

test("cooldown blocks re-entry until expiry", () => {
  const cs = candles(120, 100, 0.5, -0.28, 2.0);
  const now = 1e9;
  const r = evaluateSignal({ instrument: "X", closes1m: cs, last5m: null, regime: "TRENDING_BULLISH", features: feats() }, cfg, now, { X: now - 100 });
  assert.ok(r.veto?.startsWith("cooldown"));
});

test("fee guard kills sub-economic TP (override min_tp_pct high)", () => {
  const cs = candles(120, 100, 0.5, -0.28, 2.0); // would otherwise pass
  const r = evaluateSignal({ instrument: "X", closes1m: cs, last5m: null, regime: "TRENDING_BULLISH", features: feats() },
    { ...cfg, min_tp_pct: 99 }, 1e9, {});
  assert.ok(r.veto?.startsWith("fee-guard"), `expected fee-guard, got ${r.veto}`);
  // and the passing case's TP truly clears the guard
  const ok = evaluateSignal({ instrument: "X", closes1m: cs, last5m: null, regime: "TRENDING_BULLISH", features: feats() }, cfg, 1e9, {});
  if (ok.signal) assert.ok(Math.abs(ok.signal.tpPx - ok.signal.price) / ok.signal.price * 100 >= cfg.min_tp_pct);
  else assert.fail("baseline signal expected");
});

test("scalp replay reuses live signal fee guard and reports after-cost net R", () => {
  const cs = [...candles(120, 100, 0.5, -0.28, 2.0)];
  let px = cs.at(-1)!.c;
  for (let i = 0; i < 21; i++) {
    const o = px; px += 0.03;
    cs.push({ ts: cs.at(-1)!.ts + 60_000, o, h: px + 0.05, l: o - 0.05, c: px, vol: i === 0 ? 200 : 100, volCcy: 1, confirm: "1" });
  }
  const trades = backtestScalp(cs, cfg, () => ({ regime: "TRENDING_BULLISH", features: feats(), last5m: null }));
  assert.equal(trades.length, 1);
  assert.ok(trades[0]!.netR < trades[0]!.grossR);
  const noFees = backtestScalp(cs, cfg, () => ({ regime: "TRENDING_BULLISH", features: feats(), last5m: null }), {
    feePctPerSide: 0, slippageBpsPerSide: 0, spreadBpsPerSide: 0,
    slPlus: { enabled: true, activationR: 1, lockInR: 0.05, minProfitBufferPct: 0.12 },
  });
  assert.equal(noFees[0]?.netR, noFees[0]?.grossR);
});

test("downtrend + burst fires SHORT", () => {
  const cs = candles(120, 100, 0.28, -0.5, 2.2); // falling zigzag
  const r = evaluateSignal({ instrument: "X", closes1m: cs, last5m: null, regime: "TRENDING_BEARISH", features: feats({ rsi14: 40 }) }, cfg, 1e9, {});
  assert.ok(r.signal, `expected short, veto ${r.veto}`);
  assert.equal(r.signal!.direction, -1);
});

test("DEFENSIVE stance vetoes everything; NEUTRAL requires strong score", () => {
  const sig = { instrument: "X", direction: 1 as const, score: 0.65, price: 100, stopPx: 99.5, tpPx: 101, atr: 0.4, reason: "x", regime: "TRENDING_BULLISH" as const, ts: 0 };
  assert.equal(stanceAllows("DEFENSIVE", sig).allow, false);
  assert.equal(stanceAllows("NEUTRAL", sig).allow, false);   // 0.65 < 0.72
  assert.equal(stanceAllows("AGGRESSIVE", sig).allow, true); // ≥0.55
});

test("hour budget & daily cap math", () => {
  assert.equal(budgetAllows(6, 6), false);
  assert.equal(budgetAllows(5, 6), true);
  assert.equal(dailyAllows(20, 20), false);
  assert.equal(dailyAllows(19, 20), true);
  assert.equal(hourKey("2026-10-05T07:41:00Z"), "2026-10-05T07");
});
