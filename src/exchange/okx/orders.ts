// M1 scope item 6 — trade endpoints: place/query/close orders + lifecycle wait.
// Spec §9–§15. sz is ALWAYS a normalized contract-count string (§7.2/§24 —
// NOT coin quantity). Every order carries clOrdId (§15). HTTP acceptance
// (sCode "0") is NOT a completed trade — confirm via getOrder /
// waitForOrderTerminal (§14). tdMode fixed isolated (§3). No secrets logged.

import type { OkxClient } from "./client.ts";
import { firstOf } from "./client.ts";
import { normalizeContractSize } from "./sizing.ts";
import type { Fill, OrderDetail, OrderRequest, PosSide, Side } from "./types.ts";

export class OrderRejectedError extends Error {
  readonly sCode: string;
  constructor(sCode: string, sMsg: string) {
    super(`order rejected by OKX: sCode=${sCode} sMsg=${sMsg || "(none)"}`);
    this.name = "OrderRejectedError";
    this.sCode = sCode;
  }
}

export class OrderTimeoutError extends Error {
  readonly ordId: string;
  readonly lastState: string | undefined;
  constructor(ordId: string, lastState: string | undefined) {
    super(`order ${ordId} did not reach terminal state within timeout (last: ${lastState ?? "unknown"})`);
    this.name = "OrderTimeoutError";
    this.ordId = ordId;
    this.lastState = lastState;
  }
}

export interface PlaceOrderResult {
  ordId: string;
  clOrdId: string;
  sCode: string;
  sMsg: string;
}

// spec §9–§13 — submit one order. Per-item sCode "0" = accepted for
// processing only; fill state must be confirmed separately (§14).
export async function placeOrder(client: OkxClient, order: OrderRequest): Promise<PlaceOrderResult> {
  const data = await client.post<Array<Record<string, string>>>("/api/v5/trade/order", order, true);
  const first = firstOf(data, "trade/order response");
  const sCode = first.sCode ?? "";
  if (sCode !== "0") throw new OrderRejectedError(sCode, first.sMsg ?? "");
  return {
    ordId: first.ordId ?? "",
    clOrdId: first.clOrdId ?? order.clOrdId ?? "",
    sCode,
    sMsg: first.sMsg ?? "",
  };
}

// spec §24 — normalize desired contracts against metadata BEFORE submission.
// Argument order matches sizing.ts: normalizeContractSize(size, instrument).
export function prepareOrderSize(
  desiredContracts: string | number,
  instrument: { lotSz: string; minSz: string },
): string {
  return normalizeContractSize(desiredContracts, instrument);
}

function mapOrderDetail(raw: Record<string, string>, fallbackInstId: string): OrderDetail {
  return {
    ordId: raw.ordId ?? "",
    ...(raw.clOrdId !== undefined ? { clOrdId: raw.clOrdId } : {}),
    instId: raw.instId ?? fallbackInstId,
    tdMode: "isolated",
    side: (raw.side as Side) ?? "buy",
    posSide: (raw.posSide as PosSide) ?? "long",
    ordType: (raw.ordType as OrderDetail["ordType"]) ?? "market",
    sz: raw.sz ?? "",
    accFillSz: raw.accFillSz ?? raw.fillSz ?? "",
    ...(raw.avgPx !== undefined && raw.avgPx !== "" ? { avgPx: raw.avgPx } : {}),
    ...(raw.px !== undefined && raw.px !== "" ? { px: raw.px } : {}),
    state: (raw.state as OrderDetail["state"]) ?? "canceled",
    lever: raw.lever ?? "",
    cTime: raw.cTime ?? "",
    uTime: raw.uTime ?? "",
  };
}

// spec §14 — order detail
export async function getOrder(client: OkxClient, instId: string, ordId: string): Promise<OrderDetail> {
  const data = await client.get<Array<Record<string, string>>>(
    "/api/v5/trade/order",
    { instId, ordId },
    true,
  );
  return mapOrderDetail(firstOf(data, "trade/order detail"), instId);
}

// spec §14 — pending orders (also used for startup/restart reconciliation §43/§45)
export async function getPendingOrders(client: OkxClient, instId?: string): Promise<OrderDetail[]> {
  const data = await client.get<Array<Record<string, string>>>(
    "/api/v5/trade/orders-pending",
    instId ? { instType: "SWAP", instId } : { instType: "SWAP" },
    true,
  );
  return data.map((raw) => mapOrderDetail(raw, instId ?? raw.instId ?? ""));
}

function mapFill(raw: Record<string, string>): Fill {
  return {
    instId: raw.instId ?? "",
    tradeId: raw.tradeId ?? "",
    ordId: raw.ordId ?? "",
    ...(raw.clOrdId !== undefined ? { clOrdId: raw.clOrdId } : {}),
    fillPx: raw.fillPx ?? "",
    fillSz: raw.fillSz ?? "",
    side: (raw.side as Side) ?? "buy",
    posSide: (raw.posSide as PosSide) ?? "long",
    execType: raw.execType === "M" ? "M" : "T",
    ts: raw.ts ?? "",
    fee: raw.fee ?? "",
    feeCcy: raw.feeCcy ?? "",
  };
}

// spec §14 — recent fills
export async function getFills(client: OkxClient, instId?: string, ordId?: string): Promise<Fill[]> {
  const data = await client.get<Array<Record<string, string>>>(
    "/api/v5/trade/fills",
    { instType: "SWAP", ...(instId ? { instId } : {}), ...(ordId ? { ordId } : {}) },
    true,
  );
  return data.map(mapFill);
}

// spec §14 — historical fills (type 0 = normal order fills)
export async function getFillsHistory(client: OkxClient, instId?: string): Promise<Fill[]> {
  const data = await client.get<Array<Record<string, string>>>(
    "/api/v5/trade/fills-history",
    { instType: "SWAP", type: "0", ...(instId ? { instId } : {}) },
    true,
  );
  return data.map(mapFill);
}

// spec §10/§11/§13 — close a position side: opposite order side, same posSide
// (§4.2 mapping table), sz = current contracts, reduceOnly to never flip.
export async function closePosition(
  client: OkxClient,
  args: {
    instId: string;
    posSide: PosSide;
    contracts: string;
    clOrdId: string;
    lotSz: string;
    minSz: string;
  },
): Promise<PlaceOrderResult> {
  const sz = normalizeContractSize(args.contracts, { lotSz: args.lotSz, minSz: args.minSz });
  const side: Side = args.posSide === "long" ? "sell" : "buy"; // §4.2
  return placeOrder(client, {
    instId: args.instId,
    tdMode: "isolated",
    side,
    posSide: args.posSide,
    ordType: "market",
    sz,
    clOrdId: args.clOrdId,
  });
}

// spec §14 — poll until filled|canceled. "live"/"partially_filled" are not
// terminal; timeout is an error, never a silent success.
export async function waitForOrderTerminal(
  client: OkxClient,
  instId: string,
  ordId: string,
  opts: { timeoutMs?: number; pollMs?: number; now?: () => number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<OrderDetail> {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const pollMs = opts.pollMs ?? 1_000;
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const deadline = now() + timeoutMs;
  let last: OrderDetail | undefined;
  while (now() < deadline) {
    last = await getOrder(client, instId, ordId);
    if (last.state === "filled" || last.state === "canceled") return last;
    await sleep(pollMs);
  }
  throw new OrderTimeoutError(ordId, last?.state);
}
