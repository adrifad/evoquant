import type { RiskConfig } from "../core/config.ts";
import type { BotState } from "../core/state.ts";

export interface GlobalEntryGateInput {
  killSwitchActive: string | null;
  botState: BotState;
  openPositions: number;
  instrument: string;
  instrumentOccupied: boolean;
}

export interface GlobalEntryGateResult {
  allowed: boolean;
  reason: string;
  checks: Record<string, boolean>;
}

/** Shared deterministic gate for every engine; exchange/global risk stays above LLM gates. */
export function evaluateGlobalEntryGate(input: GlobalEntryGateInput, risk: RiskConfig): GlobalEntryGateResult {
  const checks: Record<string, boolean> = {
    kill_switch_clear: input.killSwitchActive === null,
    bot_running: input.botState === "RUNNING",
    within_position_limit: input.openPositions < risk.hard_limits.max_concurrent_positions,
    instrument_unoccupied: !input.instrumentOccupied,
    instrument_allowed: risk.hard_limits.allowed_symbols.includes(input.instrument),
  };
  const failures = Object.entries(checks).filter(([, passed]) => !passed).map(([name]) => name);
  if (failures.length) {
    const reason = input.killSwitchActive
      ? `KILL_SWITCH_ACTIVE:${input.killSwitchActive}`
      : !checks.bot_running ? `BOT_${input.botState}`
      : !checks.within_position_limit ? "MAX_CONCURRENT_POSITIONS"
      : !checks.instrument_unoccupied ? "INSTRUMENT_ALREADY_OCCUPIED"
      : "INSTRUMENT_NOT_ALLOWED";
    return { allowed: false, reason, checks };
  }
  return { allowed: true, reason: "APPROVED", checks };
}
