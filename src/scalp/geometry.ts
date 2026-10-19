import { normalizePriceToTick } from "../exchange/okx/algo.ts";

export type ScalpExitSide = "LONG" | "SHORT";

export interface ScalpExitGeometryInput {
  side: ScalpExitSide;
  signalPrice: number;
  signalStop: number;
  signalTakeProfit: number;
  fillPrice: number;
  tickSz: string;
}

export interface ScalpExitGeometry {
  stopPrice: number;
  takeProfitPrice: number;
  stopDistance: number;
  targetDistance: number;
  rewardRisk: number;
}

/** Translate signal-relative SL/TP distances to the confirmed average fill.
 * Tick rounding follows the native protection helper and always rounds both
 * legs toward entry, so normalization cannot increase intended stop risk.
 */
export function deriveScalpExitGeometry(input: ScalpExitGeometryInput): ScalpExitGeometry {
  const values = [input.signalPrice, input.signalStop, input.signalTakeProfit, input.fillPrice];
  if (values.some((value) => !Number.isFinite(value) || value <= 0)) throw new Error("invalid Scalp exit geometry price");
  if (input.side !== "LONG" && input.side !== "SHORT") throw new Error("invalid Scalp exit side");

  const isLong = input.side === "LONG";
  if (isLong
    ? !(input.signalStop < input.signalPrice && input.signalTakeProfit > input.signalPrice)
    : !(input.signalTakeProfit < input.signalPrice && input.signalStop > input.signalPrice)) {
    throw new Error("signal exits do not preserve directional geometry");
  }

  // Keep signed displacements: SHORT targets are below signalPrice already.
  const rawStop = input.fillPrice + (input.signalStop - input.signalPrice);
  const rawTarget = input.fillPrice + (input.signalTakeProfit - input.signalPrice);
  const stopPrice = Number(normalizePriceToTick(rawStop, input.tickSz, isLong ? "up" : "down"));
  const takeProfitPrice = Number(normalizePriceToTick(rawTarget, input.tickSz, isLong ? "down" : "up"));
  if (![stopPrice, takeProfitPrice].every((price) => Number.isFinite(price) && price > 0)) {
    throw new Error("normalized Scalp exit geometry is invalid");
  }
  if (isLong ? !(stopPrice < input.fillPrice && input.fillPrice < takeProfitPrice)
    : !(takeProfitPrice < input.fillPrice && input.fillPrice < stopPrice)) {
    throw new Error("tick-normalized Scalp exits do not preserve fill geometry");
  }

  const stopDistance = Math.abs(input.fillPrice - stopPrice);
  const targetDistance = Math.abs(takeProfitPrice - input.fillPrice);
  const rewardRisk = targetDistance / stopDistance;
  if (![stopDistance, targetDistance, rewardRisk].every((value) => Number.isFinite(value) && value > 0)) {
    throw new Error("Scalp exit distances must be positive and finite");
  }
  return { stopPrice, takeProfitPrice, stopDistance, targetDistance, rewardRisk };
}
