// Scalp signal engine — DETERMINISTIC, zero LLM (§2.1: AI reason, code enforce).
// Built from 1m closes + latest 5m close. Direction is EMA9/21 alignment;
// RSI7 and burst gate the trigger; fee guard kills sub-economic edges (§46).
import type { Candle } from "../exchange/okx/types.ts";
import type { Regime } from "../market/regime.ts";
import type { Bar } from "../exchange/okx/market.ts";
import { type FeatureSnapshot } from "../market/features.ts";

export interface ScalpCfg {
  watchlist: string[]; signal_tf: Bar; base_tf: Bar;
  ema_fast: number; ema_slow: number; rsi_period: number;
  rsi_long_min: number; rsi_long_max: number; rsi_short_min: number; rsi_short_max: number;
  vol_burst_min: number; min_score: number;
  stop_atr_mult: number; tp_r: number; min_tp_pct: number;   // fee guard: TP distance ≥ ~3×roundtrip fee
  max_hold_s: number; cooldown_s: number; max_daily_trades: number;
  llm_gate: boolean; stance_refresh_s: number;
  fee_pct: number;
  position_pct: number;
}

export interface ScalpSignal {
  instrument: string; direction: 1 | -1; score: number;
  price: number; stopPx: number; tpPx: number; atr: number;
  reason: string; regime: Regime; ts: number;
}

export type GateOutcome =
  | { allow: true; confidence: number; reason: string }
  | { allow: false; reason: string };

// ---------- pure indicators (no import cycle with market/features) ----------

function emaSeries(values: number[], period: number): number[] {
  const k = 2 / (period + 1);
  const out: number[] = [];
  let prev = values[0] ?? 0;
  for (const v of values) { prev = v * k + prev * (1 - k); out.push(prev); }
  return out;
}

function rsiSeries(closes: number[], period: number): number[] {
  const out: number[] = [50];
  let avgUp = 0, avgDn = 0;
  for (let i = 1; i < closes.length; i++) {
    const ch = closes[i]! - closes[i - 1]!;
    const up = Math.max(ch, 0), dn = Math.max(-ch, 0);
    if (i <= period) { avgUp = (avgUp * (i - 1) + up) / i; avgDn = (avgDn * (i - 1) + dn) / i; }
    else { avgUp = (avgUp * (period - 1) + up) / period; avgDn = (avgDn * (period - 1) + dn) / period; }
    out.push(avgDn === 0 ? 100 : 100 - 100 / (1 + avgUp / avgDn));
  }
  return out;
}

function atrFrom(candles: Candle[], period: number): number {
  if (candles.length < period + 1) return 0;
  let sum = 0;
  for (let i = candles.length - period; i < candles.length; i++) {
    const c = candles[i]!, p = candles[i - 1]!;
    sum += Math.max(c.h - c.l, Math.abs(c.h - p.c), Math.abs(c.l - p.c));
  }
  return sum / period;
}

// ---------- signal evaluation ----------

export interface ScalpInput {
  instrument: string; closes1m: Candle[];        // oldest→newest, confirmed only
  last5m?: { close: number } | null;             // latest closed 5m candle (trend context)
  regime: Regime;
  features: FeatureSnapshot;                     // 15m features for veto rules
}

