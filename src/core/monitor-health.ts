export type PositionMonitorEngine = "SWING_15M" | "SCALP_5M";
export type PositionMonitorHealth = "HEALTHY" | "DEGRADED" | "FAILED" | "UNKNOWN" | "NOT_REQUIRED";

export interface PositionMonitorStatus {
  enabled: boolean;
  required: boolean;
  lastAttemptAt: string | null;
  lastSuccessfulSweepAt: string | null;
  lastErrorAt: string | null;
  lastError: string | null;
  consecutiveFailures: number;
  currentlyRunning: boolean;
  durationMs: number | null;
  health: PositionMonitorHealth;
}

export type PositionOwnership = "OWNED_BY_ENGINE" | "OWNED_BY_OTHER_ENGINE" | "ORPHAN" | "OWNERSHIP_CONFLICT";

/** Classify the exchange snapshot against all locally managed engines before
 * an engine labels another engine's valid position as orphan exposure.
 */
export function classifyPositionOwnership(
  position: { instId: string; posSide: string },
  trades: readonly Record<string, unknown>[],
  engine: PositionMonitorEngine,
): PositionOwnership {
  const matches = trades.filter((trade) => String(trade.instrument) === position.instId
    && String(trade.side).toLowerCase() === position.posSide.toLowerCase()
    && ["OPEN", "RECONCILIATION_PENDING"].includes(String(trade.status)));
  if (matches.length === 0) return "ORPHAN";
  if (matches.length > 1) return "OWNERSHIP_CONFLICT";
  const tradeEngine = String(matches[0]!.engine);
  return (engine === "SWING_15M" && tradeEngine === "SWING_15M")
    || (engine === "SCALP_5M" && tradeEngine === "SCALP_5M")
    ? "OWNED_BY_ENGINE" : "OWNED_BY_OTHER_ENGINE";
}

type InternalStatus = Omit<PositionMonitorStatus, "health" | "required"> & {
  partialFailure: boolean;
  lastAttemptMs: number | null;
  lastSuccessMs: number | null;
};

const INTERVAL_MS: Record<PositionMonitorEngine, number> = { SWING_15M: 60_000, SCALP_5M: 15_000 };
const STALE_FACTOR = 2.5;

/** A position-specific failure is reported without suppressing management of
 * later positions in the same exchange snapshot. */
export async function runMonitorItemsIsolated<T>(
  items: readonly T[],
  work: (item: T) => Promise<void>,
  onFailure: (item: T, error: unknown) => void,
): Promise<void> {
  for (const item of items) {
    try { await work(item); }
    catch (error) { onFailure(item, error); }
  }
}

/** Runtime telemetry for actual position-management sweeps, not timer setup. */
export class PositionMonitorHealthTracker {
  private readonly state: Record<PositionMonitorEngine, InternalStatus> = {
    SWING_15M: this.initialState(), SCALP_5M: this.initialState(),
  };

  private initialState(): InternalStatus {
    return { enabled: true, lastAttemptAt: null, lastSuccessfulSweepAt: null, lastErrorAt: null,
      lastError: null, consecutiveFailures: 0, currentlyRunning: false, durationMs: null,
      partialFailure: false, lastAttemptMs: null, lastSuccessMs: null };
  }

  setEnabled(engine: PositionMonitorEngine, enabled: boolean): void { this.state[engine].enabled = enabled; }

  async execute(engine: PositionMonitorEngine, work: (partialFailure: (error: unknown) => void) => Promise<void>): Promise<boolean> {
    const state = this.state[engine];
    if (!state.enabled || state.currentlyRunning) return false;
    const started = Date.now();
    state.currentlyRunning = true;
    state.lastAttemptMs = started;
    state.lastAttemptAt = new Date(started).toISOString();
    state.partialFailure = false;
    const partialFailure = (error: unknown) => {
      state.partialFailure = true;
      state.lastErrorAt = new Date().toISOString();
      state.lastError = safeError(error);
    };
    try {
      await work(partialFailure);
      state.lastSuccessMs = Date.now();
      state.lastSuccessfulSweepAt = new Date(state.lastSuccessMs).toISOString();
      if (!state.partialFailure) state.consecutiveFailures = 0;
      else state.consecutiveFailures++;
      return true;
    } catch (error) {
      state.lastErrorAt = new Date().toISOString();
      state.lastError = safeError(error);
      state.consecutiveFailures++;
      return false;
    } finally {
      state.durationMs = Date.now() - started;
      state.currentlyRunning = false;
    }
  }

  snapshot(required: Record<PositionMonitorEngine, boolean>, now = Date.now()): Record<PositionMonitorEngine, PositionMonitorStatus> {
    return {
      SWING_15M: this.project("SWING_15M", required.SWING_15M, now),
      SCALP_5M: this.project("SCALP_5M", required.SCALP_5M, now),
    };
  }

  private project(engine: PositionMonitorEngine, required: boolean, now: number): PositionMonitorStatus {
    const state = this.state[engine];
    let health: PositionMonitorHealth;
    if (!required) health = "NOT_REQUIRED";
    else if (!state.enabled) health = "FAILED";
    else if (state.lastSuccessMs === null) health = state.consecutiveFailures >= 3 ? "FAILED" : "UNKNOWN";
    else if (now - state.lastSuccessMs > INTERVAL_MS[engine] * STALE_FACTOR) health = state.consecutiveFailures >= 3 ? "FAILED" : "DEGRADED";
    else if (state.partialFailure || (state.lastAttemptMs !== null && state.lastSuccessMs < state.lastAttemptMs)) health = "DEGRADED";
    else health = "HEALTHY";
    const { partialFailure: _partialFailure, lastAttemptMs: _lastAttemptMs, lastSuccessMs: _lastSuccessMs, ...publicState } = state;
    return { ...publicState, required, health };
  }
}

function safeError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 180);
}
