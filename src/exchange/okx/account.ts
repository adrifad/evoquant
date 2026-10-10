// M1 scope item — private account endpoints.
// Spec §7.7 (balance), §7.8 (positions — exchange is source of truth, §7.8/§45),
// §7.10 (set-leverage: isolated long/short mode is position-side aware; BOTH
// sides configured at startup; lever never exceeds leverage.hard_max from
// config/risk.yaml — spec §3/§22/§24: risk constants are never mutable by
// agent output).
//
// OKX payloads are strings; numeric conversion happens only in mappers.

import { firstOf, type OkxClient } from "./client.ts";
import type { Position } from "./types.ts";

export interface FundingBill {
  billId: string;
  instId: string;
  ts: string;
  balChg: string;
  ccy: string;
  type: string;
  subType: string;
}

interface RawFundingBill {
  billId?: string;
  instId?: string;
  ts?: string;
  balChg?: string;
  ccy?: string;
  type?: string;
  subType?: string;
}

/**
 * Account bills are the exchange ledger source for realized funding. The
 * caller filters the exact position interval and must treat a failed request
 * as unknown, never as zero.
 */
export async function getFundingBills(client: OkxClient, instId: string, begin: number, end: number, nowMs: number = Date.now()): Promise<FundingBill[]> {
  const path = nowMs - end > 6 * 24 * 60 * 60 * 1000 ? "/api/v5/account/bills-archive" : "/api/v5/account/bills";
  const data = await client.get<RawFundingBill[]>(path, {
    instType: "SWAP", instId, begin: String(begin), end: String(end), limit: "100",
  }, true);
  return data.map((raw) => ({
    billId: String(raw.billId ?? ""), instId: String(raw.instId ?? ""), ts: String(raw.ts ?? ""),
    balChg: String(raw.balChg ?? ""), ccy: String(raw.ccy ?? ""), type: String(raw.type ?? ""), subType: String(raw.subType ?? ""),
  })).filter((bill) => bill.type === "8" || bill.subType === "173" || bill.subType === "174");
}

// Spec §7.7 — balance detail for one currency (all strings from OKX).
export interface BalanceDetail {
  ccy: string;
  availEq: string;
  availBal: string;
  eq: string;
}

// Spec §7.7 — account balance; totalEq in USD, details per currency.
export interface AccountBalance {
  totalEq: string;
  details: BalanceDetail[];
}

interface RawBalance {
  totalEq?: string;
  details?: RawBalanceDetail[];
}

interface RawBalanceDetail {
  ccy?: string;
  availEq?: string;
  availBal?: string;
  eq?: string;
}

// Spec §7.7 — account balance (private endpoint, x-simulated-trading: 1).
export async function getBalance(client: OkxClient, ccy?: string): Promise<AccountBalance> {
  const data = await client.get<RawBalance[]>(
    "/api/v5/account/balance",
    ccy === undefined ? undefined : { ccy },
    true,
  );
  const raw = firstOf(data, "account balance");
  const details = (raw.details ?? []).map((d): BalanceDetail => ({
    ccy: String(d.ccy ?? ""),
    availEq: String(d.availEq ?? ""),
    availBal: String(d.availBal ?? ""),
    eq: String(d.eq ?? ""),
  }));
  return { totalEq: String(raw.totalEq ?? ""), details };
}

interface RawPosition {
  posId?: string;
  instId?: string;
  posSide?: string;
  pos?: string;
  avgPx?: string;
  markPx?: string;
  lever?: string;
  upl?: string;
  mgnMode?: string;
  margin?: string;
  imr?: string;
  notionalUsd?: string;
  ccy?: string;
  uTime?: string;
}

function mapPosition(raw: RawPosition): Position {
  return {
    posId: String(raw.posId ?? ""),
    instId: String(raw.instId ?? ""),
    posSide: raw.posSide === "short" ? "short" : "long",
    // Spec §7.2 — pos is the number of CONTRACTS (never coin quantity).
    pos: String(raw.pos ?? "0"),
    avgPx: String(raw.avgPx ?? ""),
    markPx: String(raw.markPx ?? ""),
    lever: String(raw.lever ?? ""),
    upl: String(raw.upl ?? ""),
    mgnMode: raw.mgnMode === "isolated" || raw.mgnMode === "cross" ? raw.mgnMode : "unknown",
    margin: String(raw.margin ?? ""), imr: String(raw.imr ?? ""),
    notionalUsd: String(raw.notionalUsd ?? ""), ccy: String(raw.ccy ?? ""), uTime: String(raw.uTime ?? ""),
  };
}

// Spec §7.8 — positions (private endpoint). Exchange is source of truth
// (spec §7.8/§45): reconcile against this after restart.
export async function getPositions(client: OkxClient, instId?: string): Promise<Position[]> {
  const data = await client.get<RawPosition[]>(
    "/api/v5/account/positions",
    instId === undefined ? undefined : { instId },
    true,
  );
  return data.map(mapPosition);
}

export class LeverageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LeverageError";
  }
}

// Spec §7.10 — set-leverage response for one side (echoed config).
export interface SetLeverageResult {
  instId: string;
  lever: string;
  mgnMode: "isolated";
  posSide: "long" | "short";
}

interface RawSetLeverage {
  instId?: string;
  lever?: string;
  posSide?: string;
  mgnMode?: string;
}

// Spec §7.10 — set leverage for ONE position side (isolated long/short mode).
async function setLeverageForSide(
  client: OkxClient,
  instId: string,
  lever: number,
  posSide: "long" | "short",
): Promise<SetLeverageResult> {
  const data = await client.post<RawSetLeverage[]>(
    "/api/v5/account/set-leverage",
    { instId, lever: String(lever), posSide, mgnMode: "isolated" },
    true,
  );
  const raw = firstOf(data, `set leverage ${instId} ${posSide}`);
  return {
    instId: String(raw.instId ?? instId),
    lever: String(raw.lever ?? ""),
    mgnMode: "isolated",
    posSide: raw.posSide === "short" ? "short" : "long",
  };
}

// Spec §7.10 — configure leverage for BOTH posSides (long + short) at startup,
// isolated margin mode. Spec §3/§22/§24 — hard cap: the requested lever must
// never exceed hardMaxLever (config/risk.yaml leverage.hard_max); this module
// never accepts a lever above the cap regardless of who asks.
export async function setLeverage(
  client: OkxClient,
  instId: string,
  lever: number,
  hardMaxLever: number,
): Promise<{ long: SetLeverageResult; short: SetLeverageResult }> {
  if (!Number.isFinite(lever) || lever <= 0) {
    throw new LeverageError(`lever must be a positive finite number, got "${String(lever)}"`);
  }
  if (lever > hardMaxLever) {
    throw new LeverageError(
      `lever ${lever} exceeds hard_max ${hardMaxLever} (config/risk.yaml, spec §22/§24)`,
    );
  }
  const long = await setLeverageForSide(client, instId, lever, "long");
  const short = await setLeverageForSide(client, instId, lever, "short");
  return { long, short };
}