export function evaluateSignal(inp: ScalpInput, cfg: ScalpCfg,
  nowS: number, lastExitBySym: Record<string, number>): { signal?: ScalpSignal; veto?: string } {
  const { instrument, closes1m: cs } = inp;
  if (cs.length < Math.max(cfg.ema_slow, 20)) return { veto: "warmup" };
  if (!inp.regime.startsWith("TRENDING")) return { veto: `regime:${inp.regime}` };

  const cooldownLeft = cfg.cooldown_s - (nowS - (lastExitBySym[instrument] ?? 0));
  if (cooldownLeft > 0) return { veto: `cooldown:${Math.ceil(cooldownLeft)}s` };

  const closes = cs.map((c) => c.c);
  const ef = emaSeries(closes, cfg.ema_fast).at(-1)!;
  const es = emaSeries(closes, cfg.ema_slow).at(-1)!;
  const price = closes.at(-1)!;
  const r = rsiSeries(closes, cfg.rsi_period).at(-1)!;
  const atr = atrFrom(cs, 14);
  if (!(price > 0) || !(atr > 0)) return { veto: "bad-data" };
  // 15m-vol veto: scalp needs movement but not chaos (§46)
  const atr15pct = inp.features.atrPct;
  if (atr15pct < 0.08 || atr15pct > 0.8) return { veto: `atr15:${atr15pct.toFixed(2)}%` };

  const vols = cs.map((c) => c.vol);
  const smaV = vols.slice(-20).reduce((a, b) => a + b, 0) / Math.min(20, vols.length);
  const burst = smaV > 0 ? (vols.at(-1)! / smaV) : 0;

  let direction: 0 | 1 | -1 = 0;
  if (ef > es && r >= cfg.rsi_long_min && r <= cfg.rsi_long_max && burst >= cfg.vol_burst_min) direction = 1;
  else if (ef < es && r <= cfg.rsi_short_max && r >= cfg.rsi_short_min && burst >= cfg.vol_burst_min) direction = -1;
  if (!direction) return { veto: `no-setup(ef${ef > es ? ">" : "<"}es rsi=${r.toFixed(0)} burst=${burst.toFixed(2)})` };

  const trendAligned = !inp.last5m ||
    (direction === 1 ? price >= inp.last5m.close : price <= inp.last5m.close);
  const spread = Math.abs(ef - es) / price;
  const score = Math.min(1, (spread * 100) / 0.25 * 0.4 + ((burst - 1) / 0.5) * 0.35 + (trendAligned ? 0.25 : -0.35));
  if (score < cfg.min_score) return { veto: `score:${score.toFixed(2)}<${cfg.min_score}` };

  const stopPx = direction === 1 ? price - atr * cfg.stop_atr_mult : price + atr * cfg.stop_atr_mult;
  const stopDist = Math.abs(price - stopPx);
  if (!(stopDist > 0)) return { veto: "stop-degenerate" };
  const tpDist = stopDist * cfg.tp_r;
  // FEE GUARD: expected gross move must clear ≥ min_tp_pct (~3× taker roundtrip) (§46)
  if ((tpDist / price) * 100 < cfg.min_tp_pct) return { veto: `fee-guard:tp=${((tpDist / price) * 100).toFixed(2)}%<${cfg.min_tp_pct}%` };
  const tpPx = direction === 1 ? price + tpDist : price - tpDist;
  return {
    signal: {
      instrument, direction, score, price, stopPx, tpPx, atr, regime: inp.regime, ts: nowS,
      reason: `${direction === 1 ? "LONG" : "SHORT"} scalp: EMA${cfg.ema_fast}/${cfg.ema_slow} ${ef > es ? "bull" : "bear"} · RSI7=${r.toFixed(0)} · burst=${burst.toFixed(2)}x · atr1m=${atr.toFixed(price > 100 ? 2 : 4)}`,
    },
  };
}

// ---------- stance + budget policy (pure, testable) ----------

export type Stance = "AGGRESSIVE" | "NEUTRAL" | "DEFENSIVE";

export const SCALP_DEFAULTS: ScalpCfg = {
  watchlist: [], signal_tf: "5m", base_tf: "1m",
  ema_fast: 9, ema_slow: 21, rsi_period: 7,
  rsi_long_min: 50, rsi_long_max: 68, rsi_short_min: 32, rsi_short_max: 50,
  vol_burst_min: 1.25, min_score: 0.6, stop_atr_mult: 1.4, tp_r: 2.0, min_tp_pct: 0.35,
  max_hold_s: 900, cooldown_s: 240, max_daily_trades: 20,
  llm_gate: true, stance_refresh_s: 900,
  fee_pct: 0.05, position_pct: 20,
};

export function stanceAllows(stance: Stance, signal: ScalpSignal): GateOutcome {
  if (stance === "DEFENSIVE") return { allow: false, reason: "stance:DEFENSIVE" };
  const floor = stance === "AGGRESSIVE" ? 0.55 : 0.72;
  if (signal.score < floor) return { allow: false, reason: `stance:${stance} needs score≥${floor}, got ${signal.score.toFixed(2)}` };
  return { allow: true, confidence: signal.score, reason: "policy" };
}

export function hourKey(nowIso: string): string { return nowIso.slice(0, 13); }

export function budgetAllows(used: number, maxPerHour: number): boolean { return used < maxPerHour; }

export function dailyAllows(tradesToday: number, maxDaily: number): boolean { return tradesToday < maxDaily; }
