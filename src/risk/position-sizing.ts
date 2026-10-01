// M2 (§24) — position sizing: risk_budget = equity × risk% ; contracts from
// stop distance and contract spec. Deterministic, clamped to hard maxes;
// result normalized via M1 sizing (lotSz/minSz) before submission.

import { normalizeContractSize } from "../exchange/okx/sizing.ts";
import type { InstrumentInfo } from "../exchange/okx/types.ts";
import type { RiskConfig } from "../core/config.ts";

export interface SizingInput {
  equity: number;          // USDT equity
  entryPrice: number;      // mark/last price
  stopPrice: number;       // protective stop level
  leverage: number;        // isolated leverage (validated ≤ hard max upstream)
  instrument: InstrumentInfo;
}

export interface SizingResult {
  contracts: string;       // lotSz-normalized contract count (§7.2/§24)
  riskBudgetUsdt: number;
  stopDistancePct: number;
  notionalUsdt: number;    // contracts × ctVal × entryPrice
  marginUsdt: number;
  clampedByMargin: boolean;
}

export class SizingUnavailableError extends Error {}

export function sizePosition(
  input: SizingInput,
  risk: RiskConfig,
): SizingResult {
  const { equity, entryPrice, stopPrice, leverage, instrument } = input;
  const stopDistancePct = Math.abs(entryPrice - stopPrice) / entryPrice;
  if (!(entryPrice > 0) || !(stopDistancePct > 0) || stopDistancePct > 0.2 || !(equity > 0)) {
    throw new SizingUnavailableError(`invalid sizing inputs (stop distance ${(stopDistancePct * 100).toFixed(2)}%)`);
  }
  const riskBudgetUsdt = equity * (risk.hard_limits.risk_per_trade_pct / 100);
  // contracts: riskBudget = contracts × ctVal(BTC/contract) × stopDistance × price
  const ctVal = Number(instrument.ctVal);
  if (!(ctVal > 0)) throw new SizingUnavailableError("instrument ctVal missing");
  let contracts = riskBudgetUsdt / (ctVal * stopDistancePct * entryPrice);
  // margin clamp: notional / leverage must fit available margin budget (90% of equity)
  const maxByMargin = (equity * 0.9 * leverage) / (ctVal * entryPrice);
  const clampedByMargin = contracts > maxByMargin;
  if (clampedByMargin) contracts = maxByMargin;
  const contractsStr = normalizeContractSize(contracts, instrument);
  const finalContracts = Number(contractsStr);
  const notionalUsdt = finalContracts * ctVal * entryPrice;
  return {
    contracts: contractsStr,
    riskBudgetUsdt,
    stopDistancePct,
    notionalUsdt,
    marginUsdt: notionalUsdt / leverage,
    clampedByMargin,
  };
}

// stop level helpers (entry ± k×ATR by side) — §3/§25; risk engine validated.
export function stopPriceFor(entry: number, atrValue: number, atrMultiple: number, side: "LONG" | "SHORT"): number {
  const m = Math.max(atrMultiple, 0.1);
  return side === "LONG" ? entry - atrValue * m : entry + atrValue * m;
}

export function takeProfitPriceFor(entry: number, atrValue: number, atrMultiple: number, side: "LONG" | "SHORT"): number {
  const m = Math.max(atrMultiple, 0.1);
  return side === "LONG" ? entry + atrValue * m : entry - atrValue * m;
}
