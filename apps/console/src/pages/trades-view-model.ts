import { asNumber, asText, type Row } from "../lib/types.ts";

export type TradeOutcome = "OPEN" | "PENDING" | "WIN" | "LOSS" | "FLAT" | "UNVERIFIED";
export type TradeSort = "newest" | "oldest" | "pnl-desc" | "pnl-asc" | "r-desc" | "r-asc";

export interface TradeFilters {
  search: string;
  engine: "ALL" | "SWING_15M" | "SCALP_5M";
  side: "ALL" | "LONG" | "SHORT";
  status: "ALL" | "OPEN" | "CLOSED" | "RECONCILIATION_PENDING";
  outcome: "ALL" | Exclude<TradeOutcome, "PENDING">;
}

export const TRADE_PAGE_SIZE = 25;
export const TRADE_DESKTOP_COLUMNS = ["instrument", "side", "entry_ts", "entry_px", "exit_px", "net_pnl", "result_r", "status"] as const;

/** Financial trust is independent from whether a trade is eligible for Evolution. */
export function isTrustedNetTrade(row: Row): boolean {
  return row.status === "CLOSED" && row.evidence_state === "VALID"
    && row.result_r_basis === "NET" && row.accounting_quality === "COMPLETE"
    && [row.pnl, row.fees, row.funding, row.result_r].every(value => asNumber(value) !== null);
}

export function tradeOutcome(row: Row): TradeOutcome {
  if (row.status === "OPEN") return "OPEN";
  if (row.status === "RECONCILIATION_PENDING") return "UNVERIFIED";
  if (!isTrustedNetTrade(row)) return "UNVERIFIED";
  const pnl = asNumber(row.pnl)!;
  return pnl > 0 ? "WIN" : pnl < 0 ? "LOSS" : "FLAT";
}

function engineOf(row: Row): string {
  return asText(row.engine, "");
}

export function filterTrades(rows: readonly Row[], filters: TradeFilters): Row[] {
  const query = filters.search.trim().toLowerCase();
  return rows.filter(row => {
    const textMatches = !query || [row.trade_id, row.instrument, row.strategy]
      .some(value => asText(value, "").toLowerCase().includes(query));
    const engineMatches = filters.engine === "ALL" || engineOf(row) === filters.engine;
    const sideMatches = filters.side === "ALL" || row.side === filters.side;
    const statusMatches = filters.status === "ALL" || row.status === filters.status;
    const outcomeMatches = filters.outcome === "ALL" || tradeOutcome(row) === filters.outcome;
    return textMatches && engineMatches && sideMatches && statusMatches && outcomeMatches;
  });
}

function timestamp(row: Row): number | null {
  const raw = row.exit_ts ?? row.entry_ts;
  if (raw === null || raw === undefined || raw === "") return null;
  const value = typeof raw === "number" ? raw : Date.parse(String(raw));
  return Number.isFinite(value) ? value : null;
}

function sortablePnl(row: Row): number | null {
  return isTrustedNetTrade(row) ? asNumber(row.pnl) : null;
}

function sortableR(row: Row): number | null {
  if (row.status === "OPEN") return asNumber(row.live_r ?? row.r);
  return isTrustedNetTrade(row) ? asNumber(row.result_r) : null;
}

export function sortTrades(rows: readonly Row[], sort: TradeSort): Row[] {
  const direction = sort.endsWith("asc") || sort === "oldest" ? 1 : -1;
  const value = sort.startsWith("pnl") ? sortablePnl : sort.startsWith("r-") ? sortableR : timestamp;
  return [...rows].sort((left, right) => {
    const a = value(left), b = value(right);
    if (a === null) return b === null ? 0 : 1;
    if (b === null) return -1;
    return (a - b) * direction;
  });
}

export function paginateTrades(rows: readonly Row[], page: number, pageSize = TRADE_PAGE_SIZE): Row[] {
  const safeSize = Math.max(1, Math.floor(pageSize));
  const safePage = Math.max(0, Math.floor(page));
  return rows.slice(safePage * safeSize, (safePage + 1) * safeSize);
}

export const TRADE_ANALYTICS_DIMENSIONS = [
  { key: "strategy", label: "Strategy performance" },
  { key: "exitReason", label: "Exit reasons" },
  { key: "engine", label: "Engine comparison" },
  { key: "symbol", label: "Instrument" },
  { key: "side", label: "Direction" },
  { key: "regime", label: "Market regime" },
  { key: "setup", label: "Setup" },
  { key: "entryHourUtc", label: "Entry hour (UTC)" },
  { key: "exitHourUtc", label: "Exit hour (UTC)" },
  { key: "gateDecision", label: "Gate outcome" },
] as const;
