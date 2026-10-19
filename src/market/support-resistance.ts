import type { Candle } from "../exchange/okx/types.ts";
import { detectMarketStructure, type ConfirmedPivot } from "./market-structure.ts";

export interface PriceZone {
  kind: "SUPPORT" | "RESISTANCE";
  low: number;
  high: number;
  center: number;
  touches: number;
  firstTouchedAt: number;
  lastTouchedAt: number;
  ageBars: number;
  confirmed: true;
  broken: boolean;
  rejectionStrength: number;
  algorithmVersion: "zones-v1";
}

export interface SupportResistanceOptions {
  leftBars?: number;
  rightBars?: number;
  lookbackBars?: number;
  toleranceAtr?: number;
  minTouchSeparationBars?: number;
}

export interface SupportResistanceSnapshot {
  instrument: string;
  timeframe: string;
  evaluatedAt: number | null;
  atr: number;
  zones: PriceZone[];
  support: PriceZone[];
  resistance: PriceZone[];
  nearestSupport: PriceZone | null;
  nearestResistance: PriceZone | null;
  positionInRange: number | null;
  algorithmVersion: "zones-v1";
}

/** Cluster only confirmed pivots; separated pivot confirmations are counted as
 * independent reactions, never as repeated candle observations in a window.
 */
export function detectSupportResistance(instrument: string, timeframe: string, input: readonly Candle[], atr: number,
  options: SupportResistanceOptions = {}): SupportResistanceSnapshot {
  if (!Number.isFinite(atr) || atr <= 0) throw new Error("support/resistance requires positive finite ATR");
  const candles = input.filter((c) => c.confirm === "1").slice().sort((a, b) => a.ts - b.ts);
  const lookback = options.lookbackBars ?? 120;
  const toleranceAtr = options.toleranceAtr ?? 0.25;
  const separation = options.minTouchSeparationBars ?? 3;
  if (!Number.isInteger(lookback) || lookback < 3 || !Number.isFinite(toleranceAtr) || toleranceAtr <= 0
    || !Number.isInteger(separation) || separation < 1) throw new Error("invalid support/resistance options");
  const selected = candles.slice(-lookback);
  const structureOptions = { ...(options.leftBars !== undefined ? { leftBars: options.leftBars } : {}),
    ...(options.rightBars !== undefined ? { rightBars: options.rightBars } : {}) };
  const structure = detectMarketStructure(instrument, timeframe, selected, structureOptions);
  const indexByTs = new Map(selected.map((candle, index) => [candle.ts, index]));
  const tolerance = atr * toleranceAtr;
  const groups: Array<{ kind: "SUPPORT" | "RESISTANCE"; points: Array<{ pivot: ConfirmedPivot; index: number; rejection: number }> }> = [];
  for (const pivot of structure.pivots) {
    const kind = pivot.kind === "SWING_LOW" ? "SUPPORT" : "RESISTANCE";
    const index = indexByTs.get(pivot.ts);
    if (index === undefined) continue;
    const candle = selected[index]!;
    const rejection = kind === "SUPPORT" ? Math.max(0, candle.c - candle.l) / atr : Math.max(0, candle.h - candle.c) / atr;
    const group = groups.find((candidate) => candidate.kind === kind
      && candidate.points.at(-1)!.index <= index - separation
      && Math.abs(candidate.points.reduce((sum, point) => sum + point.pivot.price, 0) / candidate.points.length - pivot.price) <= tolerance);
    if (group) group.points.push({ pivot, index, rejection });
    else groups.push({ kind, points: [{ pivot, index, rejection }] });
  }
  const latest = selected.at(-1);
  const zones: PriceZone[] = groups.map<PriceZone>((group) => {
    const prices = group.points.map((point) => point.pivot.price);
    const center = prices.reduce((sum, price) => sum + price, 0) / prices.length;
    const low = center - tolerance / 2, high = center + tolerance / 2;
    const broken = Boolean(latest && (group.kind === "RESISTANCE" ? latest.c > high : latest.c < low));
    return { kind: group.kind, low, high, center, touches: group.points.length,
      firstTouchedAt: group.points[0]!.pivot.ts, lastTouchedAt: group.points.at(-1)!.pivot.ts,
      ageBars: latest ? selected.length - 1 - (indexByTs.get(group.points.at(-1)!.pivot.ts) ?? selected.length - 1) : 0,
      confirmed: true as const, broken, rejectionStrength: round(group.points.reduce((sum, point) => sum + point.rejection, 0) / group.points.length),
      algorithmVersion: "zones-v1" as const };
  }).sort((a, b) => a.center - b.center || a.kind.localeCompare(b.kind));
  const price = latest?.c ?? NaN;
  const support = zones.filter((zone) => zone.kind === "SUPPORT");
  const resistance = zones.filter((zone) => zone.kind === "RESISTANCE");
  const nearestSupport = support.filter((zone) => zone.center <= price).sort((a, b) => b.center - a.center)[0] ?? null;
  const nearestResistance = resistance.filter((zone) => zone.center >= price).sort((a, b) => a.center - b.center)[0] ?? null;
  const positionInRange = nearestSupport && nearestResistance && nearestResistance.center > nearestSupport.center
    ? round(Math.max(0, Math.min(1, (price - nearestSupport.center) / (nearestResistance.center - nearestSupport.center)))) : null;
  return { instrument, timeframe, evaluatedAt: latest?.ts ?? null, atr, zones, support, resistance,
    nearestSupport, nearestResistance, positionInRange, algorithmVersion: "zones-v1" };
}

function round(value: number): number { return Math.round(value * 1e6) / 1e6; }
