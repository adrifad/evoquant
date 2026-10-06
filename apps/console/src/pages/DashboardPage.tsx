import { useApi } from "../hooks/useApi";
import { formatMoney, formatNumber, formatPercent, formatR, formatTimestamp, toneFor } from "../lib/format";
import { asNumber, asRow, asRows, asText, type ApiState, type Row } from "../lib/types";
import { Badge, DataState, DataTable, Field, Metric, PageHeading, Panel, StatusBadge } from "../components/Primitives";
import { DecisionPanel } from "../components/DecisionPanel";
import { MarketChart } from "../components/MarketChart";
import { PositionCard } from "../components/PositionCard";

export function DashboardPage({ status }: { status: ApiState<Row> }) {
  const candlesApi = useApi<unknown>("/api/candles?limit=96");
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
  const pnlKnown = openPositions.every(position => position.live !== false);
  const currentPnl = openPositions.length && !pnlKnown ? null : openPositions.reduce((sum, position) => sum + (asNumber(position.upl) ?? 0), 0);
  const limits = asRow(s?.limits) ?? {};

  if (!s) return <div className="page"><DataState loading={status.loading} error={status.error} empty={false}><span/></DataState></div>;

  return <div className="page dashboard-page">
    <PageHeading title="Operations overview" description="Risk, exposure, account state, and the latest decision cycle." detail={<Badge tone="info">OKX DEMO WORKSTATION</Badge>}/>
    <div className={`risk-banner ${halt ? "risk-critical" : warning ? "risk-warning" : "risk-safe"}`} role="status">
      <div className="risk-banner-copy"><span className="risk-banner-mark"/><div><strong>{halt ? "Trading risk halt" : warning ? `Bot ${asText(s.botState).toLowerCase()}` : "Risk controls active"}</strong><span>{halt ? asText(s.killReason, s.emergencyHalted ? "Emergency stop is active." : "Trading halted by system state.") : warning ? "No new automated entries are being evaluated while the bot is paused." : "No active kill-switch condition is reported by status."}</span></div></div>
      <StatusBadge value={halt ? "HALTED" : warning ? "WARNING" : "SAFE"}/>
    </div>

    <section className="metric-strip" aria-label="Account summary">
      <Metric label="Demo equity" value={`${formatMoney(s.equity)}`} detail="OKX simulated account"/>
      <Metric label="Daily loss" value={formatPercent(daily.lossPct)} tone={Number(daily.lossPct) > 0 ? "warning" : "neutral"} detail="Current day vs baseline"/>
      <Metric label="Drawdown" value={formatPercent(s.drawdownPct)} tone={Number(s.drawdownPct) > 0 ? "warning" : "neutral"} detail="From account peak"/>
      <Metric label="Open PnL" value={formatMoney(currentPnl)} tone={toneFor(currentPnl)} detail={`${openPositions.length} open positions${pnlKnown ? "" : " | live mark unavailable"}`}/>
      <Metric label="Expectancy" value={formatR(totals.expectancyR)} tone={toneFor(totals.expectancyR)} detail={`${asText(totals.closed, "0")} closed trades`}/>
      <Metric label="Total realized PnL" value={formatMoney(totals.pnl)} tone={toneFor(totals.pnl)} detail="Closed trades"/>
    </section>

    <div className="dashboard-primary">
      <Panel title="Market path" subtitle={`${asText(s.instrument)} | ${asText(s.timeframe)} | confirmed candles`} className="chart-panel">
        <DataState loading={candlesApi.loading} error={candlesApi.error} empty={asRows(candlesApi.data).length < 2} hasData={candlesApi.data !== null} emptyTitle="Waiting for confirmed candle data" emptyDetail="Stored candles appear here after the market feed confirms them.">
          <MarketChart candles={asRows(candlesApi.data)} markers={asRow(s.openPosition) ?? open}/>
        </DataState>
      </Panel>
      <PositionCard status={s}/>
    </div>

    <div className="dashboard-secondary">
      <DecisionPanel decision={decision}/>
      <Panel title="Risk limits" subtitle="Hard limits are locked outside AI control" className="limits-panel">
        <div className="limit-list">
          <Field label="Risk per trade" value={`${formatNumber(limits.risk_per_trade_pct)}%`}/>
          <Field label="Maximum daily loss" value={`${formatNumber(limits.max_daily_loss_pct)}%`}/>
          <Field label="Maximum drawdown" value={`${formatNumber(limits.max_drawdown_pct)}%`}/>
          <Field label="Maximum leverage" value={`${formatNumber(limits.max_leverage, 0)}x`}/>
          <Field label="Maximum positions" value={formatNumber(limits.max_concurrent_positions, 0)}/>
          <Field label="Active strategy" value={asText(decision?.strategy, asText(open.strategy))} mono={false}/>
          <Field label="Market regime" value={asText(s.regime, "UNKNOWN")} mono={false}/>
        </div>
        <div className="locked-note"><span aria-hidden="true">LOCKED</span><span>Risk limits cannot be changed from this console.</span></div>
      </Panel>
    </div>

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
