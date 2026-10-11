// Scalp engine tests — §46 fee guard, deterministic signals, policy gating,
// LLM-budget accounting, cooldown/daily caps. Fake data, no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateSignal, stanceAllows, budgetAllows, dailyAllows, SCALP_DEFAULTS, hourKey,
  feeGuardPasses, scalpDirectionAllowed, scalpRsiAllowed, scalpScoreAllowed, scalpVolumeAllowed, sidewaysConfirmationAllowed } from "../src/scalp/signals.ts";
import type { ScalpCfg } from "../src/scalp/signals.ts";
import type { Candle } from "../src/exchange/okx/types.ts";
import type { FeatureSnapshot } from "../src/market/features.ts";
import { backtestScalp } from "../src/scalp/backtest.ts";
import { scalpBlocker } from "../src/scalp/runner.ts";
import { fetchStance, gateSignal, ScalpCandidateGateSchema, StanceSchema } from "../src/agents/scalp-agent.ts";
import { latestConfirmedCandleClose } from "../src/scalp/candles.ts";

const cfg: ScalpCfg = { ...SCALP_DEFAULTS, watchlist: ["BTC-USDT-SWAP"] };

test("Scalp stance schema tolerates concise and mildly verbose reasons up to 500 chars", () => {
  for (const length of [100, 250, 300, 499, 500]) {
    assert.equal(StanceSchema.safeParse({ stance: "NEUTRAL", confidence: 0.75, reason: "r".repeat(length) }).success, true, `length ${length}`);
  }
  assert.equal(StanceSchema.safeParse({ stance: "NEUTRAL", confidence: 0.75, reason: "r".repeat(501) }).success, false);
  assert.equal(StanceSchema.safeParse({ stance: "BULLISH", confidence: 0.75, reason: "ok" }).success, false);
  assert.equal(StanceSchema.safeParse({ stance: "NEUTRAL", confidence: 1.01, reason: "ok" }).success, false);
  assert.equal(StanceSchema.safeParse({ stance: "NEUTRAL", confidence: 0.75, reason: "ok", trade_now: true }).success, false);
});

test("Scalp stance prompt reflects Moderate floors and unavailable stance remains fail-closed", async () => {
  let prompt = "";
  const roles = { json: async (_role: string, system: string) => { prompt = system; return null; } };
  const result = await fetchStance(roles as never, { regimes: {}, atrPcts: {}, sessionPnlR: 0, tradesToday: 0 });
  assert.match(prompt, /AGGRESSIVE:.*0\.55/);
  assert.match(prompt, /NEUTRAL:.*0\.65/);
  assert.match(prompt, /DEFENSIVE:.*no new Scalp entries/);
  assert.equal(result.stance, "DEFENSIVE");
  assert.equal(result.confidence, 0);
});

test("Scalp candidate gate schema stays strict and unavailable gate is an explicit fail-closed outcome", async () => {
  assert.equal(ScalpCandidateGateSchema.safeParse({ verdict: "ALLOW", confidence: 0.8, reason: "ok" }).success, true);
  assert.equal(ScalpCandidateGateSchema.safeParse({ verdict: "ALLOW", confidence: 0.8, reason: "ok", side: "LONG" }).success, false);
  const result = await gateSignal({ json: async () => null } as never,
    { instrument: "X", direction: 1, score: 0.8, price: 100, stopPx: 99, tpPx: 102, atr: 1,
      reason: "test", regime: "TRENDING_BULLISH", ts: 0 }, cfg, { stance: "AGGRESSIVE", regime: "TRENDING_BULLISH", atrPct15m: 0.3, spreadOk: true });
  assert.equal(result.allow, false);
  assert.equal(result.unavailable, true);
});

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

