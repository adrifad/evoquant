// M7 (§35) — deterministic event-driven backtest over candles for a strategy.
// Same scorer as live (strategy/library) → champion/challenger comparability.
import type { Candle } from "../exchange/okx/types.ts";
import { buildFeatures } from "../market/features.ts";
import { classifyRegime } from "../market/regime.ts";
import { scoreStrategy, type StrategyDef } from "../strategy/library.ts";
import { summarize, type PerfSummary } from "./performance.ts";

export interface BacktestResult {
  summary: PerfSummary;
  trades: Array<{ entryTs: number; side: "LONG" | "SHORT"; resultR: number }>;
}

export function backtest(def: StrategyDef, candlesChrono: Candle[], timeframe: string): BacktestResult {
  const rs: number[] = [];
  const trades: BacktestResult["trades"] = [];
  let i = 0;
  while (i < candlesChrono.length) {
    const window = candlesChrono.slice(0, i + 1);
    const f = buildFeatures(def.name, window.slice().reverse()); // newest-first input
    const regime = classifyRegime(f);
    i += 1;
    if (!def.allowed_regimes.includes(regime) || !f.sufficientData) continue;
    const s = scoreStrategy(def, f);
    if (Math.abs(s) < 0.6) continue;
    const side: "LONG" | "SHORT" = s > 0 ? "LONG" : "SHORT";
    const entry = f.price;
    const atrV = f.atr14;
    if (!Number.isFinite(entry) || !Number.isFinite(atrV) || atrV <= 0) continue;
    const stop = def.params.stop_atr * atrV;
    const tp = def.params.take_profit_atr * atrV;
    // walk forward candles to resolution (first-touch, conservative: SL checked first)
    let resultR = 0;
    let resolved = false;
    for (let j = i; j < Math.min(i + 96, candlesChrono.length); j++) { // max 24h on 15m
      const c = candlesChrono[j]!;
      if (side === "LONG" ? c.l <= entry - stop : c.h >= entry + stop) { resultR = -1; resolved = true; break; }
      if (side === "LONG" ? c.h >= entry + tp : c.l <= entry - tp) { resultR = def.params.take_profit_atr / def.params.stop_atr; resolved = true; break; }
    }
    if (!resolved) {
      const last = candlesChrono[Math.min(i + 96, candlesChrono.length) - 1]!;
      const dir = side === "LONG" ? 1 : -1;
      resultR = ((last.c - entry) * dir) / stop;
    }
    rs.push(Math.round(resultR * 100) / 100);
    trades.push({ entryTs: candlesChrono[i]!.ts, side, resultR });
    i += 4; // cooldown: 1h on 15m
  }
  return { summary: summarize(rs), trades };
}

// M7 (§36) — walk-forward: K consecutive out-of-sample folds, each fit on the
// preceding in-sample window; score = mean fold expectancy + stability.
export function walkForward(def: StrategyDef, candles: Candle[], timeframe: string, folds = 4): { foldExpectancies: number[]; mean: number; positiveFolds: number } {
  const size = Math.floor(candles.length / folds);
  const exps: number[] = [];
  for (let k = 1; k < folds; k++) {
    const oos = candles.slice(k * size, (k + 1) * size);
    const res = backtest(def, oos, timeframe);
    exps.push(Math.round(res.summary.expectancy_r * 1000) / 1000);
  }
  const mean = exps.reduce((a, b) => a + b, 0) / (exps.length || 1);
  return { foldExpectancies: exps, mean, positiveFolds: exps.filter((e) => e > 0).length };
}
