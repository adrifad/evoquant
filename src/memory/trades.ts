// M2 (§26/§27/§41) — trade & decision persistence + closed-trade metrics.

import type { Store } from "./db.ts";
import type { Candle } from "../exchange/okx/types.ts";
import type { FeatureSnapshot } from "../market/features.ts";
import { inferTradingEngine, type TradingEngine } from "./engines.ts";
import type { RegimeAxes } from "../market/regime.ts";
import type { StrategyCondition } from "../strategy/core-v2.ts";
import type { StrategyIdentity } from "../strategy/identity.ts";

let decisionSeq = 0;
export function nextDecisionId(): string {
  decisionSeq += 1;
  return `DEC-${String(Date.now()).slice(-8)}${String(decisionSeq % 100).padStart(2, "0")}`;
}

export function recordDecision(
  store: Store,
  d: {
    decisionId: string; ts: string; instrument: string; decision: string;
    strategy?: string | undefined; regime: string; rawConfidence?: number | undefined; calibratedConfidence?: number | undefined;
    thesis?: string[] | undefined; riskVerdict: unknown;
  },
): void {
  store.db
    .prepare(
      `INSERT INTO decisions(decision_id,ts,instrument,decision,strategy,regime,raw_confidence,calibrated_confidence,thesis,risk_verdict)
       VALUES(@decisionId,@ts,@instrument,@decision,@strategy,@regime,@rawConfidence,@calibratedConfidence,@thesis,@riskVerdict)`,
    )
    .run({
      ...d,
      strategy: d.strategy ?? null,
      rawConfidence: d.rawConfidence ?? null,
      calibratedConfidence: d.calibratedConfidence ?? null,
      thesis: JSON.stringify(d.thesis ?? []),
      riskVerdict: JSON.stringify(d.riskVerdict),
    });
}