test("confirmed sideways continuation can signal, but missing/opposite confirmation fails", () => {
  const cs = candles(120, 100, 0.5, -0.28, 3.0);
  const price = cs.at(-1)!.c;
  const valid = evaluateSignal({ instrument: "X", closes1m: cs, last5m: { close: price - 0.01 }, regime: "SIDEWAYS", features: feats() }, cfg, 1e9, {});
  assert.ok(valid.signal, `expected qualified sideways signal, got ${valid.veto}`);
  assert.equal(valid.signal!.direction, 1);
  assert.equal(evaluateSignal({ instrument: "X", closes1m: cs, last5m: null, regime: "SIDEWAYS", features: feats() }, cfg, 1e9, {}).veto, "sideways-confirmation");
  assert.equal(evaluateSignal({ instrument: "X", closes1m: cs, last5m: { close: price + 1 }, regime: "SIDEWAYS", features: feats() }, cfg, 1e9, {}).veto, "sideways-confirmation");
  const down = candles(120, 100, 0.28, -0.5, 3.0);
  const shortPrice = down.at(-1)!.c;
  const short = evaluateSignal({ instrument: "X", closes1m: down, last5m: { close: shortPrice + 0.01 }, regime: "SIDEWAYS", features: feats() }, cfg, 1e9, {});
  assert.ok(short.signal, `expected qualified sideways short, got ${short.veto}`);
  assert.equal(short.signal!.direction, -1);
});

test("Sideways confirmation uses the latest confirmed signal candle and excludes an unconfirmed candle", () => {
  const candle = (ts: number, close: number, confirm: "0" | "1"): Candle => ({
    ts, o: close, h: close, l: close, c: close, vol: 100, volCcy: 1, confirm,
  });
  // Deliberately provide exchange data out of order; confirmation uses the sorted latest confirmed close.
  const last5m = latestConfirmedCandleClose([
    candle(Date.parse("2026-10-10T10:05:00Z"), 101, "1"),
    candle(Date.parse("2026-10-10T10:15:00Z"), 110, "0"),
    candle(Date.parse("2026-10-10T10:00:00Z"), 100, "1"),
    candle(Date.parse("2026-10-10T10:10:00Z"), 102, "1"),
  ]);
  assert.deepEqual(last5m, { close: 102 });

  const generated = candles(120, 100, 0.5, -0.28, 3.0);
  const shift = generated.at(-1)!.c - 101.5;
  const closesAt101_5 = generated.map((bar) => ({ ...bar, o: bar.o - shift, h: bar.h - shift, l: bar.l - shift, c: bar.c - shift }));
  const previousConfirmed = evaluateSignal({ instrument: "X", closes1m: closesAt101_5,
    last5m: { close: 101 }, regime: "SIDEWAYS", features: feats() }, cfg, 1e9, {});
  assert.ok(previousConfirmed.signal, `previous confirmed close should pass, got ${previousConfirmed.veto}`);
  const latestConfirmed = evaluateSignal({ instrument: "X", closes1m: closesAt101_5,
    last5m, regime: "SIDEWAYS", features: feats() }, cfg, 1e9, {});
  assert.equal(latestConfirmed.veto, "sideways-confirmation");
});

