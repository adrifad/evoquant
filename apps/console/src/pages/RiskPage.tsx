import { useApi } from "../hooks/useApi";
import { formatAmount, formatNumber, formatPercent, formatTimestamp } from "../lib/format";
import { asNumber, asRow, asRows, asText, parseJson, type ApiState, type Row } from "../lib/types";
import { Activity, AlertTriangle, CheckCircle2, Clock3, Gauge, Layers, RefreshCw, Shield, ShieldAlert, ShieldCheck, Wallet, Wifi, WifiOff } from "lucide-react";
import { DataState, DataTable, PageHeading, Panel, StatusBadge } from "../components/Primitives";
import { RiskSettings } from "../components/RiskSettings";
import { assessRiskStatus, monitorGroupState } from "./risk-view-model";

export function RiskPage({ status }: { status: ApiState<Row> }) {
  const eventsApi = useApi<unknown>("/api/events");
  const s = status.data;
  if (!s) return <div className="page"><PageHeading title="Risk Control Center" description="Account exposure, entry readiness, protection health, and operational risk limits."/><DataState loading={status.loading} error={status.error} empty={false}><span/></DataState></div>;

  const limits = asRow(s.limits) ?? {};
  const daily = asRow(s.daily) ?? {};
  const capital = asRow(s.capital) ?? {};
  const portfolio = asRow(s.portfolioRisk) ?? {};
  const reconciliation = asRow(s.reconciliation) ?? {};
  const recovery = asRow(s.lastRecoveryAttempt) ?? {};
  const recoveryPayload = asRow(recovery.payload) ?? {};
  const monitoring = asRow(s.positionMonitoring);
  const assessment = assessRiskStatus(s, status.updatedAt);
  const open = asRows(s.openPositions);
  const managedOpen = open.filter((trade) => trade.status === "OPEN");
  const dailyLoss = asNumber(daily.lossPct);
  const drawdown = asNumber(s.drawdownPct);
  const dailyLimit = asNumber(limits.max_daily_loss_pct);
  const drawdownLimit = asNumber(limits.max_drawdown_pct);
  const portfolioRisk = asNumber(portfolio.riskPct);
  const portfolioLimit = asNumber(limits.max_portfolio_open_risk_pct);
  const lossToStops = asNumber(portfolio.lossToStops);
  const maxPositions = asNumber(limits.max_concurrent_positions);
  const availableSlots = asNumber(s.availablePositionSlots);
  const pendingCount = asNumber(reconciliation.pendingCount);
  const statusAge = assessment.dataAgeMs;
  const riskEvents = asRows(eventsApi.data).filter((event) => String(event.kind).includes("RISK") || event.kind === "STATE");
  const swingMonitor = asRow(monitoring?.SWING_15M);
  const scalpMonitor = asRow(monitoring?.SCALP_5M);
  const noMonitorRequired = monitorGroupState(monitoring) === "NOT_REQUIRED";
  const lastRefresh = status.updatedAt === null ? "Unavailable" : formatTimestamp(status.updatedAt);
  const monitoringErrors = [swingMonitor, scalpMonitor].flatMap((item) => item && item.required === true
    && ["DEGRADED", "FAILED"].includes(asText(item.health)) ? [asText(item.lastError, asText(item.health))] : []);

  return <div className="page risk-page">
    <PageHeading title="Risk Control Center" description="Account exposure, entry readiness, protection health, and operational risk limits."
      detail={<div className="risk-heading-status"><StatusBadge value={assessment.assessment}/><button type="button" className="secondary-button" onClick={() => { void status.reload(true); void eventsApi.reload(true); }}><RefreshCw size={14}/>Refresh</button></div>}/>

    <div className={`risk-summary risk-summary-${assessment.assessment.toLowerCase()}`} role={assessment.assessment === "HALTED" ? "alert" : "status"}>
      <span className="risk-summary-icon">{assessment.assessment === "HALTED" ? <ShieldAlert size={18}/> : assessment.assessment === "SAFE" ? <ShieldCheck size={18}/> : <AlertTriangle size={18}/>}</span>
      <div><strong>{assessment.assessment === "HALTED" ? "Entries halted" : assessment.assessment === "SAFE" ? "No active risk warning" : assessment.assessment === "WARNING" ? "Risk warning" : "Risk state unavailable"}</strong>
        <p>{assessment.reasons.length ? assessment.reasons.join(" ") : "Configured limits and current account checks are within their reported bounds."}</p>
      </div>
      <span className="risk-refresh-meta"><Clock3 size={13}/>Refreshed {lastRefresh}{statusAge !== null ? ` · ${Math.round(statusAge / 1000)}s ago` : ""}</span>
    </div>

    <section className="risk-overview-grid" aria-label="Account risk overview">
      <RiskKpi label="Account equity" value={formatAmount(s.equity)} detail={`Available ${formatAmount(capital.available)} · ${asText(capital.state, "exchange snapshot")}`} icon={<Wallet size={17}/>}/>
      <RiskKpi label="Daily loss" value={formatPercent(dailyLoss, 2, false)} detail={`Limit ${dailyLimit === null ? "Unavailable" : `${formatNumber(dailyLimit)}%`}`} icon={<Activity size={17}/>}>
        <RiskMeter value={dailyLoss} limit={dailyLimit} label="Daily loss utilization"/>
      </RiskKpi>
      <RiskKpi label="Maximum drawdown" value={formatPercent(drawdown, 2, false)} detail={`Limit ${drawdownLimit === null ? "Unavailable" : `${formatNumber(drawdownLimit)}%`}`} icon={<Gauge size={17}/> }>
        <RiskMeter value={drawdown} limit={drawdownLimit} label="Drawdown utilization"/>
      </RiskKpi>
      <RiskKpi label="Portfolio open risk" value={portfolioRisk === null ? "Unavailable" : `${formatNumber(portfolioRisk)}%`} detail={`Hard limit ${portfolioLimit === null ? "Unavailable" : `${formatNumber(portfolioLimit)}%`} · stop loss ${formatAmount(lossToStops)}`} icon={<Shield size={17}/> }>
        <RiskMeter value={portfolioRisk} limit={portfolioLimit} label="Portfolio open-risk utilization"/>
      </RiskKpi>
      <RiskKpi label="Open positions" value={`${asNumber(s.openPositionCount) === null ? "Unavailable" : formatNumber(s.openPositionCount, 0)} / ${maxPositions === null ? "Unavailable" : formatNumber(maxPositions, 0)}`} detail={`${availableSlots === null ? "Slots unavailable" : `${formatNumber(availableSlots, 0)} slots available`} · confirmed exchange count · shared engines`} icon={<Layers size={17}/>}/>
      <RiskKpi label="Capital utilization" value={capital.utilization_pct === null || capital.utilization_pct === undefined ? "Unavailable" : `${formatNumber(capital.utilization_pct)}%`} detail={`Margin ${formatAmount(capital.margin_used)} · gross exposure ${formatAmount(capital.notional_usd, "USD")}`} icon={<Gauge size={17}/>}/>
    </section>

    <div className="risk-primary-grid">
      <Panel title="Safety state" subtitle="Current system restrictions and exchange observations">
        <div className="risk-state-grid">
          <StateLine icon={<Activity size={15}/>} label="Bot state" value={asText(s.botState, "UNKNOWN")} tone={s.botState === "RUNNING" ? "positive" : s.botState === "RISK_HALTED" || s.botState === "ERROR" ? "critical" : "warning"}/>
          <StateLine icon={s.emergencyHalted === true ? <ShieldAlert size={15}/> : <Shield size={15}/>} label="Emergency Stop" value={s.emergencyHalted === true ? "ACTIVE" : "Inactive"} tone={s.emergencyHalted === true ? "critical" : "neutral"}/>
          <StateLine icon={s.exchangeConnectivity === "CONNECTED" ? <Wifi size={15}/> : <WifiOff size={15}/>} label="Exchange" value={asText(s.exchangeConnectivity, "UNKNOWN")} tone={s.exchangeConnectivity === "CONNECTED" ? "positive" : "warning"}/>
          <StateLine icon={<ShieldCheck size={15}/>} label="Native protection" value={asText(s.protectionVerificationStatus, "UNKNOWN")} tone={s.protectionVerificationStatus === "VERIFIED_OR_FLAT" ? "positive" : "warning"}/>
          <StateLine icon={<ShieldAlert size={15}/>} label="Persisted halt reason" value={asText(s.persistedHaltReason, "None")}
            tone={s.persistedHaltReason ? "critical" : "neutral"}/>
          <StateLine icon={<Activity size={15}/>} label="Latest kill-switch observation" value={asText(s.latestKillSwitchObservation, "No active observation")} tone={s.latestKillSwitchObservation ? "warning" : "neutral"}/>
        </div>
      </Panel>
      <Panel title="Entry readiness" subtitle="Account-wide preliminary checks; final exchange and symbol risk checks run before every order">
        <div className="risk-readiness-heading"><StatusBadge value={assessment.readiness}/><span>Preliminary status only — it is not an order approval.</span></div>
        {assessment.blockers.length ? <ul className="risk-blockers">{assessment.blockers.map((blocker, index) => <li key={`${blocker.code}-${index}`}><AlertTriangle size={14}/><span><strong>{blocker.code.replaceAll("_", " ")}</strong>{blocker.message}</span></li>)}</ul>
          : assessment.readiness === "READY_FOR_PRECHECK" ? <div className="risk-ready-note"><CheckCircle2 size={16}/><span>Preliminary checks passed. Final exchange and risk checks apply before every order.</span></div>
            : <div className="risk-ready-note risk-ready-unknown"><AlertTriangle size={16}/><span>Readiness cannot be confirmed from the current data.</span></div>}
      </Panel>
    </div>

    <Panel title="Protection & position monitoring" subtitle="Health reflects completed monitoring work. NOT REQUIRED is neutral, not a successful position check.">
      {noMonitorRequired ? <div className="risk-no-monitor"><Shield size={17}/><strong>No active positions require monitoring.</strong></div> : null}
      <div className="risk-monitor-grid">
        <MonitorCard title="Swing · 15m" status={swingMonitor}/>
        <MonitorCard title="Scalp · 5m" status={scalpMonitor}/>
        <MonitorCard title="Exchange-native SL/TP" health={asText(s.protectionVerificationStatus, "UNKNOWN")} required={managedOpen.length > 0}
          lastAttempt={asText(asRow(managedOpen[0])?.protection_checked_at, "Unavailable")}
          lastSuccess={s.protectionVerificationStatus === "VERIFIED_OR_FLAT" ? asText(asRow(managedOpen[0])?.protection_checked_at, "Unavailable") : "Unavailable"}
          failures={monitoringErrors.length} error={monitoringErrors[0] ?? ""}/>
        <MonitorCard title="Reconciliation" health={pendingCount === null ? "UNKNOWN" : pendingCount > 0 ? "DEGRADED" : "NOT_REQUIRED"} required={pendingCount === null || pendingCount > 0}
          lastAttempt={asText(reconciliation.lastAttemptAt, "Unavailable")} lastSuccess="Unavailable"
          failures={pendingCount ?? 0} error={pendingCount && pendingCount > 0 ? `${pendingCount} trade(s) pending reconciliation` : ""}/>
      </div>
    </Panel>

      <RiskSettings equity={s.equity} positions={managedOpen} onSaved={() => status.reload(true)}/>

    <details className="risk-diagnostics">
      <summary><span><Shield size={16}/>Recovery & diagnostics</span><StatusBadge value={asText(recoveryPayload.event, recovery.kind ? "RECOVERY_RECORDED" : "NO_RECOVERY_ATTEMPT")}/></summary>
      <div className="risk-diagnostic-grid">
        <StateLine label="Last recovery attempt" value={recovery.at ? formatTimestamp(recovery.at) : "No recovery attempt"}/>
        <StateLine label="Recovery result" value={asText(recoveryPayload.event, asText(recovery.kind, "Unavailable"))}/>
        <StateLine label="Recovery reason" value={asText(recoveryPayload.reason, asText(recoveryPayload.recoveryReason, "No failure reported"))}/>
        <StateLine label="Reconciliation pending" value={pendingCount === null ? "Unavailable" : formatNumber(pendingCount, 0)}/>
        <StateLine label="Last reconciliation attempt" value={formatTimestamp(reconciliation.lastAttemptAt)}/>
        <StateLine label="Next reconciliation retry" value={formatTimestamp(reconciliation.nextRetryAt)}/>
        <StateLine label="Protection verification" value={asText(s.protectionVerificationStatus, "UNKNOWN")}/>
        <StateLine label="Kill-switch observation" value={asText(s.latestKillSwitchObservation, "No active observation")}/>
        <StateLine label="Monitoring latest partial failure" value={[swingMonitor, scalpMonitor].flatMap((item) => item?.lastPartialSweepAt ? [`${item.lastError ?? "Partial failure"} · ${formatTimestamp(item.lastPartialSweepAt)}`] : []).join("; ") || "None reported"}/>
      </div>
    </details>

    <Panel title="Risk events & audit history" subtitle="Structured risk and state events. Sensitive values are redacted before display.">
      <DataState loading={eventsApi.loading} error={eventsApi.error} empty={!riskEvents.length} hasData={eventsApi.data !== null} emptyTitle="No risk events recorded" emptyDetail="Risk events appear here when controls halt, reject, or recover system state.">
        <DataTable caption="Risk events" rows={riskEvents} rowKey={(row, index) => `${asText(row.ts)}-${asText(row.kind)}-${index}`} minWidth={740} columns={[
          { key: "ts", label: "Time", render: row => formatTimestamp(row.ts) },
          { key: "kind", label: "Severity / event", render: row => <div className="risk-event-kind"><StatusBadge value={eventSeverity(row)}/><span>{asText(row.kind)}</span></div> },
          { key: "summary", label: "Event summary", render: row => <EventSummary event={row}/> },
        ]}/>
      </DataState>
    </Panel>
  </div>;
}
function RiskKpi({ label, value, detail, icon, children }: { label: string; value: string; detail: string; icon: React.ReactNode; children?: React.ReactNode }) {
  return <article className="risk-kpi"><div className="risk-kpi-label">{icon}<span>{label}</span></div><strong className="risk-kpi-value">{value}</strong><span className="risk-kpi-detail">{detail}</span>{children}</article>;
}