export function openTrade(
  store: Store,
  t: {
    tradeId: string; engine?: TradingEngine; instrument: string; timeframe: string; side: "LONG" | "SHORT";
    strategy: string; strategyVersion: number; regime: string; regimeAxes?: RegimeAxes; entryConditions?: StrategyCondition[]; contracts: string;
    identity?: StrategyIdentity;
    entryPx: number; entryTs: string; stopPx: number; takeProfitPx: number;
    clOpenId: string; ordOpenId: string;
    decisionId?: string;
    rawConfidence: number; calibratedConfidence: number; plannedRiskPct: number; leverage: number;
    maxHoldBars?: number;
    entryFeatures: FeatureSnapshot;
  },
): void {
  store.db
    .prepare(
      `INSERT INTO trades(trade_id,engine,status,instrument,timeframe,side,strategy,strategy_core_version,strategy_version,regime,regime_axes,contracts,
        entry_px,entry_ts,stop_px,initial_stop_px,take_profit_px,cl_open_id,ord_open_id,
        raw_confidence,calibrated_confidence,planned_risk_pct,leverage,max_hold_bars,entry_features,entry_conditions,decision_id)
       VALUES(?,?, 'OPEN', ?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      t.tradeId, t.engine ?? inferTradingEngine(t.timeframe), t.instrument, t.timeframe, t.side,
      t.identity?.family ?? t.strategy, t.identity?.coreVersion ?? 1, t.identity?.strategyVersion ?? t.strategyVersion, t.regime,
      t.regimeAxes ? JSON.stringify(t.regimeAxes) : null, t.contracts,
      t.entryPx, t.entryTs, t.stopPx, t.stopPx, t.takeProfitPx, t.clOpenId, t.ordOpenId,
      t.rawConfidence, t.calibratedConfidence, t.plannedRiskPct, t.leverage, t.maxHoldBars ?? null, JSON.stringify(t.entryFeatures),
      t.entryConditions ? JSON.stringify(t.entryConditions) : null, t.decisionId ?? null,
    );
}

export interface ClosedMetrics {
  exitPx: number; exitTs: string; exitReason: string;
  fees: number; funding: number | null;
  pnl: number; pnlPct: number; resultR: number;
  mfe: number | null; mae: number | null; durationS: number;
}

// §27 — compute closed-trade metrics from the price path while open.
export function computeClosedMetrics(args: {
  side: "LONG" | "SHORT";
  entryPx: number; stopPx: number; exitPx: number;
  initialStopPx?: number | undefined;
  contracts: number; ctVal: number;
  exitReason: string;
  entryTs: string; exitTs: string;
  candlesWhileOpen: Candle[] | null;   // confirmed candles covering the complete open period
  fees: number; funding: number | null;
}): ClosedMetrics {
  const { side, entryPx, stopPx, exitPx, contracts, ctVal } = args;
  const dir = side === "LONG" ? 1 : -1;
  const path = args.candlesWhileOpen;
  // MFE/MAE: favorable/adverse price excursion magnitude (§27)
  let mfe: number | null = path ? 0 : null;
  let mae: number | null = path ? 0 : null;
  for (const c of path ?? []) {
    mfe = Math.max(mfe ?? 0, side === "LONG" ? c.h - entryPx : entryPx - c.l);
    mae = Math.max(mae ?? 0, side === "LONG" ? entryPx - c.l : c.h - entryPx);
  }
  const grossPnl = (exitPx - entryPx) * dir * contracts * ctVal;
  const pnl = grossPnl - args.fees + (args.funding ?? 0);
  const pnlPct = entryPx > 0 ? ((exitPx - entryPx) * dir / entryPx) * 100 : 0;
  const riskPerUnit = Math.abs(entryPx - (args.initialStopPx ?? stopPx));
  const riskCapital = riskPerUnit * contracts * ctVal;
  // Net R: realized cash PnL after fees/funding divided by initial cash risk.
  const resultR = riskCapital > 0 ? pnl / riskCapital : 0;
  const durationS = Math.max(0, Math.round((Date.parse(args.exitTs) - Date.parse(args.entryTs)) / 1000));
  return {
    exitPx, exitTs: args.exitTs, exitReason: args.exitReason,
    fees: args.fees, funding: args.funding,
    pnl, pnlPct, resultR, mfe, mae, durationS,
  };
}

export function closeTrade(store: Store, tradeId: string, m: ClosedMetrics): void {
  const eligible = m.funding !== null && m.mfe !== null && m.mae !== null && Number.isFinite(m.resultR) ? 1 : 0;
  const accountingQuality = m.funding === null ? "FUNDING_UNAVAILABLE" : "COMPLETE";
  store.db
    .prepare(
      `UPDATE trades SET status='CLOSED', result_r_basis=@resultRBasis, evidence_state=@evidenceState,
        evolution_evidence_eligible=@eligible, accounting_quality=@accountingQuality, exit_px=@exitPx, exit_ts=@exitTs, exit_reason=@exitReason,
        fees=@fees, funding=@funding, pnl=@pnl, pnl_pct=@pnlPct, result_r=@resultR,
        mfe=@mfe, mae=@mae, duration_s=@durationS
       WHERE trade_id=@tradeId AND status IN ('OPEN','RECONCILIATION_PENDING')`,
    )
    .run({ tradeId, ...m, eligible, accountingQuality,
      resultRBasis: m.funding === null ? "FEES_EX_FUNDING" : "NET",
      evidenceState: eligible ? "VALID" : "ACCOUNTING_INCOMPLETE" });
}

export function getOpenTrades(store: Store): Array<Record<string, unknown>> {
  return store.db.prepare("SELECT * FROM trades WHERE status IN ('OPEN','RECONCILIATION_PENDING')").all() as Array<Record<string, unknown>>;
}

/** Missing exchange exit proof leaves the trade unresolved and ineligible for all learning. */
export function markReconciliationPending(store: Store, tradeId: string, reason: string): void {
  store.db.prepare(`UPDATE trades SET status='RECONCILIATION_PENDING', evidence_state='RECONCILIATION_PENDING',
    evolution_evidence_eligible=0, accounting_quality='PENDING', exit_reason=?
    WHERE trade_id=? AND status IN ('OPEN','RECONCILIATION_PENDING')`).run(reason, tradeId);
}

export function getClosedTrades(store: Store, limit = 500): Array<Record<string, unknown>> {
  return store.db.prepare("SELECT * FROM trades WHERE status='CLOSED' ORDER BY exit_ts DESC LIMIT ?").all(limit) as Array<Record<string, unknown>>;
}
