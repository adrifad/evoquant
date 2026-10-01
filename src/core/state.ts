// M2 (§89) — bot state machine + persisted risk baselines (§23 daily loss,
// drawdown). State transitions are deterministic; RISK_HALTED only via
// kill-switch or confirmed emergency stop.
import type { Store } from "../memory/db.ts";
import { kvGet, kvSet } from "../memory/db.ts";

export type BotState = "STOPPED" | "STARTING" | "RUNNING" | "PAUSED" | "RISK_HALTED" | "ERROR";
export const BOT_STATES: readonly BotState[] = ["STOPPED", "STARTING", "RUNNING", "PAUSED", "RISK_HALTED", "ERROR"];

export function getBotState(store: Store): BotState {
  const s = kvGet(store, "bot_state");
  return (BOT_STATES as readonly string[]).includes(s ?? "") ? (s as BotState) : "STOPPED";
}

export function setBotState(store: Store, s: BotState): void {
  kvSet(store, "bot_state", s);
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
  kvSet(store, "emergency_stop", on ? "1" : "0");
}
