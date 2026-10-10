// Deterministic post-close evidence completion. This is deliberately separate
// from closing a position: an exchange fill proves a close, while funding,
// fees, and completed candle coverage can arrive later.
import type { InstrumentInfo } from "../exchange/okx/types.ts";
import type { OkxClient } from "../exchange/okx/client.ts";
import { getFundingBills } from "../exchange/okx/account.ts";
import { getFills, getFillsHistory } from "../exchange/okx/orders.ts";
import { persistFills, excursionCandles } from "../execution/executor.ts";
import { serializeTradeMutation } from "../execution/trade-mutation.ts";
import { computeClosedMetrics, type ClosedMetrics } from "../memory/trades.ts";
import type { Store } from "../memory/db.ts";
import type { TradingConfig } from "../core/config.ts";
import { logSystemEvent } from "../memory/db.ts";

const RETRY_BASE_MS = 60_000;
const RETRY_MAX_MS = 60 * 60_000;
const RETRY_MAX_ATTEMPTS = 12;
const FUNDING_SETTLEMENT_GRACE_MS = 60_000;

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

function pendingReason(row: Record<string, unknown>): string | null {
  if (row.fees === null || row.fees === undefined) return "FEE_LOOKUP_PENDING";
  if (row.funding === null || row.funding === undefined) return "FUNDING_LOOKUP_PENDING";
  if (row.mfe === null || row.mfe === undefined || row.mae === null || row.mae === undefined) return "WAITING_FOR_CONFIRMED_CANDLE";
  return null;
}

async function resolveFees(d: EvidenceFinalizerDeps, t: Record<string, unknown>): Promise<number | null> {
  const instrument = String(t.instrument);
  const ids = [String(t.ord_open_id ?? ""), String(t.ord_close_id ?? "")].filter(Boolean);
  let fills;
  try {
    if (ids.length === 2) {
      const results = await Promise.all(ids.map((id) => getFills(d.client, instrument, id)));
      if (results.some((rows) => rows.length === 0)) return null;
      fills = results.flat();
    } else {
      const entryMs = Date.parse(String(t.entry_ts));
      const exitMs = Date.parse(String(t.exit_ts));
      const side = String(t.side) === "LONG" ? "buy" : "sell";
      const history = await getFillsHistory(d.client, instrument);
      fills = history.filter((fill) => Number(fill.ts) >= entryMs && Number(fill.ts) <= exitMs);
      const hasEntry = fills.some((fill) => fill.side === side);
      const hasExit = fills.some((fill) => fill.side !== side);
      if (!hasEntry || !hasExit) return null;
    }
  } catch { return null; }
  if (fills.some((fill) => fill.feeCcy !== "USDT" || finite(fill.fee) === null)) return null;
  persistFills(d.store, fills.map((fill) => ({ ...fill })));
  return fills.reduce((total, fill) => total + Math.abs(finite(fill.fee) ?? 0), 0);
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
    if (bills.some((bill) => bill.ccy !== "USDT" || finite(bill.balChg) === null)) return null;
    return bills.reduce((total, bill) => total + (finite(bill.balChg) ?? 0), 0);
  } catch { return null; }
}

function invalidEvidence(d: EvidenceFinalizerDeps, tradeId: string, reason: string): void {
  d.store.db.prepare(`UPDATE trades SET evidence_state='INVALID', evolution_evidence_eligible=0,
    accounting_quality='PENDING', evidence_reason=?, evidence_next_retry_ts=NULL WHERE trade_id=? AND status='CLOSED'`).run(reason, tradeId);
  logSystemEvent(d.store, "STATE", { tradeId, evidence: "INVALID", reason });
}

function deferEvidence(d: EvidenceFinalizerDeps, t: Record<string, unknown>, reason: string, now: number, metrics: ClosedMetrics): void {
  const attempt = Number(t.evidence_attempts ?? 0) + 1;
  const accountingQuality = metrics.fees === null ? "FEE_PENDING" : metrics.funding === null ? "FUNDING_PENDING" : "COMPLETE";
  if (attempt >= RETRY_MAX_ATTEMPTS) {
    d.store.db.prepare(`UPDATE trades SET evidence_state='ACCOUNTING_INCOMPLETE', evolution_evidence_eligible=0,
      evidence_attempts=?, evidence_reason=?, evidence_next_retry_ts=NULL, accounting_quality=?, fees=?, funding=?, mfe=?, mae=?
      WHERE trade_id=? AND evidence_state='EVIDENCE_PENDING'`)
      .run(attempt, `${reason}_RETRY_EXHAUSTED`, accountingQuality, metrics.fees, metrics.funding, metrics.mfe, metrics.mae, String(t.trade_id));
    logSystemEvent(d.store, "STATE", { tradeId: t.trade_id, evidence: "ACCOUNTING_INCOMPLETE", reason: `${reason}_RETRY_EXHAUSTED` });
    return;
  }
  d.store.db.prepare(`UPDATE trades SET evidence_state='EVIDENCE_PENDING', evolution_evidence_eligible=0,
    evidence_attempts=?, evidence_reason=?, evidence_next_retry_ts=?, accounting_quality=?, fees=?, funding=?, mfe=?, mae=?
    WHERE trade_id=? AND evidence_state='EVIDENCE_PENDING'`)
    .run(attempt, reason, new Date(now + retryDelayMs(attempt)).toISOString(), accountingQuality,
      metrics.fees, metrics.funding, metrics.mfe, metrics.mae, String(t.trade_id));
}

