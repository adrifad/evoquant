export interface SlPlusInput {
  side: "LONG" | "SHORT";
  entryPx: number;
  initialStopPx: number;
  currentStopPx: number;
  markPx: number;
  tickSz: number;
  activationR: number;
  lockInR: number;
  minProfitBufferPct: number;
}

export function calculateSlPlusStop(input: SlPlusInput): number | null {
  const { side, entryPx, initialStopPx, currentStopPx, markPx, tickSz } = input;
  if (![entryPx, initialStopPx, currentStopPx, markPx, tickSz].every(Number.isFinite)
      || entryPx <= 0 || markPx <= 0 || tickSz <= 0) return null;
  const direction = side === "LONG" ? 1 : -1;
  const initialRisk = Math.abs(entryPx - initialStopPx);
  if (!(initialRisk > 0)) return null;
  const favorableR = ((markPx - entryPx) * direction) / initialRisk;
  if (favorableR < input.activationR) return null;

  const lockDistance = Math.max(initialRisk * input.lockInR, entryPx * input.minProfitBufferPct / 100);
  if (!(lockDistance > 0)) return null;
  const rawStop = entryPx + direction * lockDistance;
  const units = rawStop / tickSz;
  const roundedUnits = side === "LONG" ? Math.ceil(units - 1e-10) : Math.floor(units + 1e-10);
  const decimals = Math.min(12, tickSz.toString().split(".")[1]?.length ?? 0);
  const candidate = Number((roundedUnits * tickSz).toFixed(decimals));
  const improves = side === "LONG" ? candidate > currentStopPx + tickSz / 2 : candidate < currentStopPx - tickSz / 2;
  const safelyBehindMark = side === "LONG" ? candidate <= markPx - tickSz : candidate >= markPx + tickSz;
  return improves && safelyBehindMark ? candidate : null;
}