test("high/low volatility and unknown regimes reject Scalp entries", () => {
  const cs = candles(120, 100, 0.5, -0.28, 2.0);
  for (const regime of ["HIGH_VOLATILITY", "LOW_VOLATILITY", "UNKNOWN"] as const) {
    const result = evaluateSignal({ instrument: "X", closes1m: cs, last5m: null, regime, features: feats() }, cfg, 1e9, {});
    assert.equal(result.veto, `regime:${regime}`);
  }
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

test("0.25% fee guard floor rejects 0.249% and tolerates floating-point equality", () => {
  assert.equal(feeGuardPasses(0.249, 0.25), false);
  assert.equal(feeGuardPasses(0.25, 0.25), true);
  assert.equal(feeGuardPasses(0.25 - Number.EPSILON, 0.25), true);
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

test("15m trend alignment forbids a Scalp signal against the regime", () => {
  const down = candles(120, 100, 0.28, -0.5, 2.2);
  const againstBull = evaluateSignal({ instrument: "X", closes1m: down, last5m: null, regime: "TRENDING_BULLISH", features: feats() }, cfg, 1e9, {});
  assert.equal(againstBull.veto, "ema:against_trend");
  const up = candles(120, 100, 0.5, -0.28, 2.2);
  const againstBear = evaluateSignal({ instrument: "X", closes1m: up, last5m: null, regime: "TRENDING_BEARISH", features: feats() }, cfg, 1e9, {});
  assert.equal(againstBear.veto, "ema:against_trend");
});

test("Moderate Scalp parameter boundaries and stricter sideways overlay are deterministic", () => {
  assert.deepEqual({ long: [cfg.rsi_long_min, cfg.rsi_long_max], short: [cfg.rsi_short_min, cfg.rsi_short_max],
    volume: cfg.vol_burst_min, score: cfg.min_score, minTp: cfg.min_tp_pct },
  { long: [48, 72], short: [28, 52], volume: 1.1, score: 0.55, minTp: 0.25 });
  assert.equal(scalpVolumeAllowed("TRENDING_BULLISH", 1.09, cfg), false);
  assert.equal(scalpVolumeAllowed("TRENDING_BULLISH", 1.10, cfg), true);
  assert.equal(scalpVolumeAllowed("SIDEWAYS", 1.24, cfg), false);
  assert.equal(scalpVolumeAllowed("SIDEWAYS", 1.25, cfg), true);
  assert.equal(scalpScoreAllowed("TRENDING_BULLISH", 0.549, cfg), false);
  assert.equal(scalpScoreAllowed("TRENDING_BULLISH", 0.55, cfg), true);
  assert.equal(scalpScoreAllowed("SIDEWAYS", 0.699, cfg), false);
  assert.equal(scalpScoreAllowed("SIDEWAYS", 0.70, cfg), true);
  for (const rsi of [47.9, 73]) assert.equal(scalpRsiAllowed(1, rsi, cfg), false);
  for (const rsi of [48, 72]) assert.equal(scalpRsiAllowed(1, rsi, cfg), true);
  for (const rsi of [27.9, 52.1]) assert.equal(scalpRsiAllowed(-1, rsi, cfg), false);
  for (const rsi of [28, 52]) assert.equal(scalpRsiAllowed(-1, rsi, cfg), true);
  assert.equal(scalpDirectionAllowed("TRENDING_BULLISH", 1), true);
  assert.equal(scalpDirectionAllowed("TRENDING_BULLISH", -1), false);
  assert.equal(scalpDirectionAllowed("TRENDING_BEARISH", -1), true);
  assert.equal(scalpDirectionAllowed("TRENDING_BEARISH", 1), false);
  assert.equal(sidewaysConfirmationAllowed(1, 100, { close: 100 }), true);
  assert.equal(sidewaysConfirmationAllowed(-1, 100, { close: 100 }), true);
  assert.equal(sidewaysConfirmationAllowed(1, 99, { close: 100 }), false);
  assert.equal(sidewaysConfirmationAllowed(-1, 101, { close: 100 }), false);
});

test("Scalp funnel blocker dimensions are bounded operational categories", () => {
  const cases = [
    ["regime:SIDEWAYS", "regime"], ["atr15:0.04%", "atr15"], ["ema:against_trend", "ema"],
    ["rsi", "rsi"], ["volume", "volume"], ["score:0.54<0.55", "score"],
    ["sideways-score", "sideways-score"], ["sideways-volume", "sideways-volume"],
    ["sideways-confirmation", "sideways-confirmation"], ["fee-guard", "fee-guard"],
    ["cooldown:12s", "cooldown"], ["warmup", "warmup"],
  ] as const;
  for (const [reason, expected] of cases) assert.equal(scalpBlocker(reason), expected);
  assert.equal(scalpBlocker(undefined), "no_setup");
});

test("DEFENSIVE vetoes; AGGRESSIVE and NEUTRAL enforce their configured score floors", () => {
  const sig = { instrument: "X", direction: 1 as const, score: 0.65, price: 100, stopPx: 99.5, tpPx: 101, atr: 0.4, reason: "x", regime: "TRENDING_BULLISH" as const, ts: 0 };
  assert.equal(stanceAllows("DEFENSIVE", sig).allow, false);
  assert.equal(stanceAllows("NEUTRAL", { ...sig, score: 0.64 }).allow, false);
  assert.equal(stanceAllows("NEUTRAL", { ...sig, score: 0.65 }).allow, true);
  assert.equal(stanceAllows("AGGRESSIVE", { ...sig, score: 0.55 }).allow, true);
  assert.equal(stanceAllows("AGGRESSIVE", sig).allow, true); // ≥0.55
});

test("hour budget & daily cap math", () => {
  assert.equal(budgetAllows(6, 6), false);
  assert.equal(budgetAllows(5, 6), true);
  assert.equal(dailyAllows(20, 20), false);
  assert.equal(dailyAllows(19, 20), true);
  assert.equal(hourKey("2026-10-05T07:41:00Z"), "2026-10-05T07");
});