function markValid(d: EvidenceFinalizerDeps, t: Record<string, unknown>, m: ClosedMetrics): void {
  d.store.db.transaction(() => {
    d.store.db.prepare(`UPDATE trades SET result_r_basis='NET', evidence_state='VALID', evolution_evidence_eligible=1,
      accounting_quality='COMPLETE', evidence_reason=NULL, evidence_next_retry_ts=NULL,
      fees=?, funding=?, pnl=?, pnl_pct=?, result_r=?, mfe=?, mae=?, duration_s=?
      WHERE trade_id=? AND status='CLOSED' AND evidence_state='EVIDENCE_PENDING'`).run(
      m.fees, m.funding, m.pnl, m.pnlPct, m.resultR, m.mfe, m.mae, m.durationS, String(t.trade_id),
    );
  })();
  logSystemEvent(d.store, "STATE", { tradeId: t.trade_id, evidence: "VALID" });
}

async function finalizeOne(d: EvidenceFinalizerDeps, candidate: Record<string, unknown>, now: number): Promise<boolean> {
  const tradeId = String(candidate.trade_id);
  return serializeTradeMutation(tradeId, async () => {
    const t = d.store.db.prepare("SELECT * FROM trades WHERE trade_id=? AND status='CLOSED' AND evidence_state='EVIDENCE_PENDING'").get(tradeId) as Record<string, unknown> | undefined;
    if (!t) return false;
    const entryPx = finite(t.entry_px); const exitPx = finite(t.exit_px); const contracts = finite(t.contracts);
    const entryMs = Date.parse(String(t.entry_ts)); const exitMs = Date.parse(String(t.exit_ts));
    const meta = d.instruments[String(t.instrument)]; const ctVal = finite(meta?.ctVal);
    const initialStop = finite(t.initial_stop_px ?? t.stop_px);
    if (entryPx === null || exitPx === null || contracts === null || contracts <= 0 || ctVal === null || ctVal <= 0
      || initialStop === null || Math.abs(entryPx - initialStop) <= 0 || !Number.isFinite(entryMs) || !Number.isFinite(exitMs)) {
      invalidEvidence(d, tradeId, "DETERMINISTIC_EXIT_EVIDENCE_CORRUPT");
      return false;
    }
    const fees = t.fees === null || t.fees === undefined ? await resolveFees(d, t) : finite(t.fees);
    const funding = t.funding === null || t.funding === undefined ? await resolveFunding(d, t, now) : finite(t.funding);
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
    const reason = pendingReason(metrics as unknown as Record<string, unknown>);
    if (reason !== null || metrics.resultR === null || metrics.pnl === null) {
      deferEvidence(d, t, reason ?? "ACCOUNTING_LOOKUP_PENDING", now, metrics);
      return false;
    }
    markValid(d, t, metrics);
    return true;
  });
}

export async function finalizePendingEvidence(d: EvidenceFinalizerDeps, limit = 20): Promise<number> {
  const now = d.now?.() ?? Date.now();
  const rows = d.store.db.prepare(`SELECT * FROM trades WHERE status='CLOSED' AND evidence_state='EVIDENCE_PENDING'
    AND (evidence_next_retry_ts IS NULL OR evidence_next_retry_ts<=?) ORDER BY exit_ts ASC LIMIT ?`)
    .all(new Date(now).toISOString(), limit) as Array<Record<string, unknown>>;
  let finalized = 0;
  for (const row of rows) if (await finalizeOne(d, row, now)) finalized += 1;
  return finalized;
}

export function reviewerEligibleTradeIds(store: Store, limit = 3): string[] {
  return (store.db.prepare(`SELECT trade_id FROM trades WHERE status='CLOSED' AND evidence_state='VALID'
    AND evolution_evidence_eligible=1 AND result_r_basis='NET' AND trade_id NOT IN (SELECT trade_id FROM trade_reviews)
    ORDER BY exit_ts DESC LIMIT ?`).all(limit) as Array<{ trade_id: string }>).map((row) => row.trade_id);
}
