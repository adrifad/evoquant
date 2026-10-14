// Deterministic post-close evidence completion. This is deliberately separate
// from closing a position: an exchange fill proves a close, while funding,
// fees, and completed candle coverage can arrive later.
import type { InstrumentInfo } from "../exchange/okx/types.ts";
import type { OkxClient } from "../exchange/okx/client.ts";
import { getFundingBills } from "../exchange/okx/account.ts";
import { getFills, getFillsHistoryForOrder } from "../exchange/okx/orders.ts";
import { persistFills, excursionCandles } from "../execution/executor.ts";
import { serializeTradeMutation } from "../execution/trade-mutation.ts";
import { computeClosedMetrics, type ClosedMetrics } from "../memory/trades.ts";
import type { Store } from "../memory/db.ts";
import type { TradingConfig } from "../core/config.ts";
import { logSystemEvent } from "../memory/db.ts";

const RETRY_BASE_MS = 60_000;
const RETRY_MAX_MS = 60 * 60_000;
const RETRY_MAX_ATTEMPTS = 12;
const ACCOUNTING_RECONCILE_BASE_MS = 15 * 60_000;
const ACCOUNTING_RECONCILE_MAX_MS = 24 * 60 * 60_000;
const FILL_CLOCK_TOLERANCE_MS = 5 * 60_000;
const FILL_HISTORY_MONTHS = 3;
// Account bills are eventually consistent. A three-minute grace avoids turning
// a just-settled but not-yet-listed funding interval into a false zero.
export const FUNDING_SETTLEMENT_GRACE_MS = 3 * 60_000;

export interface EvidenceFinalizerDeps {
  client: OkxClient;
  store: Store;
  instruments: Record<string, InstrumentInfo>;
  trading: TradingConfig;
  now?: () => number;
}

function finite(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function retryDelayMs(attempt: number): number {
  return Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.max(0, attempt - 1));
}

function pendingReason(row: Record<string, unknown>, feeReason: string): string | null {
  if (row.fees === null || row.fees === undefined) return feeReason;
  if (row.funding === null || row.funding === undefined) return "FUNDING_LOOKUP_PENDING";
  if (row.mfe === null || row.mfe === undefined || row.mae === null || row.mae === undefined) return "WAITING_FOR_CONFIRMED_CANDLE";
  return null;
}

interface FeeResolution { fees: number | null; entryPx: number | null; exitPx: number | null; reason: string }

