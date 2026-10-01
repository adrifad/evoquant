// M1 scope item 6 helper — normalizeContractSize (pure math).
// Spec §7.2 (sz = number of CONTRACTS, never coin quantity), §24 (position
// sizing: always normalize to lotSz/minSz), §22 (risk engine authority —
// this module never invents sizes, it only normalizes a requested size).
//
// Deterministic BigInt decimal math: floor the requested contract count to a
// multiple of lotSz, reject anything below minSz. No floats.

import type { InstrumentInfo } from "./types.ts";

export class SizingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SizingError";
  }
}

function decimalPlaces(value: string): number {
  const dot = value.indexOf(".");
  return dot === -1 ? 0 : value.length - dot - 1;
}

// Parse a plain decimal string into an integer scaled by 10^dp (BigInt).
function toScaledBigInt(value: string, what: string): { scaled: bigint; dp: number } {
  if (!/^\d+(\.\d+)?$/.test(value)) {
    throw new SizingError(`${what} is not a non-negative decimal number: "${value}"`);
  }
  return { scaled: BigInt(value.replace(".", "")), dp: decimalPlaces(value) };
}

function pow10(exp: number): bigint {
  return 10n ** BigInt(exp);
}

// Scale a BigInt value from 10^dp to 10^targetDp (targetDp >= dp).
function rescale(scaled: bigint, dp: number, targetDp: number): bigint {
  return scaled * pow10(targetDp - dp);
}

// Format an integer scaled by 10^dp back to a decimal string with exactly dp digits.
function formatScaled(scaled: bigint, dp: number): string {
  if (dp === 0) return scaled.toString();
  const divisor = pow10(dp);
  const intPart = scaled / divisor;
  const fracPart = scaled % divisor;
  return `${intPart}.${fracPart.toString().padStart(dp, "0")}`;
}

/**
 * Normalize a requested size (in CONTRACTS) to a lotSz-aligned string.
 *
 * - Floors to the nearest lotSz multiple (never rounds up → never exceeds
 *   the intended risk budget, spec §24).
 * - Throws SizingError when the floored size is below minSz (spec §24) or
 *   when inputs are malformed.
 * - Returns sz as a string (spec §7.2; acceptance: all sz sent to OKX are
 *   strings normalized to lotSz).
 *
 * Example (spec §7.2 doc invariant): 1 contract of BTC-USDT-SWAP with
 * lotSz=0.01, minSz=0.01, ctVal=0.01 BTC → "1" means 1 CONTRACT = 0.01 BTC,
 * NOT 1 BTC.
 */
export function normalizeContractSize(
  size: string | number,
  instrument: Pick<InstrumentInfo, "lotSz" | "minSz">,
): string {
  const sizeStr = typeof size === "number" ? String(size) : size;
  const parsedSize = toScaledBigInt(sizeStr, "size");
  if (parsedSize.scaled <= 0n) {
    throw new SizingError(`size must be positive: "${sizeStr}"`);
  }

  const lot = toScaledBigInt(instrument.lotSz, "lotSz");
  if (lot.scaled <= 0n) {
    throw new SizingError(`lotSz must be positive: "${instrument.lotSz}"`);
  }
  const min = toScaledBigInt(instrument.minSz, "minSz");
  if (min.scaled <= 0n) {
    throw new SizingError(`minSz must be positive: "${instrument.minSz}"`);
  }

  // steps = floor(size / lotSz) in exact rational arithmetic via BigInt:
  // steps = floor(size * 10^lotDp / (lot * 10^sizeDp))
  const steps = (parsedSize.scaled * pow10(lot.dp)) / (lot.scaled * pow10(parsedSize.dp));
  if (steps <= 0n) {
    throw new SizingError(
      `size "${sizeStr}" is below one lotSz step of "${instrument.lotSz}"`,
    );
  }

  const floored = { scaled: steps * lot.scaled, dp: lot.dp };

  // minSz comparison at a common decimal scale
  const cmpDp = Math.max(floored.dp, min.dp);
  const flooredAtCmp = rescale(floored.scaled, floored.dp, cmpDp);
  const minAtCmp = rescale(min.scaled, min.dp, cmpDp);
  if (flooredAtCmp < minAtCmp) {
    throw new SizingError(
      `normalized size "${formatScaled(floored.scaled, floored.dp)}" is below minSz "${instrument.minSz}"`,
    );
  }

  return formatScaled(floored.scaled, floored.dp);
}
