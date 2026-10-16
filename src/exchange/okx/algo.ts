// Exchange-native conditional protection for OKX USDT perpetual positions.
// OKX conditional orders cannot carry TP and SL trigger pairs together: the
// current API docs say the combination is rejected or only SL is performed.
// Keep the legs independent so each can be verified and the stop can be
// amended without changing the take-profit order.

import type { OkxClient } from "./client.ts";
import { firstOf } from "./client.ts";
import type { PosSide, Side } from "./types.ts";

export interface ConditionalProtection {
  instId: string;
  posSide: PosSide;
  contracts: string;
  tickSz: string;
  stopPrice: number;
  takeProfitPrice: number;
  clAlgoId?: string;
}

export interface AlgoResult { algoId: string; clAlgoId: string }
export interface ProtectionResult { stop: AlgoResult; takeProfit: AlgoResult }
export interface AlgoOrderDetail {
  algoId: string;
  state: string;
  instId: string;
  tdMode: string;
  side: string;
  posSide: string;
  ordType: string;
  sz: string;
  slTriggerPx: string;
  slTriggerPxType: string;
  tpTriggerPx: string;
  tpTriggerPxType: string;
}

function decimalParts(value: string): { coefficient: bigint; scale: number } | null {
  const match = value.trim().match(/^([+-]?)(\d+)(?:\.(\d*))?(?:e([+-]?\d+))?$/i);
  if (!match) return null;
  const fraction = match[3] ?? "";
  const exponent = Number(match[4] ?? 0);
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 24) return null;
  const digits = `${match[2]}${fraction}`.replace(/^0+(?=\d)/, "");
  let coefficient = BigInt(digits || "0") * (match[1] === "-" ? -1n : 1n);
  let scale = fraction.length - exponent;
  if (scale < 0) { coefficient *= 10n ** BigInt(-scale); scale = 0; }
  while (scale > 0 && coefficient % 10n === 0n) { coefficient /= 10n; scale -= 1; }
  return { coefficient, scale };
}

/** Normalize to an exact tick multiple. `up`/`down` are price directions. */
export function normalizePriceToTick(price: number, tickSz: string, direction: "up" | "down"): string {
  if (!Number.isFinite(price) || price <= 0) throw new Error("invalid protection price");
  const p = decimalParts(String(price)); const tick = decimalParts(tickSz);
  if (!p || !tick || tick.coefficient <= 0n) throw new Error("invalid instrument tick size");
  const scale = Math.max(p.scale, tick.scale);
  const pInt = p.coefficient * 10n ** BigInt(scale - p.scale);
  const tickInt = tick.coefficient * 10n ** BigInt(scale - tick.scale);
  let quotient = pInt / tickInt;
  const remainder = pInt % tickInt;
  if (remainder !== 0n && direction === "up") quotient += 1n;
  const normalized = quotient * tickInt;
  const digits = normalized.toString().padStart(scale + 1, "0");
  const text = scale ? `${digits.slice(0, -scale)}.${digits.slice(-scale)}` : digits;
  const result = text.includes(".") ? text.replace(/0+$/, "").replace(/\.$/, "") : text;
  if (!result || Number(result) <= 0) throw new Error("normalized protection price is invalid");
  return result;
}

function closeSide(posSide: PosSide): Side { return posSide === "long" ? "sell" : "buy"; }

export function protectionClientIds(base: string): { stop: string; takeProfit: string } {
  return { stop: `${base.slice(0, 30)}SL`, takeProfit: `${base.slice(0, 30)}TP` };
}

async function placeLeg(client: OkxClient, p: ConditionalProtection, kind: "SL" | "TP", price: string): Promise<AlgoResult> {
  const clientIds = p.clAlgoId ? protectionClientIds(p.clAlgoId) : undefined;
  const common = {
    instId: p.instId, tdMode: "isolated", side: closeSide(p.posSide), posSide: p.posSide,
    ordType: "conditional", sz: p.contracts,
    ...(clientIds ? { algoClOrdId: kind === "SL" ? clientIds.stop : clientIds.takeProfit } : {}),
  };
  const body = kind === "SL"
    ? { ...common, slTriggerPx: price, slOrdPx: "-1", slTriggerPxType: "mark" }
    : { ...common, tpTriggerPx: price, tpOrdPx: "-1", tpTriggerPxType: "mark" };
  const data = await client.post<Array<Record<string, string>>>("/api/v5/trade/order-algo", body, true);
  const first = firstOf(data, "order-algo response");
  if (first.sCode !== "0") throw new Error(`algo ${kind} rejected: sCode=${first.sCode ?? "missing"}`);
  const algoId = first.algoId ?? "";
  if (!algoId) throw new Error(`algo ${kind} response missing algoId`);
  return { algoId, clAlgoId: first.algoClOrdId ?? (clientIds ? (kind === "SL" ? clientIds.stop : clientIds.takeProfit) : "") };
}

function verifyLeg(detail: AlgoOrderDetail, args: { instId: string; posSide: PosSide; contracts: string; kind: "SL" | "TP"; price: string }): void {
  const expectedSide = closeSide(args.posSide);
  if (detail.state !== "live" || detail.instId !== args.instId || detail.tdMode !== "isolated" || detail.side !== expectedSide
    || detail.posSide !== args.posSide || detail.ordType !== "conditional" || Number(detail.sz) !== Number(args.contracts)) {
    throw new Error(`algo ${args.kind} not verified live for exact position`);
  }
  if ((args.kind === "SL" ? detail.slTriggerPxType : detail.tpTriggerPxType) !== "mark") {
    throw new Error(`algo ${args.kind} trigger type mismatch`);
  }
  const actual = Number(args.kind === "SL" ? detail.slTriggerPx : detail.tpTriggerPx);
  if (!Number.isFinite(actual) || Math.abs(actual - Number(args.price)) > Math.max(Number(args.price) * 1e-12, 1e-12)) {
    throw new Error(`algo ${args.kind} trigger mismatch`);
  }
}

