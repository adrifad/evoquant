// §16 Layer A — exchange-native conditional (SL+TP) algo orders.
// Posted right after an entry fills so protection exists even if the bot dies.
// OKX v5: POST /api/v5/trade/order-algo, algoOrdType=conditional, one order
// can carry BOTH tpTriggerPx and slTriggerPx; px "-1" = market on trigger.

import type { OkxClient } from "./client.ts";
import { firstOf } from "./client.ts";
import type { PosSide, Side } from "./types.ts";

export interface ConditionalProtection {
  instId: string;
  posSide: PosSide;
  contracts: string;        // sz in contracts (§7.2)
  stopPrice: number;        // trigger for SL
  takeProfitPrice: number;  // trigger for TP
  clAlgoId?: string;
}

export interface AlgoResult {
  algoId: string;
  clAlgoId: string;
}

export interface AlgoOrderDetail {
  algoId: string;
  state: string;
  slTriggerPx: string;
}

// close side is opposite of entry side for the same posSide (§4.2)
export async function placeConditionalProtection(
  client: OkxClient,
  p: ConditionalProtection,
): Promise<AlgoResult> {
  const closeSide: Side = p.posSide === "long" ? "sell" : "buy";
  const body: Record<string, string | number> = {
    instId: p.instId,
    tdMode: "isolated",
    side: closeSide,
    posSide: p.posSide,
    ordType: "conditional",
    algoOrdType: "conditional",
    sz: p.contracts,
    // -1 → market order when triggered
    slTriggerPx: p.stopPrice.toFixed(2),
    slOrdPx: "-1",
    slTriggerPxType: "mark",
    tpTriggerPx: p.takeProfitPrice.toFixed(2),
    tpOrdPx: "-1",
    tpTriggerPxType: "mark",
    // posSide pairing already implies reduce semantics; explicit reduceOnly
    // is rejected on conditional algo orders (51000 on OKX v5 demo probe)
  };
  if (p.clAlgoId) body.clOrdId = p.clAlgoId;
  const data = await client.post<Array<Record<string, string>>>("/api/v5/trade/order-algo", body, true);
  const first = firstOf(data, "order-algo response");
  const sCode = first.sCode ?? "";
  if (sCode !== "0") throw new Error(`algo rejected: sCode=${sCode} sMsg=${first.sMsg ?? ""}`);
  return { algoId: first.algoId ?? "", clAlgoId: first.clOrdId ?? p.clAlgoId ?? "" };
}

// Amend the SL on the existing conditional TP/SL algo. cxlOnFail=false keeps
// the previous exchange protection in place if OKX rejects the amendment.
export async function amendConditionalStop(
  client: OkxClient,
  args: { instId: string; algoId: string; stopPrice: number },
): Promise<void> {
  const data = await client.post<Array<Record<string, string>>>("/api/v5/trade/amend-algos", {
    instId: args.instId,
    algoId: args.algoId,
    newSlTriggerPx: args.stopPrice.toFixed(8).replace(/0+$/, "").replace(/\.$/, ""),
    newSlOrdPx: "-1",
    newSlTriggerPxType: "mark",
    cxlOnFail: false,
  }, true);
  const first = firstOf(data, "amend-algos response");
  if (first.sCode !== "0") throw new Error(`algo amend rejected: sCode=${first.sCode ?? "missing"} sMsg=${first.sMsg ?? ""}`);
}

export async function getAlgoOrder(client: OkxClient, instId: string, algoId: string): Promise<AlgoOrderDetail> {
  const data = await client.get<Array<Record<string, string>>>("/api/v5/trade/order-algo", { instId, algoId }, true);
  const first = firstOf(data, "algo order detail");
  return {
    algoId: first.algoId ?? algoId,
    state: first.state ?? "",
    slTriggerPx: first.slTriggerPx ?? "",
  };
}

// §16 — cancel a conditional algo (array body, endpoint `cancel-algos`).
// `cancel-advance-algos` is only for iceberg/twap/trailing per OKX v5 docs.
export async function cancelAlgo(client: OkxClient, instId: string, algoId: string): Promise<void> {
  const data = await client.post<Array<Record<string, string>>>(
    "/api/v5/trade/cancel-algos", [{ instId, algoId }], true, // official v5 endpoint (array body)
  );
  const first = data[0];
  if (first && first.sCode && first.sCode !== "0") {
    throw new Error(`algo cancel failed: sCode=${first.sCode} sMsg=${first.sMsg ?? ""}`);
  }
}
