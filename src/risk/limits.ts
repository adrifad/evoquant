// M2 (§23) — kill-switch evaluator: pure, deterministic, ordered checks.
import type { RiskConfig } from "../core/config.ts";
import type { Store } from "../memory/db.ts";
import { isEmergencyHalted } from "../core/state.ts";

export interface KillInputs {
  apiOk: boolean;
  positionMismatch: boolean;
  orderFailuresRecent: number; // consecutive failures
  clockDriftMs: number;
  dbOk: boolean;
  instrumentMetaOk: boolean;
  unexpectedPosition: boolean;
  dailyLossPct: number;
  drawdownPct: number;
}

// Returns active kill reason or null.
export function evaluateKillSwitch(
  inputs: KillInputs,
  risk: RiskConfig,
  store?: Store,
): string | null {
  if (store && isEmergencyHalted(store)) return "EMERGENCY_STOP";
  if (!inputs.dbOk) return "DATABASE_UNAVAILABLE";
  if (!inputs.apiOk) return "API_STATE_UNCERTAIN";
  if (!inputs.instrumentMetaOk) return "INVALID_INSTRUMENT_METADATA";
  if (Math.abs(inputs.clockDriftMs) > risk.clock_drift_max_ms) return "CLOCK_DRIFT_EXCEEDED";
  if (inputs.positionMismatch) return "POSITION_MISMATCH";
  if (inputs.unexpectedPosition) return "UNEXPECTED_POSITION";
  if (inputs.orderFailuresRecent >= 3) return "REPEATED_ORDER_FAILURE";
  if (inputs.dailyLossPct >= risk.hard_limits.max_daily_loss_pct) return "MAX_DAILY_LOSS_REACHED";
  if (inputs.drawdownPct >= risk.hard_limits.max_drawdown_pct) return "MAX_ACCOUNT_DRAWDOWN_REACHED";
  return null;
}
