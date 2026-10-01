// M2 (§38 deterministic indicator engine, §17/§18 feature set).
// All functions take CHRONOLOGICAL arrays (oldest first) and return arrays
// aligned to input length; warm-up positions are NaN.

import type { Candle } from "../exchange/okx/types.ts";

export function toChronological(candles: Candle[]): Candle[] {
  return [...candles].sort((a, b) => a.ts - b.ts);
}

export function sma(values: number[], period: number): number[] {
  const out: number[] = [];
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i]!;
    if (i >= period) sum -= values[i - period]!;
    out.push(i >= period - 1 ? sum / period : NaN);
  }
  return out;
}

export function ema(values: number[], period: number): number[] {
  const k = 2 / (period + 1);
  const out: number[] = [];
  let prev = NaN;
  for (let i = 0; i < values.length; i++) {
    const v = values[i]!;
    prev = i === 0 ? v : v * k + prev * (1 - k);
    out.push(i >= period - 1 ? prev : NaN);
  }
  return out;
}

// Wilder RSI (§18 momentum).
export function rsi(closes: number[], period = 14): number[] {
  const out: number[] = new Array(closes.length).fill(NaN);
  if (closes.length <= period) return out;
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const ch = closes[i]! - closes[i - 1]!;
    avgGain += Math.max(ch, 0) / period;
    avgLoss += Math.max(-ch, 0) / period;
  }
  out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = period + 1; i < closes.length; i++) {
    const ch = closes[i]! - closes[i - 1]!;
    avgGain = (avgGain * (period - 1) + Math.max(ch, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-ch, 0)) / period;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

export function trueRanges(candles: Candle[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i]!;
    if (i === 0) { out.push(c.h - c.l); continue; }
    const p = candles[i - 1]!;
    out.push(Math.max(c.h - c.l, Math.abs(c.h - p.c), Math.abs(c.l - p.c)));
  }
  return out;
}

// Wilder-smoothed ATR (§18 volatility).
export function atr(candles: Candle[], period = 14): number[] {
  const trs = trueRanges(candles);
  const out: number[] = new Array(candles.length).fill(NaN);
  if (candles.length < period) return out;
  let prev = 0;
  for (let i = 0; i < period; i++) prev += trs[i]!;
  prev /= period;
  out[period - 1] = prev;
  for (let i = period; i < candles.length; i++) {
    prev = (prev * (period - 1) + trs[i]!) / period;
    out[i] = prev;
  }
  return out;
}

// Wilder ADX with +DI/-DI (§18 momentum/trend strength).
export function adx(candles: Candle[], period = 14): { adx: number[]; plusDi: number[]; minusDi: number[] } {
  const n = candles.length;
  const adxOut: number[] = new Array(n).fill(NaN);
  const plusDi: number[] = new Array(n).fill(NaN);
  const minusDi: number[] = new Array(n).fill(NaN);
  if (n < period * 2) return { adx: adxOut, plusDi, minusDi };
  const trs = trueRanges(candles);
  let sTr = 0, sPlus = 0, sMinus = 0;
  for (let i = 1; i <= period; i++) {
    const up = candles[i]!.h - candles[i - 1]!.h;
    const dn = candles[i - 1]!.l - candles[i]!.l;
    sPlus += up > 0 && up > dn ? up : 0;
    sMinus += dn > 0 && dn > up ? dn : 0;
    sTr += trs[i]!;
  }
  const di = (i: number): void => {
    plusDi[i] = sTr === 0 ? 0 : (100 * sPlus) / sTr;
    minusDi[i] = sTr === 0 ? 0 : (100 * sMinus) / sTr;
  };
  di(period);
  const dx = (i: number): number => {
    const sum = plusDi[i]! + minusDi[i]!;
    return sum === 0 ? 0 : (100 * Math.abs(plusDi[i]! - minusDi[i]!)) / sum;
  };
  for (let i = period + 1; i < n; i++) {
    const up = candles[i]!.h - candles[i - 1]!.h;
    const dn = candles[i - 1]!.l - candles[i]!.l;
    sTr = sTr - sTr / period + trs[i]!;
    sPlus = sPlus - sPlus / period + (up > 0 && up > dn ? up : 0);
    sMinus = sMinus - sMinus / period + (dn > 0 && dn > up ? dn : 0);
    di(i);
  }
  // ADX: Wilder smoothing of DX, first ADX = mean of first `period` DX values
  const dxStart = period;
  let sumDx = 0;
  for (let i = dxStart; i < dxStart + period && i < n; i++) sumDx += dx(i);
  let prevAdx = sumDx / period;
  adxOut[dxStart + period - 1] = prevAdx;
  for (let i = dxStart + period; i < n; i++) {
    prevAdx = (prevAdx * (period - 1) + dx(i)) / period;
    adxOut[i] = prevAdx;
  }
  return { adx: adxOut, plusDi, minusDi };
}