function RiskMeter({ value, limit, label }: { value: number | null; limit: number | null; label: string }) {
  if (value === null || limit === null || limit <= 0) return <span className="risk-meter-unavailable">Utilization unavailable</span>;
  const utilization = value < 0 ? null : Math.min(100, value / limit * 100);
  if (utilization === null) return <span className="risk-meter-unavailable">Anomalous value · {formatPercent(value)}</span>;
  const tone = utilization >= 100 ? "critical" : utilization >= 75 ? "warning" : "positive";
  return <div className={`risk-meter risk-meter-${tone}`} role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(utilization)}>
    <span><i style={{ width: `${utilization}%` }}/></span><small>{formatNumber(utilization, 0)}% utilized</small>
  </div>;
}

function StateLine({ icon, label, value, tone = "neutral" }: { icon?: React.ReactNode; label: string; value: string; tone?: string }) {
  return <div className="risk-state-line"><span className="risk-state-label">{icon}{label}</span><strong className={`risk-state-value ${tone}`}>{value}</strong></div>;
}

function MonitorCard({ title, status, health, required, lastAttempt, lastSuccess, failures, error }: {
  title: string; status?: Row | null; health?: string; required?: boolean; lastAttempt?: string; lastSuccess?: string; failures?: number; error?: string;
}) {
  const monitorHealth = asText(status?.health, health ?? "UNKNOWN");
  const requirementKnown = status !== null && status !== undefined ? typeof status.required === "boolean" : typeof required === "boolean";
  const isRequired = status?.required === true || required === true;
  const badgeHealth = !requirementKnown ? "UNKNOWN" : isRequired ? monitorHealth : "NOT_REQUIRED";
  const attempt = status ? status.lastAttemptAt : lastAttempt;
  const complete = status ? status.lastSuccessfulSweepAt : lastSuccess;
  const count = status ? asNumber(status.consecutiveFailures) : failures ?? 0;
  const detail = asText(status?.lastError, error ?? "");
  const errorAt = status ? asText(status.lastErrorAt, asText(status.lastPartialSweepAt, "")) : "";
  return <article className={`risk-monitor-card risk-monitor-${monitorHealth.toLowerCase()}`}>
    <header><strong>{title}</strong><StatusBadge value={badgeHealth}/></header>
    <dl><div><dt>Required</dt><dd>{isRequired ? "Yes" : "No"}</dd></div><div><dt>Last attempt</dt><dd>{formatTimestamp(attempt)}</dd></div>
      <div><dt>Last complete success</dt><dd>{formatTimestamp(complete)}</dd></div><div><dt>Consecutive failures</dt><dd>{count === null ? "Unavailable" : formatNumber(count, 0)}</dd></div></dl>
    {detail ? <p className="risk-monitor-error"><AlertTriangle size={13}/><span><strong>Last reported issue:</strong> {detail}{errorAt ? ` · ${formatTimestamp(errorAt)}` : ""}</span></p> : null}
  </article>;
}

