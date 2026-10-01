// M1 scope item 1 — shared OKX types.
// Spec §7.2 (instruments: tickSz/lotSz/minSz/ctVal/ctValCcy), §7.3 (candles),
// §9–§14 (orders/fills), §7.7–§7.8 (balance/positions), §5.2 (demo REST).
//
// OKX payloads are strings; numeric conversion happens only in mappers
// (spec §7.2: sz = number of CONTRACTS, never coin quantity).

export interface InstrumentInfo {
  instId: string;
  // spec §7.2 — price tick size
  tickSz: string;
  // spec §7.2/§24 — lot size (contract step)
  lotSz: string;
  // spec §7.2/§24 — minimum order size (contracts)
  minSz: string;
  // spec §7.2 — contract value
  ctVal: string;
  // spec §7.2 — contract value currency
  ctValCcy: string;
}

// spec §7.3 — market candle; `confirm` stays the raw OKX flag "0"|"1"
// (latestClosedCandle must filter on confirm === "1")
export interface Candle {
  ts: number;
  o: number;
  h: number;
  l: number;
  c: number;
  vol: number;
  volCcy: number;
  confirm: "0" | "1";
}

export type Side = "buy" | "sell";
export type PosSide = "long" | "short";
export type OrdType = "market" | "post_only" | "limit";
export type OrderState = "live" | "partially_filled" | "filled" | "canceled";

// spec §9–§13 — order request; tdMode fixed to isolated (spec §22/§48)
export interface OrderRequest {
  instId: string;
  tdMode: "isolated";
  side: Side;
  posSide: PosSide;
  ordType: OrdType;
  // spec §7.2 — contract count, always sent as a string
  sz: string;
  clOrdId?: string;
}

// spec §14 — order detail
export interface OrderDetail {
  ordId: string;
  clOrdId?: string;
  instId: string;
  tdMode: "isolated";
  side: Side;
  posSide: PosSide;
  ordType: OrdType;
  sz: string;
  accFillSz: string;
  avgPx?: string;
  px?: string;
  state: OrderState;
  lever: string;
  cTime: string;
  uTime: string;
}

// spec §14 — trade fills
export interface Fill {
  instId: string;
  tradeId: string;
  ordId: string;
  clOrdId?: string;
  fillPx: string;
  fillSz: string;
  side: Side;
  posSide: PosSide;
  execType: "T" | "M";
  ts: string;
  fee: string;
  feeCcy: string;
}

// spec §7.8 — position (exchange is source of truth, spec §7.8/§45)
export interface Position {
  posId: string;
  instId: string;
  posSide: PosSide;
  pos: string;
  avgPx: string;
  markPx: string;
  lever: string;
  upl: string;
  mgnMode: "isolated";
}

// spec §5.2/§6 — generic OKX REST envelope
export interface OkxResponse<T> {
  code: string;
  msg: string;
  data: T;
}
