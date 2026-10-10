import type { InstrumentInfo, Position } from "../exchange/okx/types.ts";

export interface PortfolioRiskSnapshot {
  known: boolean;
  lossToStops: number | null;
  riskPct: number | null;
  unavailable: string[];
}

/**
 * Uses exchange position size and local active stop. A missing match/stop/contract
 * cannot be priced safely, so new entries fail closed rather than treating it as zero.
 */
export function portfolioOpenRisk(input: {
  equity: number;
  positions: Position[];
  trades: Array<Record<string, unknown>>;
  instruments: Record<string, InstrumentInfo>;
}): PortfolioRiskSnapshot {
  const unavailable: string[] = [];
  let lossToStops = 0;
  for (const position of input.positions.filter((item) => Number(item.pos) !== 0)) {
    const trade = input.trades.find((item) => String(item.instrument) === position.instId
      && String(item.side).toLowerCase() === position.posSide);
    const meta = input.instruments[position.instId];
    const contracts = Math.abs(Number(position.pos));
    const entry = Number(position.avgPx);
    const stop = Number(trade?.stop_px);
    const value = Number(meta?.ctVal);
    if (!trade || !meta || !Number.isFinite(contracts) || !Number.isFinite(entry) || !Number.isFinite(stop)
      || !Number.isFinite(value) || contracts <= 0 || entry <= 0 || stop <= 0 || value <= 0) {
      unavailable.push(`${position.instId}:${position.posSide}`);
      continue;
    }
    const directionalLoss = position.posSide === "long" ? entry - stop : stop - entry;
    lossToStops += Math.max(0, directionalLoss) * contracts * value;
  }
  if (unavailable.length || !Number.isFinite(input.equity) || input.equity <= 0) {
    return { known: false, lossToStops: null, riskPct: null, unavailable };
  }
  return { known: true, lossToStops, riskPct: lossToStops / input.equity * 100, unavailable: [] };
}

export function candidateStopRiskPct(lossToStop: number, equity: number): number | null {
  return Number.isFinite(lossToStop) && lossToStop >= 0 && Number.isFinite(equity) && equity > 0 ? lossToStop / equity * 100 : null;
}
