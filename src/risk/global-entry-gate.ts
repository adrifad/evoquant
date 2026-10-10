import type { RiskConfig } from "../core/config.ts";
import type { BotState } from "../core/state.ts";

export interface GlobalEntryGateInput {
  killSwitchActive: string | null;
  botState: BotState;
  openPositions: number;
  instrument: string;
  instrumentOccupied: boolean;
  portfolioOpenRiskPct?: number | null;
  candidateRiskPct?: number | null;
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
    portfolio_risk_known: input.portfolioOpenRiskPct === undefined
      || (input.portfolioOpenRiskPct !== null && input.candidateRiskPct !== null && input.candidateRiskPct !== undefined),
    within_portfolio_open_risk: input.portfolioOpenRiskPct === undefined
      || (input.portfolioOpenRiskPct !== null && input.candidateRiskPct !== null && input.candidateRiskPct !== undefined
        && input.portfolioOpenRiskPct + input.candidateRiskPct <= risk.hard_limits.max_portfolio_open_risk_pct),
  };
  const failures = Object.entries(checks).filter(([, passed]) => !passed).map(([name]) => name);
  if (failures.length) {
    const reason = input.killSwitchActive
      ? `KILL_SWITCH_ACTIVE:${input.killSwitchActive}`
      : !checks.bot_running ? `BOT_${input.botState}`
      : !checks.within_position_limit ? "MAX_CONCURRENT_POSITIONS"
      : !checks.instrument_unoccupied ? "INSTRUMENT_ALREADY_OCCUPIED"
      : !checks.portfolio_risk_known ? "PORTFOLIO_OPEN_RISK_UNAVAILABLE"
      : !checks.within_portfolio_open_risk ? "PORTFOLIO_OPEN_RISK_LIMIT"
      : "INSTRUMENT_NOT_ALLOWED";
    return { allowed: false, reason, checks };
  }
  return { allowed: true, reason: "APPROVED", checks };
}