export async function placeConditionalProtection(client: OkxClient, p: ConditionalProtection): Promise<ProtectionResult> {
  const stopPrice = normalizePriceToTick(p.stopPrice, p.tickSz, p.posSide === "long" ? "up" : "down");
  // Round targets toward entry so tick normalization never silently expands
  // the intended target distance; stops round toward entry to avoid increasing risk.
  const takeProfitPrice = normalizePriceToTick(p.takeProfitPrice, p.tickSz, p.posSide === "long" ? "down" : "up");
  if (p.posSide === "long" ? Number(stopPrice) >= Number(takeProfitPrice) : Number(stopPrice) <= Number(takeProfitPrice)) {
    throw new Error("normalized protection prices do not preserve stop/target geometry");
  }
  if (!Number.isFinite(Number(p.contracts)) || Number(p.contracts) <= 0) throw new Error("invalid protection contract size");
  // Put the loss-limiting leg first. Never claim success without re-reading
  // both exact algo IDs and verifying their active state/side/size/trigger.
  const stop = await placeLeg(client, p, "SL", stopPrice);
  try {
    verifyLeg(await getAlgoOrder(client, p.instId, stop.algoId), { instId: p.instId, posSide: p.posSide, contracts: p.contracts, kind: "SL", price: stopPrice });
  } catch (error) {
    throw new ProtectionPlacementError("STOP_PROTECTION_UNVERIFIED", stop, null, error);
  }
  let takeProfit: AlgoResult | null = null;
  try {
    takeProfit = await placeLeg(client, p, "TP", takeProfitPrice);
    verifyLeg(await getAlgoOrder(client, p.instId, takeProfit.algoId), { instId: p.instId, posSide: p.posSide, contracts: p.contracts, kind: "TP", price: takeProfitPrice });
  } catch (error) {
    throw new ProtectionPlacementError("TAKE_PROFIT_PROTECTION_UNVERIFIED", stop, takeProfit, error);
  }
  return { stop, takeProfit };
}

// Carries any known algo IDs so callers can preserve and later reconcile a
// successfully placed stop even if TP placement/verification failed.
export class ProtectionPlacementError extends Error {
  readonly stop: AlgoResult | null;
  readonly takeProfit: AlgoResult | null;
  constructor(message: string, stop: AlgoResult | null, takeProfit: AlgoResult | null, cause?: unknown) {
    super(message, { cause });
    this.name = "ProtectionPlacementError";
    this.stop = stop;
    this.takeProfit = takeProfit;
  }
}

export async function amendConditionalStop(client: OkxClient, args: {
  instId: string; algoId: string; stopPrice: number; tickSz: string; posSide: PosSide;
}): Promise<void> {
  const stopPrice = normalizePriceToTick(args.stopPrice, args.tickSz, args.posSide === "long" ? "up" : "down");
  const data = await client.post<Array<Record<string, string>>>("/api/v5/trade/amend-algos", {
    instId: args.instId, algoId: args.algoId, newSlTriggerPx: stopPrice,
    newSlOrdPx: "-1", newSlTriggerPxType: "mark", cxlOnFail: false,
  }, true);
  const first = firstOf(data, "amend-algos response");
  if (first.sCode !== "0") throw new Error(`algo amend rejected: sCode=${first.sCode ?? "missing"}`);
}

export async function getAlgoOrder(client: OkxClient, instId: string, algoId: string): Promise<AlgoOrderDetail> {
  const data = await client.get<Array<Record<string, string>>>("/api/v5/trade/order-algo", { instId, algoId }, true);
  const first = firstOf(data, "algo order detail");
  return { algoId: first.algoId ?? algoId, state: first.state ?? "", instId: first.instId ?? "",
    tdMode: first.tdMode ?? "", side: first.side ?? "", posSide: first.posSide ?? "", ordType: first.ordType ?? "",
    sz: first.sz ?? "", slTriggerPx: first.slTriggerPx ?? "", slTriggerPxType: first.slTriggerPxType ?? "",
    tpTriggerPx: first.tpTriggerPx ?? "", tpTriggerPxType: first.tpTriggerPxType ?? "" };
}

/** Exact lookup is used after a timed-out placement response. Empty successful
 * result means absent; transport/API errors propagate so callers never duplicate. */
export async function getAlgoOrderByClientId(client: OkxClient, instId: string, algoClOrdId: string): Promise<AlgoOrderDetail | null> {
  const data = await client.get<Array<Record<string, string>>>("/api/v5/trade/order-algo", { instId, algoClOrdId }, true);
  const first = data[0];
  if (!first) return null;
  return { algoId: first.algoId ?? "", state: first.state ?? "", instId: first.instId ?? "", tdMode: first.tdMode ?? "",
    side: first.side ?? "", posSide: first.posSide ?? "", ordType: first.ordType ?? "", sz: first.sz ?? "",
    slTriggerPx: first.slTriggerPx ?? "", slTriggerPxType: first.slTriggerPxType ?? "",
    tpTriggerPx: first.tpTriggerPx ?? "", tpTriggerPxType: first.tpTriggerPxType ?? "" };
}

export async function cancelAlgo(client: OkxClient, instId: string, algoId: string): Promise<void> {
  const data = await client.post<Array<Record<string, string>>>("/api/v5/trade/cancel-algos", [{ instId, algoId }], true);
  const first = data[0];
  if (first && first.sCode && first.sCode !== "0") throw new Error(`algo cancel failed: sCode=${first.sCode}`);
}
