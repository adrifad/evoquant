// M2 — feature snapshot (§17/§18): OHLCV → trend/momentum/volatility/volume.
import type { Candle } from "../exchange/okx/types.ts";
import { adx as adxCalc, ema, rsi, sma, toChronological } from "./indicators.ts";

export interface FeatureSnapshot {
  ts: number;
  instrument: string;
  price: number;
  ema20: number;
  ema50: number;
  emaSpreadPct: number; // (ema20-ema50)/ema50*100
  rsi14: number;
  adx14: number;
  atr14: number;
  atrPct: number;
  volume: number;
  volumeSma20: number;
  volumeRatio: number;
  sufficientData: boolean;
}

// Needs >= 59 closed candles for ema50 warm-up (§42 warm-up).
export function buildFeatures(
  instrument: string,
  candlesNewestFirst: Candle[],
): FeatureSnapshot {
  const ch = toChronological(candlesNewestFirst.filter((c) => c.confirm === "1"));
  const closes = ch.map((c) => c.c);
  const vols = ch.map((c) => c.vol);
  const e20 = ema(closes, 20);
  const e50 = ema(closes, 50);
  const r = rsi(closes, 14);
  const a = adxCalc(ch, 14);
  const at = ema(trueRangeForAtr(ch), 14); // ATR proxy for stop math (Wilder atr in indicators for exact)
  const vs20 = sma(vols, 20);
  const i = closes.length - 1;
  const last = ch[i];
  const ema20v = e20[i] ?? NaN;
  const ema50v = e50[i] ?? NaN;
  const atr14v = at[i] ?? NaN;
  const volSma = vs20[i] ?? NaN;
  const ok = closes.length >= 59 && !Number.isNaN(ema50v) && !Number.isNaN(volSma) && volSma > 0;
  return {
    ts: last?.ts ?? 0,
    instrument,
    price: last?.c ?? NaN,
    ema20: ema20v,
    ema50: ema50v,
    emaSpreadPct: ok ? ((ema20v - ema50v) / ema50v) * 100 : NaN,
    rsi14: r[i] ?? NaN,
    adx14: a.adx[i] ?? NaN,
    atr14: atr14v,
    atrPct: ok && last ? (atr14v / last.c) * 100 : NaN,
    volume: last?.vol ?? NaN,
    volumeSma20: volSma,
    volumeRatio: ok ? (last!.vol ?? 0) / volSma : NaN,
    sufficientData: ok,
  };
}

function trueRangeForAtr(ch: Candle[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < ch.length; i++) {
    const c = ch[i]!;
    out.push(i === 0 ? c.h - c.l : Math.max(c.h - c.l, Math.abs(c.h - ch[i - 1]!.c), Math.abs(c.l - ch[i - 1]!.c)));
  }
  return out;
}
