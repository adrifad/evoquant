type Row = Record<string, unknown>;

export type RiskAssessment = "SAFE" | "WARNING" | "HALTED" | "UNKNOWN";
export type EntryReadinessState = "READY_FOR_PRECHECK" | "BLOCKED" | "UNKNOWN";

export function assessRiskStatus(status: Row | null, fetchedAt: number | null = null, now = Date.now()): {
  assessment: RiskAssessment;
  reasons: string[];
  readiness: EntryReadinessState;
  blockers: Array<{ code: string; message: string }>;
  dataAgeMs: number | null;
  dataStale: boolean;
} {
  if (!status) return { assessment: "UNKNOWN", reasons: ["Risk status is unavailable."], readiness: "UNKNOWN",
    blockers: [], dataAgeMs: null, dataStale: true };
  const limits = row(status.limits);
  const daily = row(status.daily);
  const drawdown = number(status.drawdownPct);
  const dailyLoss = number(daily.lossPct);
  const dailyLimit = number(limits.max_daily_loss_pct);
  const drawdownLimit = number(limits.max_drawdown_pct);
  const halted = status.emergencyHalted === true || Boolean(status.persistedHaltReason) || Boolean(status.killReason)
    || ["RISK_HALTED", "ERROR"].includes(text(status.botState));
  const reasons: string[] = [];
  if (status.botState === "PAUSED") reasons.push("Bot is paused; new entries are blocked.");
  if (dailyLoss !== null && dailyLimit !== null && dailyLimit > 0 && dailyLoss >= dailyLimit * 0.75)
    reasons.push(`Daily loss is ${dailyLoss.toFixed(2)}% of equity against a ${dailyLimit}% limit.`);
  if (drawdown !== null && drawdownLimit !== null && drawdownLimit > 0 && drawdown >= drawdownLimit * 0.75)
    reasons.push(`Drawdown is ${drawdown.toFixed(2)}% against a ${drawdownLimit}% limit.`);
  if (status.exchangeConnectivity !== "CONNECTED") reasons.push(`Exchange connectivity is ${text(status.exchangeConnectivity, "UNKNOWN").toLowerCase()}.`);
  if (!["VERIFIED_OR_FLAT"].includes(text(status.protectionVerificationStatus)))
    reasons.push(`Protection verification is ${text(status.protectionVerificationStatus, "UNKNOWN").toLowerCase().replaceAll("_", " ")}.`);
  const monitors = row(status.positionMonitoring);
  const required = Object.values(monitors).map(row).filter((item) => item.required === true);
  const monitoringUnavailableWithPositions = (number(status.openPositionCount) ?? 0) > 0
    && ((status.positionMonitoring === null || status.positionMonitoring === undefined) || required.length === 0);
  if (monitoringUnavailableWithPositions) reasons.push("Position monitoring health is unavailable while the account has open positions.");
  if (required.some((item) => ["DEGRADED", "FAILED"].includes(text(item.health))))
    reasons.push("One or more required position monitors are degraded or failed.");
  const dataAgeMs = fetchedAt === null ? null : Math.max(0, now - fetchedAt);
  const dataStale = dataAgeMs === null || dataAgeMs > 30_000;
  if (dataStale) reasons.push("Risk snapshot is stale or its refresh time is unavailable.");
  if (halted) {
    const halt = text(status.persistedHaltReason, text(status.killReason, text(status.botState, "Safety halt active")));
    if (status.emergencyHalted === true) reasons.unshift("Emergency Stop is active.");
    else if (!reasons.some((reason) => reason.toLowerCase().includes("halt"))) reasons.unshift(`Trading is halted: ${halt}.`);
  }
  const requiredNumbersKnown = number(status.equity) !== null && dailyLoss !== null && dailyLimit !== null
    && drawdown !== null && drawdownLimit !== null;
  const readinessPayload = row(status.entryReadiness);
  const blockers = rows(readinessPayload.blockers).map((item) => ({
    code: text(item.code, "UNKNOWN"), message: text(item.message, text(item.code, "Unspecified readiness blocker.")),
  }));
  for (const blocker of blockers) {
    if (!reasons.includes(blocker.message) && blocker.code !== "BOT_NOT_RUNNING") reasons.push(blocker.message);
  }
  const readiness: EntryReadinessState = dataStale || readinessPayload.state === "UNKNOWN" || !Object.keys(readinessPayload).length
    ? "UNKNOWN" : status.newEntriesPermitted === true && readinessPayload.permitted === true
      ? "READY_FOR_PRECHECK" : "BLOCKED";
  const protectionUnknown = !text(status.protectionVerificationStatus) || status.protectionVerificationStatus === "UNKNOWN";
  const monitorUnknown = monitoringUnavailableWithPositions || required.some((item) => text(item.health, "UNKNOWN") === "UNKNOWN");
  const assessment: RiskAssessment = halted ? "HALTED"
    : dataStale || !requiredNumbersKnown || status.exchangeConnectivity === "UNKNOWN" || protectionUnknown || monitorUnknown ? "UNKNOWN"
      : reasons.length ? "WARNING" : "SAFE";
  return { assessment, reasons, readiness, blockers, dataAgeMs, dataStale };
}

export function monitorGroupState(monitoring: Row | null): "REQUIRED" | "NOT_REQUIRED" | "UNKNOWN" {
  if (!monitoring) return "UNKNOWN";
  const values = Object.values(monitoring).map(row).filter((item) => Object.keys(item).length > 0);
  if (!values.length) return "UNKNOWN";
  return values.some((item) => item.required === true) ? "REQUIRED"
    : values.every((item) => item.required === false || item.health === "NOT_REQUIRED") ? "NOT_REQUIRED" : "UNKNOWN";
}

function row(value: unknown): Row { return value && typeof value === "object" && !Array.isArray(value) ? value as Row : {}; }
function rows(value: unknown): Row[] { return Array.isArray(value) ? value.map(row) : []; }
function number(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const result = Number(value);
  return Number.isFinite(result) ? result : null;
}
function text(value: unknown, fallback = ""): string { return typeof value === "string" && value.trim() ? value : fallback; }