function EventSummary({ event }: { event: Row }) {
  const payload = asRow(parseJson(event.payload, {})) ?? {};
  const summary = summarizeEvent(event);
  return <details className="risk-event-detail"><summary>{summary}</summary><pre>{JSON.stringify(redactPayload(payload), null, 2)}</pre></details>;
}

export function summarizeEvent(event: Row): string {
  const payload = asRow(parseJson(event.payload, {})) ?? {};
  const priority = ["reason", "message", "role", "model", "error_class", "verdict", "strategy", "changedParameter", "oldValue", "newValue", "field", "side", "setupScore", "step", "result", "reconcile", "risk", "startupFail", "close_order_not_filled", "sl_plus_not_applied", "sl_plus_amend_failed"];
  const details = priority.flatMap(key => payload[key] === undefined ? [] : [`${key.replaceAll("_", " ")}: ${safeEventValue(payload[key])}`]);
  if (payload.tradeId) details.push(`trade: ${asText(payload.tradeId)}`);
  if (payload.instId) details.push(`instrument: ${asText(payload.instId)}`);
  return details.length ? details.join(" · ") : "Structured event recorded; expand for available details.";
}

function eventSeverity(event: Row): "CRITICAL" | "WARNING" | "INFO" {
  const kind = asText(event.kind).toUpperCase();
  const detail = asText(asRow(parseJson(event.payload, {}))?.reason).toUpperCase();
  const source = `${kind} ${detail}`;
  if (/HALT|FAILED|ERROR|UNVERIFIED|UNEXPECTED|MISMATCH|KILL_SWITCH/.test(source)) return "CRITICAL";
  if (/WARN|DEGRADED|PENDING|REJECT|RETRY|RECOVER/.test(source)) return "WARNING";
  return "INFO";
}

function redactPayload(value: unknown, key = ""): unknown {
  if (/api[_ -]?key|secret|passphrase|password|authorization|signature|token/i.test(key)) return "[REDACTED]";
  if (Array.isArray(value)) return value.map((item) => redactPayload(item, key));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([childKey, child]) => [childKey, redactPayload(child, childKey)]));
  if (typeof value === "string") return safeEventValue(value);
  return value;
}

function safeEventValue(value: unknown): string {
  return asText(value)
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "[REDACTED]")
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/-]+=*/gi, "$1[REDACTED]")
    .replace(/(api[_ -]?key|secret|passphrase|password|token|authorization)(\s*[:=]\s*)[^\s,;]+/gi, "$1$2[REDACTED]");
}
