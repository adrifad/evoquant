import { useApi } from "../hooks/useApi";
import { formatNumber, formatPercent, formatTimestamp } from "../lib/format";
import { asNumber, asRow, asRows, asText, parseJson, type ApiState, type Row } from "../lib/types";
import { Badge, DataState, DataTable, Field, Metric, PageHeading, Panel, StatusBadge } from "../components/Primitives";

export function RiskPage({ status }: { status: ApiState<Row> }) {
  const eventsApi = useApi<unknown>("/api/events");
  const s = status.data;
  if (!s) return <div className="page"><PageHeading title="Risk" description="Deterministic controls and risk events remain separate from AI decisions."/><DataState loading={status.loading} error={status.error} empty={false}><span/></DataState></div>;
  const limits = asRow(s.limits) ?? {};
  const daily = asRow(s.daily) ?? {};
  const open = asRows(s.openPositions);
  const dailyPct = asNumber(daily.lossPct);
  const drawdown = asNumber(s.drawdownPct);
  const dailyLimit = asNumber(limits.max_daily_loss_pct);
  const drawdownLimit = asNumber(limits.max_drawdown_pct);
  const nearLimit = (dailyLimit !== null && dailyPct !== null && dailyLimit > 0 && dailyPct >= dailyLimit * 0.75) || (drawdownLimit !== null && drawdown !== null && drawdownLimit > 0 && drawdown >= drawdownLimit * 0.75);
  const halted = Boolean(s.emergencyHalted || s.killReason || s.botState === "RISK_HALTED" || s.botState === "ERROR");
  const riskState = halted ? "HALTED" : dailyPct === null || drawdown === null ? "UNKNOWN" : nearLimit ? "WARNING" : "SAFE";
  const riskEvents = asRows(eventsApi.data).filter(event => String(event.kind).includes("RISK") || event.kind === "STATE");

  return <div className="page">
    <PageHeading title="Risk" description="Deterministic controls and risk events remain separate from AI decisions." detail={<StatusBadge value={riskState}/>}/>
    <section className="metric-strip risk-metric-strip" aria-label="Current risk status">
      <Metric label="Current drawdown" value={formatPercent(drawdown)} tone={drawdown !== null && drawdown > 0 ? "warning" : "neutral"} detail={drawdownLimit ? `${formatNumber(drawdownLimit)}% hard limit` : "Limit unavailable"}/>
      <Metric label="Daily loss" value={formatPercent(dailyPct)} tone={dailyPct !== null && dailyPct > 0 ? "warning" : "neutral"} detail={dailyLimit ? `${formatNumber(dailyLimit)}% hard limit` : "Limit unavailable"}/>
      <Metric label="Open positions" value={open.length} detail="Position count, notional not supplied by API"/>
      <Metric label="Demo equity" value={formatNumber(s.equity)} detail="Available-equity split not supplied"/>
      <Metric label="Bot risk state" value={<StatusBadge value={riskState}/>} detail={`Bot state: ${asText(s.botState, "UNKNOWN")}`}/>
    </section>

    <Panel title="Hard limits" subtitle="Read-only controls owned by deterministic risk configuration">
      <div className="risk-limit-grid">
        <Field label="Risk per trade" value={`${formatNumber(limits.risk_per_trade_pct)}%`}/>
        <Field label="Maximum daily loss" value={`${formatNumber(limits.max_daily_loss_pct)}%`}/>
        <Field label="Maximum drawdown" value={`${formatNumber(limits.max_drawdown_pct)}%`}/>
        <Field label="Maximum leverage" value={`${formatNumber(limits.max_leverage, 0)}x`}/>
        <Field label="Maximum positions" value={formatNumber(limits.max_concurrent_positions, 0)}/>
        <Field label="Available equity" value="Not supplied separately by the API" mono={false}/>
        <Field label="Current quote exposure" value="Not supplied by the API" mono={false}/>
      </div>
      <div className="locked-note"><span>HARD LIMITS</span><span>Locked. AI and UI settings cannot edit these values.</span></div>
    </Panel>

    <Panel title="Risk event timeline" subtitle="Risk and state events shown separately from general logs">
      <DataState loading={eventsApi.loading} error={eventsApi.error} empty={!riskEvents.length} hasData={eventsApi.data !== null} emptyTitle="No risk events recorded" emptyDetail="Risk events appear here when controls halt, reject, or recover system state.">
        <DataTable caption="Risk events" rows={riskEvents} rowKey={(row, index) => `${asText(row.ts)}-${asText(row.kind)}-${index}`} minWidth={740} columns={[
          { key: "ts", label: "Time", render: row => formatTimestamp(row.ts) },
          { key: "kind", label: "Event", render: row => <StatusBadge value={row.kind}/> },
          { key: "summary", label: "Recorded detail", render: row => summarizeEvent(row) },
        ]}/>
      </DataState>
    </Panel>
  </div>;
}

export function summarizeEvent(event: Row): string {
  const payload = asRow(parseJson(event.payload, {})) ?? {};
  const priority = ["reason", "message", "step", "result", "reconcile", "risk", "startupFail", "close_order_not_filled", "sl_plus_not_applied", "sl_plus_amend_failed"];
  const details = priority.flatMap(key => payload[key] === undefined ? [] : [`${key.replaceAll("_", " ")}: ${safeEventValue(payload[key])}`]);
  if (payload.tradeId) details.push(`trade: ${asText(payload.tradeId)}`);
  if (payload.instId) details.push(`instrument: ${asText(payload.instId)}`);
  return details.length ? details.join(" | ") : "Structured event recorded; payload fields are not expanded in the UI.";
}

function safeEventValue(value: unknown): string {
  return asText(value)
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, "[REDACTED]")
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/-]+=*/gi, "$1[REDACTED]")
    .replace(/(api[_ -]?key|secret|passphrase|password|token|authorization)(\s*[:=]\s*)[^\s,;]+/gi, "$1$2[REDACTED]");
}
