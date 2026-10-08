import { useApi } from "../hooks/useApi";
import { formatMoney, formatNumber, formatPercent, formatR, formatTimestamp, toneFor } from "../lib/format";
import { asNumber, asRow, asRows, asText, parseJson, type ApiState, type Row } from "../lib/types";
import { Badge, DataState, DataTable, Field, Metric, PageHeading, Panel, StatusBadge } from "../components/Primitives";
import { DecisionPanel } from "../components/DecisionPanel";
import { PositionCard } from "../components/PositionCard";
import { CapitalSummary } from "../components/CapitalSummary";
import { InstrumentChart } from "../components/InstrumentChart";

export function DashboardPage({ status }: { status: ApiState<Row> }) {
  const tradesApi = useApi<unknown>("/api/trades");
  const s = status.data;
  const daily = asRow(s?.daily) ?? {};
  const totals = asRow(s?.totals) ?? {};
  const decision = asRow(s?.latestDecision);
  const halt = Boolean(s?.emergencyHalted || s?.killReason || s?.botState === "RISK_HALTED" || s?.botState === "ERROR");
  const warning = !halt && (s?.botState === "PAUSED" || s?.botState === "STOPPED");
  const open = asRows(s?.openPositions)[0] ?? {};
  const recentTrades = asRows(tradesApi.data).slice(0, 6);
  const openPositions = asRows(s?.openPositions);
  const pnlKnown = s?.exchangeState === "CURRENT" && openPositions.every(position => position.live !== false && asNumber(position.upl) !== null);
  const currentPnl = pnlKnown ? openPositions.reduce((sum, position) => sum + asNumber(position.upl)!, 0) : null;
  const limits = asRow(s?.limits) ?? {};
  const execution = asRow(s?.latestExecution);
  const executionPayload = asRow(parseJson(execution?.payload, {})) ?? {};
  const executionDetail = [executionPayload.instId ?? executionPayload.instrument, executionPayload.side, executionPayload.reason, executionPayload.tradeId].filter(value => value !== null && value !== undefined && value !== "").map(String).join(" | ");
  const roles = asRows(s?.aiRoles);
  const roleWarnings = roles.filter(role => role.status !== "AVAILABLE");

  if (!s) return <div className="page"><DataState loading={status.loading} error={status.error} empty={false}><span/></DataState></div>;

  return <div className="page dashboard-page">
    <PageHeading title="Operations overview" description="Risk, exposure, account state, and the latest decision cycle." detail={<Badge tone="info">OKX DEMO WORKSTATION</Badge>}/>
    {s.exchangeState !== "CURRENT" ? <div className="inline-warning" role="status">Exchange account data unavailable. Capital and live position values cannot currently be confirmed.</div> : null}
    <CapitalSummary status={s}/>
    <div className={`risk-banner ${halt ? "risk-critical" : warning ? "risk-warning" : "risk-safe"}`} role="status">
      <div className="risk-banner-copy"><span className="risk-banner-mark"/><div><strong>{halt ? "Trading risk halt" : warning ? `Bot ${asText(s.botState).toLowerCase()}` : "Risk controls active"}</strong><span>{halt ? asText(s.killReason, s.emergencyHalted ? "Emergency stop is active." : "Trading halted by system state.") : warning ? "No new automated entries are being evaluated while the bot is paused." : "No active kill-switch condition is reported by status."}</span></div></div>
      <StatusBadge value={halt ? "HALTED" : warning ? "WARNING" : "SAFE"}/>
    </div>

    <section className="activity-strip" aria-label="Latest operational activity">
      <div className="activity-cell"><span className="metric-label">Strategy activity</span><div className="activity-value"><strong>{asText(decision?.strategy, "No decision recorded")}</strong>{decision ? <StatusBadge value={decision.decision}/> : null}</div><span className="activity-detail">{formatTimestamp(decision?.ts)}{decision?.instrument ? ` | ${asText(decision.instrument)}` : ""}</span></div>
      <div className="activity-cell"><span className="metric-label">Latest execution event</span><div className="activity-value"><strong>{asText(execution?.kind, "No execution recorded")}</strong><span>{execution ? formatTimestamp(execution.ts) : "Unavailable"}</span></div>{executionDetail ? <span className="activity-detail">{executionDetail}</span> : null}</div>
      <div className="activity-cell"><span className="metric-label">AI role status</span><div className="activity-value"><strong>{roles.length ? `${roles.length - roleWarnings.length} / ${roles.length} available` : "Unavailable"}</strong></div>{roleWarnings.length ? <div className="activity-role-list">{roleWarnings.map(role => <span key={asText(role.role)}>{asText(role.role)} <StatusBadge value={role.status}/></span>)}</div> : <span className="activity-detail">{roles.length ? "All configured roles report available" : "No role status supplied"}</span>}</div>
    </section>

    <section className="metric-strip" aria-label="Account summary">
      <Metric label="Positions" value={`${openPositions.length} / ${asText(limits.max_concurrent_positions)}`} detail="Shared swing / scalp slots"/>
      <Metric label="Daily loss" value={formatPercent(daily.lossPct)} tone={Number(daily.lossPct) > 0 ? "warning" : "neutral"} detail="Current day vs baseline"/>
      <Metric label="Drawdown" value={formatPercent(s.drawdownPct)} tone={Number(s.drawdownPct) > 0 ? "warning" : "neutral"} detail="From account peak"/>
      <Metric label="Open PnL" value={formatMoney(currentPnl)} tone={toneFor(currentPnl)} detail={`${openPositions.length} open positions${pnlKnown ? "" : " | live PnL unavailable"}`}/>
      <Metric label="Evolution" value={asRow(s.evolution)?.enabled === true ? "ACTIVE" : asRow(s.evolution)?.enabled === false ? "DISABLED" : "UNKNOWN"} detail={`${asRows(asRow(s.evolution)?.active).length} active challengers`}/>
      <Metric label="Total realized PnL" value={formatMoney(totals.pnl)} tone={toneFor(totals.pnl)} detail="Closed trades"/>
    </section>

    <div className="dashboard-primary">
      <Panel title="Market path" subtitle={`${asText(open.instrument, asText(s.instrument))} | ${asText(open.timeframe, asText(s.timeframe))} | confirmed candles`} className="chart-panel">
        <InstrumentChart key={asText(open.instrument, asText(s.instrument))} instrument={asText(open.instrument, asText(s.instrument))} markers={open} initialTimeframe={open.timeframe === "scalp" ? "1m" : asText(open.timeframe, asText(s.timeframe))}/>
      </Panel>
      <PositionCard status={s}/>
    </div>

    <div className="dashboard-secondary">
      <DecisionPanel decision={decision}/>
      <Panel title="Operational limits" subtitle="New entries use the values saved on the Risk page" className="limits-panel">
        <div className="limit-list">
          <Field label="Risk per trade" value={`${formatNumber(limits.risk_per_trade_pct)}%`}/>
          <Field label="Maximum daily loss" value={`${formatNumber(limits.max_daily_loss_pct)}%`}/>
          <Field label="Maximum drawdown" value={`${formatNumber(limits.max_drawdown_pct)}%`}/>
          <Field label="Maximum leverage" value={`${formatNumber(limits.max_leverage, 0)}x`}/>
          <Field label="Maximum positions" value={formatNumber(limits.max_concurrent_positions, 0)}/>
          <Field label="Active strategy" value={asText(decision?.strategy, asText(open.strategy))} mono={false}/>
          <Field label="Market regime" value={asText(s.regime, "UNKNOWN")} mono={false}/>
        </div>
        <div className="locked-note"><span>BOUNDED</span><span>Absolute safety ceilings remain read-only.</span></div>
      </Panel>
    </div>

    <Panel title="Current decision path" subtitle="Setup and side come from Strategy Core; Gate and risk are separate stages">
      <DataTable rows={asRows(s.scan)} rowKey={r => String(r.instrument)} minWidth={850} columns={[
        { key: "symbol", label: "Instrument", render: r => asText(r.instrument) },
        { key: "strategy", label: "Strategy", render: r => asText(r.strategy, "No candidate") },
        { key: "side", label: "Candidate side", render: r => asText(asRow(r.candidate)?.side, "None") },
        { key: "gate", label: "Gate", render: r => <StatusBadge value={r.gate}/> },
        { key: "risk", label: "Risk", render: r => <StatusBadge value={r.risk}/> },
        { key: "state", label: "State", render: r => <StatusBadge value={r.state}/> },
      ]}/>
      {!asRows(s.scan).length ? <div className="empty-state"><strong>Waiting for the first scanner cycle</strong></div> : null}
    </Panel>
    {asRows(s.criticalEvents).length ? <Panel title="Recent operational errors" subtitle="Latest risk and provider failures; inspect Logs for event history"><div className="trace-list">{asRows(s.criticalEvents).map((event, i) => <div className="trace-step" key={i}><StatusBadge value={event.kind}/><span>{formatTimestamp(event.ts)}</span></div>)}</div></Panel> : null}

    <Panel title="Recent trades" subtitle="Latest persisted positions and outcomes" action={<Badge tone="info">{asText(totals.closed, "0")} closed</Badge>}>
      <DataState loading={tradesApi.loading} error={tradesApi.error} empty={!recentTrades.length} hasData={tradesApi.data !== null} emptyTitle="No trades recorded yet" emptyDetail="Completed and open trades will appear here.">
        <DataTable caption="Recent trades" rows={recentTrades} rowKey={(row, index) => asText(row.trade_id, String(index))} minWidth={760} columns={[
          { key: "time", label: "Time", render: row => formatTimestamp(row.exit_ts ?? row.entry_ts) },
          { key: "symbol", label: "Symbol", render: row => asText(row.instrument) },
          { key: "side", label: "Side", render: row => <Badge tone={String(row.side).toLowerCase()}>{asText(row.side)}</Badge> },
          { key: "strategy", label: "Strategy", render: row => `${asText(row.strategy)} V${asText(row.strategy_version)}` },
          { key: "r", label: "R", numeric: true, render: row => <span className={toneFor(row.result_r ?? row.live_r)}>{row.status === "OPEN" ? formatR(row.live_r) : formatR(row.result_r)}</span> },
          { key: "pnl", label: "PnL", numeric: true, render: row => <span className={toneFor(row.pnl ?? row.upl)}>{formatMoney(row.pnl ?? row.upl)}</span> },
          { key: "result", label: "Result", render: row => <StatusBadge value={tradeOutcome(row)}/> },
        ]}/>
      </DataState>
    </Panel>
  </div>;
}

function tradeOutcome(row: Row): string {
  if (row.status === "OPEN") return "OPEN";
  const pnl = asNumber(row.pnl);
  return pnl === null ? "UNKNOWN" : pnl > 0 ? "WIN" : pnl < 0 ? "LOSS" : "FLAT";
}
