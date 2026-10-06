import type { Candle } from "../exchange/okx/types.ts";
import type { FeatureSnapshot } from "../market/features.ts";
import type { Regime } from "../market/regime.ts";
import { evaluateSignal, type ScalpCfg } from "./signals.ts";
import { calculateSlPlusStop } from "../execution/sl-plus.ts";

export interface ScalpBacktestCosts {
  feePctPerSide: number; slippageBpsPerSide: number; spreadBpsPerSide: number;
  slPlus: { enabled: boolean; activationR: number; lockInR: number; minProfitBufferPct: number };
}
export interface ScalpBacktestTrade {
  engine: "SCALP_5M"; instrument: string; strategy: "SCALP"; strategyVersion: 1; regime: Regime;
  entryTs: number; exitTs: number; side: "LONG" | "SHORT"; grossR: number; netR: number; feesR: number;
  exitReason: "SL" | "TP" | "SL_PLUS" | "TIME_STOP" | "DATA_END";
}
export interface ScalpContext { regime: Regime; features: FeatureSnapshot; last5m?: { close: number } | null }

/**
 * Deterministic scalp replay; evaluator/fee guard are the exact live evaluateSignal function.
 * Supply the 15m feature/regime snapshot that was actually available at each signal close.
 */
export function backtestScalp(
  candlesChrono: Candle[], cfg: ScalpCfg, contextAt: (index: number) => ScalpContext | null,
  costs: ScalpBacktestCosts = { feePctPerSide: cfg.fee_pct, slippageBpsPerSide: 1.5, spreadBpsPerSide: 1.5,
    slPlus: { enabled: true, activationR: 1, lockInR: 0.05, minProfitBufferPct: 0.12 } },
): ScalpBacktestTrade[] {
  const candles = candlesChrono.filter((c) => c.confirm === "1").slice().sort((a, b) => a.ts - b.ts);
  const barMs = timeframeMs(cfg.base_tf);
  const signalStride = Math.max(1, Math.round(timeframeMs(cfg.signal_tf) / barMs));
  const trades: ScalpBacktestTrade[] = [];
  let lastExitS = 0;
  for (let i = Math.max(cfg.ema_slow, 20) - 1; i < candles.length - 1; i += signalStride) {
    const context = contextAt(i);
    if (!context) continue;
    const nowS = Math.floor(candles[i]!.ts / 1000);
    const evaluated = evaluateSignal({ instrument: context.features.instrument, closes1m: candles.slice(0, i + 1),
      ...(context.last5m !== undefined ? { last5m: context.last5m } : {}), regime: context.regime, features: context.features }, cfg, nowS,
    lastExitS ? { [context.features.instrument]: lastExitS } : {});
    const signal = evaluated.signal;
    if (!signal) continue;
    const entryCandle = candles[i + 1]!;
    const entry = entryCandle.o;
    const side = signal.direction === 1 ? "LONG" : "SHORT";
    const sign = signal.direction;
    const risk = Math.abs(signal.price - signal.stopPx);
    if (!(entry > 0 && risk > 0)) continue;
    const stop = entry + (signal.stopPx - signal.price);
    const target = entry + (signal.tpPx - signal.price);
    let activeStop = stop;
    const maxBars = Math.max(1, Math.ceil(cfg.max_hold_s * 1000 / barMs));
    let exit = entry;
    let exitTs = entryCandle.ts;
    let exitReason: ScalpBacktestTrade["exitReason"] = "DATA_END";
    let resolved = false;
    for (let j = i + 1; j < Math.min(candles.length, i + maxBars + 1); j++) {
      const c = candles[j]!;
      const stopHit = sign === 1 ? c.l <= activeStop : c.h >= activeStop;
      const targetHit = sign === 1 ? c.h >= target : c.l <= target;
      if (stopHit) {
        exit = sign === 1 ? Math.min(c.o, activeStop) : Math.max(c.o, activeStop);
        exitTs = c.ts; exitReason = activeStop === stop ? "SL" : "SL_PLUS"; resolved = true; break;
      }
      if (targetHit) { exit = target; exitTs = c.ts; exitReason = "TP"; resolved = true; break; }
      const favorable = sign === 1 ? c.h - entry : entry - c.l;
      if (costs.slPlus.enabled && favorable / risk >= costs.slPlus.activationR) {
        const nextStop = calculateSlPlusStop({ side, entryPx: entry, initialStopPx: stop, currentStopPx: activeStop,
          markPx: c.c, tickSz: Math.max(entry * 1e-8, Number.EPSILON), activationR: costs.slPlus.activationR,
          lockInR: costs.slPlus.lockInR, minProfitBufferPct: costs.slPlus.minProfitBufferPct });
        if (nextStop !== null) activeStop = nextStop;
      }
      if (j - i >= maxBars) {
        const next = candles[j + 1]; exit = next?.o ?? c.c; exitTs = next?.ts ?? c.ts;
        exitReason = "TIME_STOP"; resolved = true; break;
      }
    }
    if (!resolved) { const last = candles[Math.min(candles.length - 1, i + maxBars)]!; exit = last.c; exitTs = last.ts; }
    const grossR = ((exit - entry) * sign) / risk;
    const costFraction = 2 * costs.feePctPerSide / 100 + 2 * (costs.slippageBpsPerSide + costs.spreadBpsPerSide) / 10_000;
    const feesR = costFraction * (entry + exit) / risk;
    trades.push({ engine: "SCALP_5M", instrument: signal.instrument, strategy: "SCALP", strategyVersion: 1,
      regime: context.regime, entryTs: entryCandle.ts, exitTs, side, grossR, netR: grossR - feesR, feesR, exitReason });
    lastExitS = Math.floor(exitTs / 1000);
    i = Math.max(i, Math.floor((exitTs - candles[0]!.ts) / barMs));
  }
  return trades;
}

function timeframeMs(tf: string): number {
  const m = /^(\d+)(m|H|D)$/.exec(tf);
  if (!m) throw new Error(`unsupported scalp timeframe: ${tf}`);
  const unit = m[2] === "m" ? 60_000 : m[2] === "H" ? 3_600_000 : 86_400_000;
  return Number(m[1]) * unit;
}
