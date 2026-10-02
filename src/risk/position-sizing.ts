// M2 (§24) — position sizing with two modes:
//   risk_based:        risk_budget = equity × risk% ; contracts from stop distance
//   percent_of_equity: notional per position = position_pct% of equity
//                      (user: "$100 modal, 1% per trade → $1 position")
// Deterministic, clamped to hard maxes; normalized via lotSz/minSz (§7.2/§24).

import { normalizeContractSize } from "../exchange/okx/sizing.ts";
import type { InstrumentInfo } from "../exchange/okx/types.ts";
import type { RiskConfig } from "../core/config.ts";

export type SizingMode = "risk_based" | "percent_of_equity";

export interface SizingConfig {
  mode: SizingMode;
  position_pct: number; // % of equity used as NOTIONAL per position (percent mode)
}

export interface SizingInput {
  equity: number;          // USDT equity
  entryPrice: number;      // mark/last price
  stopPrice: number;       // protective stop level
  leverage: number;        // isolated leverage (validated ≤ hard max upstream)
  instrument: InstrumentInfo;
}

export interface SizingResult {
  contracts: string;       // lotSz-normalized contract count (§7.2/§24)
  riskBudgetUsdt: number;  // risk mode: loss-at-stop budget; percent mode: notional target
  stopDistancePct: number;
  notionalUsdt: number;    // contracts × ctVal × entryPrice
  marginUsdt: number;
  clampedByMargin: boolean;
  mode: SizingMode;
}

export class SizingUnavailableError extends Error {}

/** Minimum tradable notional in USDT (minSz × ctVal × price) — clear UX message. */
export function minNotionalUsdt(instrument: InstrumentInfo, price: number): number {
  return Number(instrument.minSz) * Number(instrument.ctVal) * price;
}

export function sizePosition(
  input: SizingInput,
  risk: RiskConfig,
  sizing: SizingConfig = { mode: "risk_based", position_pct: 1 },
): SizingResult {
  const { equity, entryPrice, stopPrice, leverage, instrument } = input;
  const stopDistancePct = Math.abs(entryPrice - stopPrice) / entryPrice;
  if (!(entryPrice > 0) || !(stopDistancePct > 0) || stopDistancePct > 0.2 || !(equity > 0)) {
    throw new SizingUnavailableError(`invalid sizing inputs (stop distance ${(stopDistancePct * 100).toFixed(2)}%)`);
  }
  const ctVal = Number(instrument.ctVal);
  if (!(ctVal > 0)) throw new SizingUnavailableError("instrument ctVal missing");

  let targetNotional: number;
  let riskBudgetUsdt: number;
  if (sizing.mode === "percent_of_equity") {
    targetNotional = equity * (sizing.position_pct / 100);
    riskBudgetUsdt = targetNotional * stopDistancePct; // implicit loss-if-stopped (info)
  } else {
    riskBudgetUsdt = equity * (risk.hard_limits.risk_per_trade_pct / 100);
    targetNotional = riskBudgetUsdt / stopDistancePct;
  }
  // margin clamp: notional / leverage must fit 90% of equity
  const maxByMargin = equity * 0.9 * leverage;
  const clampedByMargin = targetNotional > maxByMargin;
  if (clampedByMargin) targetNotional = maxByMargin;

  const desiredContracts = targetNotional / (ctVal * entryPrice);
  const contractsStr = normalizeContractSize(desiredContracts, instrument);
  if (Number(contractsStr) <= 0) {
    throw new SizingUnavailableError(
      `position below OKX minimum: target ${targetNotional.toFixed(2)} USDT notional < ` +
      `${minNotionalUsdt(instrument, entryPrice).toFixed(2)} USDT min (minSz×ctVal×price)`,
    );
  }
  const finalContracts = Number(contractsStr);
  const notionalUsdt = finalContracts * ctVal * entryPrice;
  return {
    contracts: contractsStr,
    riskBudgetUsdt,
    stopDistancePct,
    notionalUsdt,
    marginUsdt: notionalUsdt / leverage,
    clampedByMargin,
    mode: sizing.mode,
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
