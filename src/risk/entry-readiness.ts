import type { BotState } from "../core/state.ts";

export type EntryReadinessBlockerCode =
  | "BOT_NOT_RUNNING" | "EMERGENCY_STOP" | "PERSISTED_RISK_HALT" | "KILL_SWITCH_ACTIVE"
  | "EXCHANGE_UNAVAILABLE" | "ENTRY_RESERVATION_UNRESOLVED" | "RECONCILIATION_PENDING"
  | "PROTECTION_DEGRADED" | "UNEXPECTED_EXPOSURE" | "POSITION_MISMATCH" | "INSTRUMENT_METADATA_UNAVAILABLE"
  | "DAILY_LOSS_LIMIT" | "DRAWDOWN_LIMIT" | "POSITION_CAP_REACHED" | "PORTFOLIO_RISK_LIMIT";

export interface EntryReadinessBlocker {
  code: EntryReadinessBlockerCode;
  message: string;
}

export interface EntryReadinessProjection {
  permitted: boolean;
  state: "BLOCKED" | "PRELIMINARY_READY";
  scope: "ACCOUNT_WIDE_PRELIMINARY";
  blockers: EntryReadinessBlocker[];
  evaluatedAt: string;
  note: string;
}

export interface EntryReadinessInput {
  botState: BotState;
  emergencyHalted: boolean;
  persistedHaltReason: string | null;
  killSwitchObservation: string | null;
  exchangeConnected: boolean;
  entryReservationUnresolved: boolean;
  reconciliationPending: number;
  protectionStatus: string;
  unexpectedExposure: boolean;
  positionMismatch: boolean;
  instrumentMetadataMissing: boolean;
  dailyLossPct: number | null;
  dailyLossLimitPct: number;
  drawdownPct: number | null;
  drawdownLimitPct: number;
  openPositionCount: number | null;
  maxConcurrentPositions: number;
  portfolioRiskPct: number | null;
  portfolioRiskLimitPct: number;
}

/** Account-wide preliminary gate projection. A permitted result is not an
 * authorization for a symbol or an order; the executor repeats live checks. */
export function projectEntryReadiness(input: EntryReadinessInput, evaluatedAt = new Date().toISOString()): EntryReadinessProjection {
  const blockers: EntryReadinessBlocker[] = [];
  const add = (code: EntryReadinessBlockerCode, message: string) => {
    if (!blockers.some((blocker) => blocker.code === code)) blockers.push({ code, message });
  };
  if (input.botState !== "RUNNING") add("BOT_NOT_RUNNING", `Bot state is ${input.botState}.`);
  if (input.emergencyHalted) add("EMERGENCY_STOP", "Emergency Stop is active.");
  if (input.persistedHaltReason) add("PERSISTED_RISK_HALT", `Risk halt is active: ${input.persistedHaltReason}.`);
  if (input.killSwitchObservation) add("KILL_SWITCH_ACTIVE", `Latest kill-switch observation: ${input.killSwitchObservation}.`);
  if (!input.exchangeConnected) add("EXCHANGE_UNAVAILABLE", "Exchange positions and balance are not both confirmed.");
  if (input.entryReservationUnresolved) add("ENTRY_RESERVATION_UNRESOLVED", "An entry submission still requires reconciliation.");
  if (input.reconciliationPending > 0) add("RECONCILIATION_PENDING", `${input.reconciliationPending} trade(s) still require execution reconciliation.`);
  if (input.protectionStatus !== "VERIFIED_OR_FLAT") add("PROTECTION_DEGRADED", `Position protection state is ${input.protectionStatus}.`);
  if (input.unexpectedExposure) add("UNEXPECTED_EXPOSURE", "An exchange position has no matching local trade.");
  if (input.positionMismatch) add("POSITION_MISMATCH", "Local and exchange position records do not match.");
  if (input.instrumentMetadataMissing) add("INSTRUMENT_METADATA_UNAVAILABLE", "Exact instrument metadata is missing for managed exposure.");
  if (input.dailyLossPct === null) add("EXCHANGE_UNAVAILABLE", "Daily loss cannot be evaluated without current equity.");
  else if (input.dailyLossPct >= input.dailyLossLimitPct) add("DAILY_LOSS_LIMIT", "Configured daily loss limit has been reached.");
  if (input.drawdownPct === null) add("EXCHANGE_UNAVAILABLE", "Drawdown cannot be evaluated without current equity.");
  else if (input.drawdownPct >= input.drawdownLimitPct) add("DRAWDOWN_LIMIT", "Configured drawdown limit has been reached.");
  if (input.openPositionCount === null) add("EXCHANGE_UNAVAILABLE", "Open position count is unknown.");
  else if (input.openPositionCount >= input.maxConcurrentPositions) add("POSITION_CAP_REACHED", "No concurrent position slots remain.");
  if (input.portfolioRiskPct === null) add("EXCHANGE_UNAVAILABLE", "Portfolio stop risk cannot be evaluated.");
  else if (input.portfolioRiskPct >= input.portfolioRiskLimitPct) add("PORTFOLIO_RISK_LIMIT", "Portfolio open-risk limit has been reached.");
  return {
    permitted: blockers.length === 0,
    state: blockers.length === 0 ? "PRELIMINARY_READY" : "BLOCKED",
    scope: "ACCOUNT_WIDE_PRELIMINARY",
    blockers,
    evaluatedAt,
    note: "Symbol-specific risk and final exchange verification are repeated before every order.",
  };
}
