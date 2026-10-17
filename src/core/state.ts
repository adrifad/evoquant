// M2 (§89) — bot state machine + persisted risk baselines (§23 daily loss,
// drawdown). State transitions are deterministic; RISK_HALTED only via
// kill-switch or confirmed emergency stop.
import type { Store } from "../memory/db.ts";
import { kvGet, kvSet } from "../memory/db.ts";

const SAFETY_REVISION_KEY = "safety_state_revision";
const DESIRED_OPERATIONAL_STATE_KEY = "desired_operational_state";
const ENTRY_RESERVATION_KEY = "unresolved_entry_v1";

function revision(store: Store): number {
  const raw = kvGet(store, SAFETY_REVISION_KEY);
  if (raw === null) return 0;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 0 ? value : -1;
}

function bumpRevision(store: Store): void {
  const current = revision(store);
  kvSet(store, SAFETY_REVISION_KEY, String(current >= 0 ? current + 1 : 1));
}

function setSafetyKv(store: Store, key: string, value: string, touchUnchanged = false): void {
  store.db.transaction(() => {
    if (!touchUnchanged && kvGet(store, key) === value) return;
    kvSet(store, key, value);
    bumpRevision(store);
  }).immediate();
}

export function getSafetyStateRevision(store: Store): number { return revision(store); }

/** Call from a durable risk-policy mutation so recovery snapshots cannot commit
 * against a different set of operational limits. Safe inside SQLite transactions. */
export function recordSafetyStateChange(store: Store): void {
  store.db.transaction(() => bumpRevision(store)).immediate();
}

export type BotState = "STOPPED" | "STARTING" | "RUNNING" | "PAUSED" | "RISK_HALTED" | "ERROR";
export const BOT_STATES: readonly BotState[] = ["STOPPED", "STARTING", "RUNNING", "PAUSED", "RISK_HALTED", "ERROR"];

export function getBotState(store: Store): BotState {
  const s = kvGet(store, "bot_state");
  return (BOT_STATES as readonly string[]).includes(s ?? "") ? (s as BotState) : "STOPPED";
}

export function setBotState(store: Store, s: BotState): void {
  setSafetyKv(store, "bot_state", s);
}

export type DesiredOperationalState = "RUNNING" | "PAUSED";

export function getDesiredOperationalState(store: Store): DesiredOperationalState | null {
  const value = kvGet(store, DESIRED_OPERATIONAL_STATE_KEY);
  return value === "RUNNING" || value === "PAUSED" ? value : null;
}

export function setDesiredOperationalState(store: Store, state: DesiredOperationalState): void {
  setSafetyKv(store, DESIRED_OPERATIONAL_STATE_KEY, state, true);
}

/** One-time backward-compatible intent initialization. Unknown halted intent
 * defaults to PAUSED so a database upgrade can never resume entries silently. */
export function ensureDesiredOperationalState(store: Store, previousState: BotState): DesiredOperationalState {
  const existing = getDesiredOperationalState(store);
  if (existing) return existing;
  const desired: DesiredOperationalState = previousState === "PAUSED" || previousState === "RISK_HALTED" || previousState === "ERROR"
    ? "PAUSED" : "RUNNING";
  setDesiredOperationalState(store, desired);
  return desired;
}

/** Persist the provenance of a risk halt; a null kill-switch sample is not a
 * sufficient reason to clear a halt established by another safety subsystem. */
export function setRiskHaltReason(store: Store, reason: string): void {
  setSafetyKv(store, "risk_halt_reason", reason, true);
}

export function getRiskHaltReason(store: Store): string | null {
  const reason = kvGet(store, "risk_halt_reason");
  return reason ? reason : null;
}

export function clearRiskHaltReason(store: Store): void {
  setSafetyKv(store, "risk_halt_reason", "");
}

export interface EquityBaseline {
  dayKey: string;        // YYYY-MM-DD UTC
  dayStartEquity: number;
  peakEquity: number;
}

export function baseline(store: Store, equity: number): EquityBaseline {
  const dayKey = new Date().toISOString().slice(0, 10);
  let b = { dayKey, dayStartEquity: equity, peakEquity: equity };
  const raw = kvGet(store, "equity_baseline");
  if (raw) {
    const p = JSON.parse(raw) as EquityBaseline;
    b = {
      dayKey,
      dayStartEquity: p.dayKey === dayKey ? p.dayStartEquity : equity,
      peakEquity: Math.max(p.peakEquity ?? equity, equity),
    };
  }
  kvSet(store, "equity_baseline", JSON.stringify(b));
  return b;
}

export function isEmergencyHalted(store: Store): boolean {
  const v = kvGet(store, "emergency_stop");
  return v !== "0"; // fail-closed: absent state = halted (§23/§45)
}

export function setEmergencyHalted(store: Store, on: boolean): void {
  setSafetyKv(store, "emergency_stop", on ? "1" : "0", true);
}

/** Atomically commits recovery only if no safety-critical writer has changed
 * the state since verification began. The callback is synchronous and must
 * only inspect local durable state; never perform network I/O here. */
export function commitVerifiedProtectionRecovery(store: Store, expected: {
  revision: number;
  haltReason: string;
}): { committed: boolean; state: BotState; reason: string } {
  return store.db.transaction(() => {
    const currentState = getBotState(store);
    const currentReason = getRiskHaltReason(store);
    const currentRevision = revision(store);
    const unchanged = currentRevision >= 0 && currentRevision === expected.revision
      && currentState === "RISK_HALTED"
      && !isEmergencyHalted(store)
      && currentReason === expected.haltReason;
    if (!unchanged) return { committed: false, state: currentState, reason: "SAFETY_STATE_CHANGED" };
    if (kvGet(store, ENTRY_RESERVATION_KEY) !== null) {
      return { committed: false, state: currentState, reason: "ENTRY_RESERVATION_UNRESOLVED" };
    }
    const pending = store.db.prepare("SELECT 1 FROM trades WHERE status='RECONCILIATION_PENDING' LIMIT 1").get();
    if (pending) return { committed: false, state: currentState, reason: "RECONCILIATION_PENDING" };
    const desired = getDesiredOperationalState(store) ?? "PAUSED";
    kvSet(store, "risk_halt_reason", "");
    kvSet(store, "bot_state", desired);
    bumpRevision(store);
    return { committed: true, state: desired, reason: "PROTECTION_STATE_VERIFIED" };
  }).immediate();
}
