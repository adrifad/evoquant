import type { Store } from "../memory/db.ts";
import { logSystemEvent } from "../memory/db.ts";
import { ensureDesiredOperationalState, getBotState, getRiskHaltReason, isEmergencyHalted, setBotState, setRiskHaltReason } from "./state.ts";

export interface DashboardHandle {
  close(): void;
  address(): unknown;
}

/**
 * Run startup verification without making dashboard availability conditional
 * on exchange health. A failed safety check persists a fail-closed state; the
 * caller can still start reconciliation and position monitors afterward.
 */
export async function runStartupSafetyAndStartDashboard<T extends DashboardHandle>(
  store: Store,
  safetyCheck: () => Promise<boolean>,
  startDashboard: () => T,
): Promise<{ safetyPassed: boolean; previousState: ReturnType<typeof getBotState>; previousHaltReason: string | null; dashboard: T }> {
  const previousState = getBotState(store);
  const previousHaltReason = getRiskHaltReason(store);
  ensureDesiredOperationalState(store, previousState);
  if (previousState !== "RISK_HALTED" && previousState !== "PAUSED") setBotState(store, "STARTING");
  let safetyPassed = false;
  try { safetyPassed = await safetyCheck(); }
  catch (error) {
    logSystemEvent(store, "STATE", { event: "STARTUP_SAFETY_FAILED", reason: "STARTUP_CHECK_THROWN",
      detail: error instanceof Error ? error.message.slice(0, 160) : "UNKNOWN" });
  }
  if (!safetyPassed) {
    if (!getRiskHaltReason(store)) setRiskHaltReason(store, "STARTUP_SAFETY_FAILURE");
    setBotState(store, "RISK_HALTED");
    logSystemEvent(store, "RISK_EVENT", { event: "STARTUP_SAFETY_FAILED", haltReason: getRiskHaltReason(store), newEntriesPermitted: false });
  } else if (previousState === "RISK_HALTED" || getBotState(store) === "RISK_HALTED") {
    // A passing startup probe is not permission to clear a persisted halt.
    setBotState(store, "RISK_HALTED");
  } else if (isEmergencyHalted(store)) {
    setRiskHaltReason(store, getRiskHaltReason(store) ?? "MANUAL_EMERGENCY_STOP");
    setBotState(store, "RISK_HALTED");
  }
  const dashboard = startDashboard();
  return { safetyPassed, previousState, previousHaltReason, dashboard };
}