function distinctFills(fills: Array<Awaited<ReturnType<typeof getFills>>[number]>): typeof fills {
  const seen = new Set<string>();
  return fills.filter((fill) => {
    const key = `${fill.instId}:${fill.ordId}:${fill.tradeId}:${fill.ts}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function exactOrderId(d: EvidenceFinalizerDeps, t: Record<string, unknown>, kind: "OPEN" | "CLOSE"): string | null {
  const field = kind === "OPEN" ? "ord_open_id" : "ord_close_id";
  const saved = String(t[field] ?? "");
  if (saved) return saved;
  const clientId = String(t[kind === "OPEN" ? "cl_open_id" : "cl_close_id"] ?? "");
  const row = d.store.db.prepare(`SELECT ordId FROM orders WHERE instId=? AND ((trade_id=? AND kind=?) OR (?<>'' AND clOrdId=? AND kind=?))
    ORDER BY CASE WHEN trade_id=? AND kind=? THEN 0 ELSE 1 END LIMIT 1`)
    .get(String(t.instrument), String(t.trade_id), kind, clientId, clientId, kind, String(t.trade_id), kind) as { ordId?: string } | undefined;
  return row?.ordId ? String(row.ordId) : null;
}

function legReason(fills: Awaited<ReturnType<typeof getFills>>, args: {
  instrument: string; orderId: string; side: string; posSide: string; expectedContracts: number;
  earliestTs: number; latestTs: number;
}): string | null {
  if (fills.length === 0) return "FILL_SET_MISSING";
  let quantity = 0;
  for (const fill of fills) {
    const size = finite(fill.fillSz); const fee = finite(fill.fee); const ts = Number(fill.ts);
    if (fill.instId !== args.instrument || fill.ordId !== args.orderId || fill.side !== args.side || fill.posSide !== args.posSide
      || !fill.tradeId || size === null || size <= 0 || finite(fill.fillPx) === null || Number(fill.fillPx) <= 0
      || fee === null || !Number.isFinite(ts)
      || ts < args.earliestTs - FILL_CLOCK_TOLERANCE_MS || ts > args.latestTs + FILL_CLOCK_TOLERANCE_MS) return "FILL_DATA_MISMATCH";
    quantity += size;
  }
  if (Math.abs(quantity - args.expectedContracts) > Math.max(1e-9, args.expectedContracts * 1e-8)) return "FILL_QUANTITY_INCOMPLETE";
  if (fills.some((fill) => fill.feeCcy !== "USDT")) return "FEE_CURRENCY_UNSUPPORTED";
  return null;
}

async function resolveLeg(d: EvidenceFinalizerDeps, args: {
  instrument: string; orderId: string; side: string; posSide: string; expectedContracts: number;
  earliestTs: number; latestTs: number;
}): Promise<{ fills: Awaited<ReturnType<typeof getFills>>; averagePx: number | null; reason: string | null }> {
  let recent: Awaited<ReturnType<typeof getFills>>;
  try { recent = await getFills(d.client, args.instrument, args.orderId); }
  catch { recent = []; }
  recent = distinctFills(recent);
  let reason = legReason(recent, args);
  if (reason === null) return { fills: recent, averagePx: weightedAveragePrice(recent), reason: null };

  // The recent endpoint covers a short window. Query the documented 3-month
  // history by exact order ID, page with billId, and require a complete scan.
  try {
    const history = await getFillsHistoryForOrder(d.client, args.instrument, args.orderId);
    const merged = distinctFills([...recent, ...history.fills]);
    reason = legReason(merged, args);
    if (!history.complete) reason = "FILL_HISTORY_INCOMPLETE";
    if (reason === null) return { fills: merged, averagePx: weightedAveragePrice(merged), reason: null };
    return { fills: [], averagePx: null, reason };
  } catch {
    return { fills: [], averagePx: null, reason: "FILL_HISTORY_LOOKUP_FAILED" };
  }
}

function weightedAveragePrice(fills: Awaited<ReturnType<typeof getFills>>): number | null {
  let notional = 0; let quantity = 0;
  for (const fill of fills) {
    const px = finite(fill.fillPx); const sz = finite(fill.fillSz);
    if (px === null || px <= 0 || sz === null || sz <= 0) return null;
    notional += px * sz;
    quantity += sz;
  }
  return quantity > 0 && Number.isFinite(notional / quantity) ? notional / quantity : null;
}

async function resolveFees(d: EvidenceFinalizerDeps, t: Record<string, unknown>): Promise<FeeResolution> {
  const instrument = String(t.instrument);
  const entryId = exactOrderId(d, t, "OPEN");
  const exitId = exactOrderId(d, t, "CLOSE");
  if (!entryId || !exitId) return { fees: null, entryPx: null, exitPx: null, reason: "FEE_ORDER_ID_MISSING" };
  const side = String(t.side);
  const positionSide = side === "LONG" ? "long" : "short";
  const entryMs = Date.parse(String(t.entry_ts)); const exitMs = Date.parse(String(t.exit_ts));
  const expectedContracts = finite(t.contracts);
  if (!Number.isFinite(entryMs) || !Number.isFinite(exitMs) || expectedContracts === null || expectedContracts <= 0) {
    return { fees: null, entryPx: null, exitPx: null, reason: "FEE_TRADE_INTERVAL_INVALID" };
  }
  const nowDate = new Date(d.now?.() ?? Date.now());
  const historyFloor = new Date(nowDate);
  const targetMonth = historyFloor.getUTCMonth() - FILL_HISTORY_MONTHS;
  const targetYear = historyFloor.getUTCFullYear() + Math.floor(targetMonth / 12);
  const normalizedMonth = ((targetMonth % 12) + 12) % 12;
  const targetLastDay = new Date(Date.UTC(targetYear, normalizedMonth + 1, 0)).getUTCDate();
  historyFloor.setUTCFullYear(targetYear, normalizedMonth, Math.min(historyFloor.getUTCDate(), targetLastDay));
  if (entryMs < historyFloor.getTime()) {
    return { fees: null, entryPx: null, exitPx: null, reason: "FILL_HISTORY_WINDOW_EXCEEDED" };
  }
  const entrySide = side === "LONG" ? "buy" : "sell";
  const exitSide = side === "LONG" ? "sell" : "buy";
  const [entry, exit] = await Promise.all([
    resolveLeg(d, { instrument, orderId: entryId, side: entrySide, posSide: positionSide,
      expectedContracts, earliestTs: entryMs, latestTs: exitMs }),
    resolveLeg(d, { instrument, orderId: exitId, side: exitSide, posSide: positionSide,
      expectedContracts, earliestTs: entryMs, latestTs: exitMs }),
  ]);
  if (entry.reason) return { fees: null, entryPx: null, exitPx: null, reason: `ENTRY_${entry.reason}` };
  if (exit.reason) return { fees: null, entryPx: null, exitPx: null, reason: `EXIT_${exit.reason}` };
  const fills = distinctFills([...entry.fills, ...exit.fills]);
  if (fills.some((fill) => finite(fill.fee) === null) || entry.averagePx === null || exit.averagePx === null) {
    return { fees: null, entryPx: null, exitPx: null, reason: "FEE_VALUE_INVALID" };
  }
  persistFills(d.store, fills.map((fill) => ({ ...fill })));
  // OKX reports trading costs as negative fee and rebates as positive fee.
  // `fees` is stored as a positive cost, so negate the signed exchange value.
  const fees = fills.reduce((total, fill) => total - (finite(fill.fee) ?? 0), 0);
  return Number.isFinite(fees)
    ? { fees, entryPx: entry.averagePx, exitPx: exit.averagePx, reason: "" }
    : { fees: null, entryPx: null, exitPx: null, reason: "FEE_VALUE_INVALID" };
}

async function resolveFunding(d: EvidenceFinalizerDeps, t: Record<string, unknown>, now: number): Promise<number | null> {
  const entryMs = Date.parse(String(t.entry_ts));
  const exitMs = Date.parse(String(t.exit_ts));
  if (!Number.isFinite(entryMs) || !Number.isFinite(exitMs)) return null;
  // Let the exchange ledger settle before treating an empty response as a
  // proven no-funding interval.
  if (now - exitMs < FUNDING_SETTLEMENT_GRACE_MS) return null;
  try {
    const bills = await getFundingBills(d.client, String(t.instrument), entryMs, exitMs, now);
    if (bills.some((bill) => bill.ccy !== "USDT" || finite(bill.pnl) === null)) return null;
    // OKX documents `pnl`, not balChg, as the authoritative funding payment.
    return bills.reduce((total, bill) => total + (finite(bill.pnl) ?? 0), 0);
  } catch { return null; }
}

function invalidEvidence(d: EvidenceFinalizerDeps, tradeId: string, reason: string): void {
  d.store.db.prepare(`UPDATE trades SET evidence_state='INVALID', evolution_evidence_eligible=0,
    accounting_quality='PENDING', evidence_reason=?, evidence_next_retry_ts=NULL WHERE trade_id=? AND status='CLOSED'`).run(reason, tradeId);
  logSystemEvent(d.store, "STATE", { tradeId, evidence: "INVALID", reason });
}

function deferEvidence(d: EvidenceFinalizerDeps, t: Record<string, unknown>, reason: string, now: number, metrics?: ClosedMetrics): void {
  const currentState = String(t.evidence_state);
  const accountingQuality = metrics
    ? metrics.fees === null ? "FEE_PENDING" : metrics.funding === null ? "FUNDING_PENDING" : "COMPLETE"
    : String(t.accounting_quality ?? "PENDING");
  if (currentState === "ACCOUNTING_INCOMPLETE") {
    const attempt = Number(t.accounting_reconcile_attempts ?? 0) + 1;
    const delay = Math.min(ACCOUNTING_RECONCILE_MAX_MS, ACCOUNTING_RECONCILE_BASE_MS * 2 ** Math.min(16, attempt - 1));
    d.store.db.prepare(`UPDATE trades SET evolution_evidence_eligible=0, accounting_reconcile_attempts=?,
      accounting_reconcile_last_attempt_ts=?, accounting_reconcile_last_result='PENDING', accounting_reconcile_next_retry_ts=?, evidence_reason=?,
      accounting_quality=?, fees=?, funding=?, mfe=?, mae=?
      WHERE trade_id=? AND evidence_state='ACCOUNTING_INCOMPLETE'`).run(
      attempt, new Date(now).toISOString(), new Date(now + delay).toISOString(), reason, accountingQuality,
      metrics?.fees ?? null, metrics?.funding ?? null, metrics?.mfe ?? null, metrics?.mae ?? null, String(t.trade_id));
    logSystemEvent(d.store, "ACCOUNTING_RECONCILIATION_ATTEMPT", { tradeId: t.trade_id, attempt, result: "PENDING", reason, nextRetryAt: new Date(now + delay).toISOString() });
    return;
  }
  const attempt = Number(t.evidence_attempts ?? 0) + 1;
  if (attempt >= RETRY_MAX_ATTEMPTS) {
    const recoveryAt = new Date(now + ACCOUNTING_RECONCILE_BASE_MS).toISOString();
    d.store.db.prepare(`UPDATE trades SET evidence_state='ACCOUNTING_INCOMPLETE', evolution_evidence_eligible=0,
      evidence_attempts=?, evidence_reason=?, evidence_next_retry_ts=NULL, accounting_quality=?, fees=?, funding=?, mfe=?, mae=?,
      accounting_reconcile_attempts=0, accounting_reconcile_last_result='SCHEDULED', accounting_reconcile_next_retry_ts=?
      WHERE trade_id=? AND evidence_state='EVIDENCE_PENDING'`)
      .run(attempt, `${reason}_RETRY_EXHAUSTED`, accountingQuality, metrics?.fees ?? null, metrics?.funding ?? null,
        metrics?.mfe ?? null, metrics?.mae ?? null, recoveryAt, String(t.trade_id));
    logSystemEvent(d.store, "STATE", { tradeId: t.trade_id, evidence: "ACCOUNTING_INCOMPLETE", reason: `${reason}_RETRY_EXHAUSTED`, nextRetryAt: recoveryAt });
    return;
  }
  d.store.db.prepare(`UPDATE trades SET evidence_state='EVIDENCE_PENDING', evolution_evidence_eligible=0,
    evidence_attempts=?, evidence_reason=?, evidence_next_retry_ts=?, accounting_quality=?, fees=?, funding=?, mfe=?, mae=?
    WHERE trade_id=? AND evidence_state='EVIDENCE_PENDING'`)
    .run(attempt, reason, new Date(now + retryDelayMs(attempt)).toISOString(), accountingQuality,
      metrics?.fees ?? null, metrics?.funding ?? null, metrics?.mfe ?? null, metrics?.mae ?? null, String(t.trade_id));
}

function markValid(d: EvidenceFinalizerDeps, t: Record<string, unknown>, m: ClosedMetrics, entryPx: number): void {
  d.store.db.transaction(() => {
    d.store.db.prepare(`UPDATE trades SET result_r_basis='NET', evidence_state='VALID', evolution_evidence_eligible=1,
      accounting_quality='COMPLETE', evidence_reason=NULL, evidence_next_retry_ts=NULL,
      accounting_reconcile_last_result=CASE WHEN accounting_reconcile_attempts>0 THEN 'RECOVERED' ELSE accounting_reconcile_last_result END,
      accounting_reconcile_next_retry_ts=NULL,
      entry_px=?, exit_px=?, fees=?, funding=?, pnl=?, pnl_pct=?, result_r=?, mfe=?, mae=?, duration_s=?
      WHERE trade_id=? AND status='CLOSED' AND evidence_state IN ('EVIDENCE_PENDING','ACCOUNTING_INCOMPLETE')`).run(
      entryPx, m.exitPx, m.fees, m.funding, m.pnl, m.pnlPct, m.resultR, m.mfe, m.mae, m.durationS, String(t.trade_id),
    );
  })();
  logSystemEvent(d.store, "STATE", { tradeId: t.trade_id, evidence: "VALID" });
}

async function finalizeOne(d: EvidenceFinalizerDeps, candidate: Record<string, unknown>, now: number): Promise<boolean> {
  const tradeId = String(candidate.trade_id);
  return serializeTradeMutation(tradeId, async () => {
    const t = d.store.db.prepare("SELECT * FROM trades WHERE trade_id=? AND status='CLOSED' AND evidence_state IN ('EVIDENCE_PENDING','ACCOUNTING_INCOMPLETE')").get(tradeId) as Record<string, unknown> | undefined;
    if (!t) return false;
    const recordedEntryPx = finite(t.entry_px); const recordedExitPx = finite(t.exit_px); const contracts = finite(t.contracts);
    const entryMs = Date.parse(String(t.entry_ts)); const exitMs = Date.parse(String(t.exit_ts));
    const meta = d.instruments[String(t.instrument)]; const ctVal = meta?.instId === String(t.instrument) ? finite(meta.ctVal) : null;
    const initialStop = finite(t.initial_stop_px ?? t.stop_px);
    if (ctVal === null || ctVal <= 0) {
      deferEvidence(d, t, "INSTRUMENT_METADATA_PENDING", now);
      return false;
    }
    if (recordedEntryPx === null || recordedExitPx === null || contracts === null || contracts <= 0
      || initialStop === null || Math.abs(recordedEntryPx - initialStop) <= 0 || !Number.isFinite(entryMs) || !Number.isFinite(exitMs)) {
      invalidEvidence(d, tradeId, "DETERMINISTIC_EXIT_EVIDENCE_CORRUPT");
      return false;
    }
    // Re-prove both fee legs before eligibility; close-time fees may have been
    // computed from only the fills visible at that moment.
    const feeResolution = await resolveFees(d, t);
    const fees = feeResolution.fees;
    const entryPx = feeResolution.entryPx ?? recordedEntryPx;
    const exitPx = feeResolution.exitPx ?? recordedExitPx;
    // Closed-trade rows may contain a legacy/default zero without proof that
    // the account ledger was queried. Re-resolve during evidence finalization;
    // only a completed lookup after settlement grace can establish zero.
    const funding = await resolveFunding(d, t, now);
    const candles = t.mfe === null || t.mfe === undefined || t.mae === null || t.mae === undefined
      ? await excursionCandles(d, t, entryMs, exitMs) : null;
    const metrics = computeClosedMetrics({
      side: t.side === "LONG" ? "LONG" : "SHORT", entryPx, stopPx: finite(t.stop_px) ?? entryPx,
      initialStopPx: initialStop, exitPx, contracts, ctVal,
      exitReason: String(t.exit_reason ?? "FILL_CONFIRM"), entryTs: String(t.entry_ts), exitTs: String(t.exit_ts),
      candlesWhileOpen: candles ?? (t.mfe !== null && t.mae !== null ? [] : null), fees, funding,
    });
    if (t.mfe !== null && t.mfe !== undefined && t.mae !== null && t.mae !== undefined) {
      metrics.mfe = finite(t.mfe); metrics.mae = finite(t.mae);
    }
    const reason = pendingReason(metrics as unknown as Record<string, unknown>, feeResolution.reason || "FEE_LOOKUP_PENDING");
    if (reason !== null || metrics.resultR === null || metrics.pnl === null) {
      deferEvidence(d, t, reason ?? "ACCOUNTING_LOOKUP_PENDING", now, metrics);
      return false;
    }
    markValid(d, t, metrics, entryPx);
    return true;
  });
}

export async function finalizePendingEvidence(d: EvidenceFinalizerDeps, limit = 20): Promise<number> {
  const now = d.now?.() ?? Date.now();
  const timestamp = new Date(now).toISOString();
  const rows = d.store.db.prepare(`SELECT * FROM trades WHERE status='CLOSED' AND (
      (evidence_state='EVIDENCE_PENDING' AND (evidence_next_retry_ts IS NULL OR evidence_next_retry_ts<=?))
      OR (evidence_state='ACCOUNTING_INCOMPLETE' AND (accounting_reconcile_next_retry_ts IS NULL OR accounting_reconcile_next_retry_ts<=?))
    ) ORDER BY exit_ts ASC LIMIT ?`)
    .all(timestamp, timestamp, limit) as Array<Record<string, unknown>>;
  let finalized = 0;
  for (const row of rows) if (await finalizeOne(d, row, now)) finalized += 1;
  return finalized;
}

export function reviewerEligibleTradeIds(store: Store, limit = 3): string[] {
  return (store.db.prepare(`SELECT trade_id FROM trades WHERE status='CLOSED' AND evidence_state='VALID'
    AND evolution_evidence_eligible=1 AND result_r_basis='NET' AND trade_id NOT IN (SELECT trade_id FROM trade_reviews)
    ORDER BY exit_ts DESC LIMIT ?`).all(limit) as Array<{ trade_id: string }>).map((row) => row.trade_id);
}
