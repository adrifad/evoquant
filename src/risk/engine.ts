// M2 (§22/§23) — DETERMINISTIC risk engine. Final authority; AI cannot
// override (§2.1). Pure function of (proposal, account state, config).
// Every check from spec §22's diagram, in order, with explicit reason codes.

import type { FeatureSnapshot } from "../market/features.ts";
import type { Regime } from "../market/regime.ts";
import { REGIMES } from "../market/regime.ts";
import type { RiskConfig, TradingConfig } from "../core/config.ts";

export type DecisionAction = "LONG" | "SHORT" | "HOLD" | "CLOSE"; // §21 fixed enum
export const DECISION_ACTIONS: readonly DecisionAction[] = ["LONG", "SHORT", "HOLD", "CLOSE"];

export interface RiskState {
  equity: number;            // account equity (USDT)
  dayStartEquity: number;    // for daily loss % (§23)
  peakEquity: number;        // for drawdown % (§23)
  openPositions: number;     // concurrent count (§23)
  killSwitchActive: string | null; // reason if NO NEW ENTRIES (§23)
}

export interface RiskProposal {
  action: string;              // may be ANY string from AI — validated here
  strategy?: string | undefined;
  confidence: number;          // CALIBRATED confidence (§33)
  regime: string;              // may be ANY string from AI — validated here
  instrument: string;
  stopDistancePct?: number | undefined; // fraction of price to stop (0..1)
}

export interface RiskVerdict {
  approved: boolean;
  reason: RiskRejectCode | "APPROVED";
  checks: Record<string, boolean>;
}

export type RiskRejectCode =
  | "KILL_SWITCH_ACTIVE"
  | "INVALID_ACTION"
  | "INVALID_REGIME"
  | "INSTRUMENT_NOT_ALLOWED"
  | "CONFIDENCE_BELOW_MIN"
  | "INVALID_CONFIDENCE"
  | "POSITION_ALREADY_OPEN"
  | "NO_POSITION_TO_CLOSE"
  | "MAX_DAILY_LOSS_REACHED"
  | "MAX_DRAWDOWN_REACHED"
  | "INVALID_STOP_DISTANCE"
  | "BOT_NOT_RUNNING"
  | "INSTRUMENT_ALREADY_OCCUPIED"
  | "APPROVED";

export function evaluateEntry(
  p: RiskProposal,
  s: RiskState,
  trading: TradingConfig,
  risk: RiskConfig,
): RiskVerdict {
  const h = risk.hard_limits;
  const checks: Record<string, boolean> = {};

  // §23 kill-switch first: any active condition = NO NEW ENTRIES.
  checks.kill_switch_clear = s.killSwitchActive === null;
  if (!checks.kill_switch_clear) return deny("KILL_SWITCH_ACTIVE", checks);

  // §21 — enum validation: arbitrary strings never pass.
  checks.valid_action = (DECISION_ACTIONS as readonly string[]).includes(p.action);
  if (!checks.valid_action) return deny("INVALID_ACTION", checks);
  if (p.action === "HOLD") return { approved: true, reason: "APPROVED", checks }; // HOLD needs no risk budget
  if (p.action === "CLOSE") {
    checks.has_position = s.openPositions > 0;
    return checks.has_position
      ? { approved: true, reason: "APPROVED", checks }
      : deny("NO_POSITION_TO_CLOSE", checks);
  }

  checks.valid_regime = (REGIMES as readonly string[]).includes(p.regime);
  if (!checks.valid_regime) return deny("INVALID_REGIME", checks);

  // §23 allowed symbols.
  checks.instrument_allowed = h.allowed_symbols.includes(p.instrument);
  if (!checks.instrument_allowed) return deny("INSTRUMENT_NOT_ALLOWED", checks);

  // §22/§33 — calibrated confidence floor.
  checks.valid_confidence = Number.isFinite(p.confidence) && p.confidence >= 0 && p.confidence <= 1;
  if (!checks.valid_confidence) return deny("INVALID_CONFIDENCE", checks);
  checks.confidence_ok = p.confidence >= trading.decision.minimum_confidence;
  if (!checks.confidence_ok) return deny("CONFIDENCE_BELOW_MIN", checks);

  // §23 — max concurrent positions.
  checks.no_conflict = s.openPositions < h.max_concurrent_positions;
  if (!checks.no_conflict) return deny("POSITION_ALREADY_OPEN", checks);

  // §23 — daily loss and drawdown circuits breakers.
  const dailyLossPct = s.dayStartEquity > 0 ? ((s.dayStartEquity - s.equity) / s.dayStartEquity) * 100 : 0;
  checks.daily_loss_ok = dailyLossPct < h.max_daily_loss_pct;
  if (!checks.daily_loss_ok) return deny("MAX_DAILY_LOSS_REACHED", checks);

  const drawdownPct = s.peakEquity > 0 ? ((s.peakEquity - s.equity) / s.peakEquity) * 100 : 0;
  checks.drawdown_ok = drawdownPct < h.max_drawdown_pct;
  if (!checks.drawdown_ok) return deny("MAX_DRAWDOWN_REACHED", checks);

  // §24 — stop distance sanity (needed to derive risk).
  checks.stop_valid = p.stopDistancePct !== undefined && Number.isFinite(p.stopDistancePct) && p.stopDistancePct > 0 && p.stopDistancePct <= 0.2;
  if (!checks.stop_valid) return deny("INVALID_STOP_DISTANCE", checks);

  return { approved: true, reason: "APPROVED", checks };
}

function deny(reason: RiskRejectCode, checks: Record<string, boolean>): RiskVerdict {
  return { approved: false, reason, checks };
}
