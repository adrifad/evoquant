import { useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Copy, X } from "lucide-react";
import { useApi } from "../hooks/useApi";
import { formatAmount, formatDuration, formatLeverage, formatMoney, formatNumber, formatPercent, formatPrice, formatR, formatTimestamp, toneFor } from "../lib/format";
import { asNumber, asRow, asRows, asText, parseJson, type Row } from "../lib/types";
import { Badge, DataState, DataTable, Field, Metric, PageHeading, Panel, StatusBadge } from "../components/Primitives";
import { MarketChart } from "../components/MarketChart";
import { InstrumentChart } from "../components/InstrumentChart";
import { filterTrades, isTrustedNetTrade, paginateTrades, sortTrades, TRADE_ANALYTICS_DIMENSIONS, TRADE_PAGE_SIZE, tradeOutcome, type TradeSort } from "./trades-view-model";

export function TradesPage() {
  const api = useApi<unknown>("/api/trades");
  const [lossWindow, setLossWindow] = useState("30d");
  const lossApi = useApi<unknown>(`/api/loss-attribution?window=${lossWindow}`);
  const [search, setSearch] = useState("");
  const [engine, setEngine] = useState<"ALL" | "SWING_15M" | "SCALP_5M">("ALL");
  const [side, setSide] = useState<"ALL" | "LONG" | "SHORT">("ALL");
  const [status, setStatus] = useState<"ALL" | "OPEN" | "CLOSED" | "RECONCILIATION_PENDING">("ALL");
  const [outcome, setOutcome] = useState<"ALL" | "WIN" | "LOSS" | "FLAT" | "UNVERIFIED">("ALL");
  const [sort, setSort] = useState<TradeSort>("newest");
  const [page, setPage] = useState(0);
  const [view, setView] = useState<"overview" | "history" | "analytics">("overview");
  const [dimension, setDimension] = useState("strategy");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const trades = asRows(api.data);
  const report = asRow(lossApi.data);
  const metrics = asRow(report?.overall);
  const accounting = asRow(report?.accounting);
  const by = asRow(report?.by);
  const filtered = sortTrades(filterTrades(trades, { search, engine, side, status, outcome }), sort);
  const pageRows = paginateTrades(filtered, page);
  const lastPage = Math.max(0, Math.ceil(filtered.length / TRADE_PAGE_SIZE) - 1);

  const changeFilter = <T,>(setter: (value: T) => void, value: T) => { setter(value); setPage(0); };

  return <div className="page trades-page">
    <PageHeading title="Trades" description="A trading journal for verified outcomes, open exposure, and execution evidence." detail={<Badge tone="info">Latest {trades.length} of 100 records</Badge>}/>
    <nav className="trades-tabs" aria-label="Trades workspace views">
      {[ ["overview", "Overview"], ["history", "Trade history"], ["analytics", "Analytics"] ].map(([key, label]) => <button key={key} type="button" aria-pressed={view === key} onClick={() => setView(key as typeof view)}>{label}</button>)}
      <label className="filter-control trades-window"><span>Reporting window</span><select aria-label="Loss attribution window" value={lossWindow} onChange={event => setLossWindow(event.target.value)}><option value="24h">24 hours</option><option value="7d">7 days</option><option value="30d">30 days</option><option value="all">All history</option></select></label>
    </nav>
    {view === "overview" ? <TradesOverview metrics={metrics} accounting={accounting} loading={lossApi.loading} error={lossApi.error} hasData={lossApi.data !== null} updatedAt={lossApi.updatedAt}/> : null}
    {view === "history" ? <Panel title="Trade history" subtitle={`Showing ${filtered.length ? page * TRADE_PAGE_SIZE + 1 : 0}–${Math.min((page + 1) * TRADE_PAGE_SIZE, filtered.length)} of ${filtered.length} matching loaded records`} className="trades-panel">
      <div className="trades-filters">
        <label className="filter-control filter-search"><span>Search symbol, trade ID, or strategy</span><input value={search} onChange={event => changeFilter(setSearch, event.target.value)} placeholder="e.g. BTC, SCP-123, BREAKOUT"/></label>
        <label className="filter-control"><span>Engine</span><select value={engine} onChange={event => changeFilter(setEngine, event.target.value as typeof engine)}><option value="ALL">All engines</option><option value="SWING_15M">Swing</option><option value="SCALP_5M">Scalp</option></select></label>
        <label className="filter-control"><span>Side</span><select value={side} onChange={event => changeFilter(setSide, event.target.value as typeof side)}><option value="ALL">All sides</option><option value="LONG">Long</option><option value="SHORT">Short</option></select></label>
        <label className="filter-control"><span>Status</span><select value={status} onChange={event => changeFilter(setStatus, event.target.value as typeof status)}><option value="ALL">All statuses</option><option value="OPEN">Open</option><option value="CLOSED">Closed</option><option value="RECONCILIATION_PENDING">Reconciliation pending</option></select></label>
        <label className="filter-control"><span>Outcome</span><select value={outcome} onChange={event => changeFilter(setOutcome, event.target.value as typeof outcome)}><option value="ALL">All outcomes</option><option value="WIN">Win</option><option value="LOSS">Loss</option><option value="FLAT">Flat</option><option value="UNVERIFIED">Unverified</option></select></label>
        <label className="filter-control trades-sort"><span>Sort by</span><select value={sort} onChange={event => { setSort(event.target.value as TradeSort); setPage(0); }}><option value="newest">Newest first</option><option value="oldest">Oldest first</option><option value="pnl-desc">Net PnL · high to low</option><option value="pnl-asc">Net PnL · low to high</option><option value="r-desc">R · high to low</option><option value="r-asc">R · low to high</option></select></label>
      </div>
      <DataState loading={api.loading} error={api.error} empty={!filtered.length} hasData={api.data !== null} emptyTitle={trades.length ? "No trades match these filters" : "No trades recorded yet"} emptyDetail={trades.length ? "Change or clear one or more filters to see other records." : "Trades appear here after an entry is recorded."}>
        <TradeHistoryTable rows={pageRows} onSelect={row => setSelectedId(asText(row.trade_id, ""))}/>
        <div className="trades-pagination"><span>The API is capped at its latest 100 records; pages cover this loaded set.</span><div><button type="button" aria-label="Previous page" disabled={page <= 0} onClick={() => setPage(value => Math.max(0, value - 1))}><ChevronLeft size={16}/></button><span>Page {page + 1} of {lastPage + 1}</span><button type="button" aria-label="Next page" disabled={page >= lastPage} onClick={() => setPage(value => Math.min(lastPage, value + 1))}><ChevronRight size={16}/></button></div></div>
      </DataState>
    </Panel> : null}
    {view === "analytics" ? <TradesAnalytics by={by} metrics={metrics} accounting={accounting} dimension={dimension} onDimension={setDimension} loading={lossApi.loading} error={lossApi.error} hasData={lossApi.data !== null}/> : null}
    {selectedId ? <TradeDetailDialog tradeId={selectedId} onClose={() => setSelectedId(null)}/> : null}
  </div>;
}

function TradesOverview({ metrics, accounting, loading, error, hasData, updatedAt }: { metrics: Row | null; accounting: Row | null; loading: boolean; error: string | null; hasData: boolean; updatedAt: number | null }) {
  const count = asNumber(metrics?.tradeCount) ?? 0;
  const rows = metrics ? <div className="trades-kpis">
    <Metric label="Verified NET PnL" value={formatMoney(metrics.totalNetPnlUsdt)} tone={toneFor(metrics.totalNetPnlUsdt)} detail="Realized closed trades only"/>
    <Metric label="Win rate" value={metrics.winRate == null ? "Unavailable" : formatPercent(Number(metrics.winRate) * 100, 1)} detail={`${formatNumber(metrics.wins, 0)} wins · ${formatNumber(metrics.losses, 0)} losses`}/>
    <Metric label="Net expectancy" value={metrics.expectancyR == null ? "Unavailable" : `${formatNumber(metrics.expectancyR, 3)} R`} detail="Average realized NET R per qualifying trade"/>
    <Metric label="Profit factor" value={metrics.profitFactor == null ? "Unavailable" : formatNumber(metrics.profitFactor, 2)} detail="Positive NET PnL / absolute negative NET PnL"/>
    <Metric label="Qualifying trades" value={formatNumber(metrics.tradeCount, 0)} detail={`${formatNumber(accounting?.validButCorrupt, 0)} valid rows lack complete metric fields`}/>
    <Metric label="Average win / loss" value={`${formatMoney(metrics.averageWinUsdt)} / ${formatMoney(metrics.averageLossUsdt)}`} detail="NET USDT per winning / losing trade"/>
    <Metric label="Average winning / losing R" value={`${formatR(metrics.averageWinR)} / ${formatR(metrics.averageLossR)}`} detail="Mean NET R within winning / losing trades"/>
  </div> : null;
  return <Panel title="Performance overview" subtitle="Only complete, validated NET evidence contributes to these realized metrics." className="trades-panel" action={<span className="trades-refresh">{updatedAt ? `Updated ${formatTimestamp(updatedAt)}` : "Waiting for report"}</span>}>
    <DataState loading={loading} error={error} empty={!metrics || count === 0} hasData={hasData} emptyTitle="No qualifying NET trades in this window" emptyDetail="Open, pending, incomplete, invalid, and corrupt records remain visible in Trade History but are excluded from trusted performance." >{rows ?? <span/>}</DataState>
    {metrics ? <p className="trades-footnote">Gross PnL: {formatMoney(metrics.totalGrossPnlUsdt)} · Fees: {formatMoney(metrics.totalTradingFeesUsdt)} · Signed funding: {formatMoney(metrics.totalFundingUsdt)}. Closed-trade sequence drawdown: {formatMoney(metrics.maxTradeSequenceDrawdownUsdt)}; this is not account-equity drawdown. Excluded by evidence state: {formatNumber(accounting?.excludedByState, 0)}.</p> : null}
  </Panel>;
}

function TradeHistoryTable({ rows, onSelect }: { rows: Row[]; onSelect: (row: Row) => void }) {
  const select = (row: Row) => onSelect(row);
  return <>
    <div className="trades-table-scroll">
      <table className="trades-table">
        <caption className="sr-only">Trade history for the loaded API records</caption>
        <thead><tr><th scope="col">Instrument</th><th scope="col">Side</th><th scope="col">Entry time</th><th scope="col" className="numeric">Entry</th><th scope="col" className="numeric">Exit / Mark</th><th scope="col" className="numeric">Net / Unrealized PnL</th><th scope="col" className="numeric">R</th><th scope="col">Status</th></tr></thead>
        <tbody>{rows.map(row => {
          const pnl = row.status === "OPEN" ? asNumber(row.upl) : isTrustedNetTrade(row) ? asNumber(row.pnl) : null;
          const r = row.status === "OPEN" ? asNumber(row.live_r ?? row.r) : isTrustedNetTrade(row) ? asNumber(row.result_r) : null;
          const outcome = tradeOutcome(row);
          return <tr key={asText(row.trade_id)}>
            <td><strong className="trades-instrument">{asText(row.instrument)}</strong><small>{asText(row.strategy)} V{asText(row.strategy_version)} · {engineLabel(row.engine)}</small></td>
            <td><StatusBadge value={row.side}/></td>
            <td><time dateTime={asText(row.entry_ts, "")}>{formatTimestamp(row.entry_ts)}</time></td>
            <td className="numeric mono">{formatPrice(row.entry_px)}</td>
            <td className="numeric mono">{formatPrice(row.status === "OPEN" ? row.mark_px : row.exit_px)}</td>
            <td className="numeric"><span className={`mono ${toneFor(pnl)}`}>{formatMoney(pnl)}</span><small className="trades-cell-note">{row.status === "OPEN" ? "Unrealized" : isTrustedNetTrade(row) ? "Verified NET" : `NET unavailable · ${asText(row.evidence_state, "UNKNOWN")}`}</small></td>
            <td className="numeric"><span className={`mono ${toneFor(r)}`}>{formatR(r)}</span><small className="trades-cell-note">{row.status === "OPEN" ? "Live" : isTrustedNetTrade(row) ? "Realized NET" : "Unavailable"}</small></td>
            <td><div className="trades-status"><StatusBadge value={row.status === "RECONCILIATION_PENDING" ? "PENDING" : row.status}/><small className="trades-cell-note">{row.status === "CLOSED" ? outcome : row.status === "RECONCILIATION_PENDING" ? asText(row.evidence_state, "Accounting pending") : "Position live"}</small><button type="button" className="trades-detail-action" onClick={() => select(row)}>View details</button></div></td>
          </tr>;
        })}</tbody>
      </table>
    </div>
    <div className="trades-mobile-list">{rows.map(row => {
      const pnl = row.status === "OPEN" ? asNumber(row.upl) : isTrustedNetTrade(row) ? asNumber(row.pnl) : null;
      const r = row.status === "OPEN" ? asNumber(row.live_r ?? row.r) : isTrustedNetTrade(row) ? asNumber(row.result_r) : null;
      return <article className="trades-mobile-card" key={asText(row.trade_id)}>
        <div className="trades-mobile-head"><div><strong>{asText(row.instrument)}</strong><small>{asText(row.strategy)} V{asText(row.strategy_version)} · {engineLabel(row.engine)}</small></div><StatusBadge value={row.side}/></div>
        <div className="trades-mobile-values"><span><small>{row.status === "OPEN" ? "Unrealized PnL" : "NET PnL"}</small><strong className={toneFor(pnl)}>{formatMoney(pnl)}</strong></span><span><small>{row.status === "OPEN" ? "Live R" : "R"}</small><strong className={toneFor(r)}>{formatR(r)}</strong></span><span><small>Status</small><StatusBadge value={row.status === "RECONCILIATION_PENDING" ? "PENDING" : row.status}/><small>{row.status === "CLOSED" ? tradeOutcome(row) : ""}</small></span></div>
        <div className="trades-mobile-foot"><time dateTime={asText(row.entry_ts, "")}>{formatTimestamp(row.entry_ts)}</time><button type="button" className="trades-detail-action" onClick={() => select(row)}>View details</button></div>
      </article>;
    })}</div>
  </>;
}

function TradesAnalytics({ by, metrics, accounting, dimension, onDimension, loading, error, hasData }: { by: Row | null; metrics: Row | null; accounting: Row | null; dimension: string; onDimension: (value: string) => void; loading: boolean; error: string | null; hasData: boolean }) {
  const selected = TRADE_ANALYTICS_DIMENSIONS.find(item => item.key === dimension) ?? TRADE_ANALYTICS_DIMENSIONS[0];
  const rows = asRows(by?.[selected.key]);
  return <div className="trades-analytics">
    <div className="trades-kpis trades-kpis-compact">
      <Metric label="Verified NET PnL" value={formatMoney(metrics?.totalNetPnlUsdt)} tone={toneFor(metrics?.totalNetPnlUsdt)} detail="Realized closed trades only"/>
      <Metric label="Win rate" value={metrics?.winRate == null ? "Unavailable" : formatPercent(Number(metrics.winRate) * 100, 1)} detail={`${formatNumber(metrics?.wins, 0)} wins · ${formatNumber(metrics?.losses, 0)} losses`}/>
      <Metric label="Net expectancy" value={metrics?.expectancyR == null ? "Unavailable" : `${formatNumber(metrics.expectancyR, 3)} R`} detail="Per qualifying trade"/>
      <Metric label="Profit factor" value={metrics?.profitFactor == null ? "Unavailable" : formatNumber(metrics.profitFactor, 2)} detail="Verified NET trades only"/>
      <Metric label="Evidence quality" value={`${formatNumber(asNumber(accounting?.completeValidNetTrades) ?? 0, 0)} qualifying`} detail={`${formatNumber(accounting?.closedTrades, 0)} closed records in window`}/>
      <Metric label="Average win / loss" value={`${formatMoney(metrics?.averageWinUsdt)} / ${formatMoney(metrics?.averageLossUsdt)}`} detail="NET USDT per trade"/>
    </div>
    <Panel title="Loss attribution" subtitle="Descriptive grouped results from complete valid NET trades. These groupings show associations, not causal explanations." className="trades-panel" action={<span className="trades-window-label">{selected.label}</span>}>
      <div className="trades-dimension-list" role="group" aria-label="Loss attribution dimension">{TRADE_ANALYTICS_DIMENSIONS.map(item => <button type="button" key={item.key} aria-pressed={dimension === item.key} onClick={() => onDimension(item.key)}>{item.label}</button>)}</div>
      <DataState loading={loading} error={error} empty={!rows.length} hasData={hasData} emptyTitle={`No qualifying data for ${selected.label.toLowerCase()}`} emptyDetail="This analysis only includes complete, valid NET trade evidence in the selected reporting window.">
        <div className="trades-analytics-summary"><strong>{selected.label}</strong><span>{formatNumber(accounting?.completeValidNetTrades, 0)} qualifying trades in window</span></div>
        <DataTable caption={`Verified NET results by ${selected.label}`} rows={rows} rowKey={(row, index) => `${asText(row.key)}-${index}`} minWidth={690} columns={analyticsColumns(dimension)}/>
      </DataState>
      <p className="trades-footnote">Excluded by evidence state: {formatNumber(accounting?.excludedByState, 0)}. Corrupt valid rows with incomplete metric fields: {formatNumber(accounting?.validButCorrupt, 0)}. Gate outcome is descriptive, not proof of causality.</p>
    </Panel>
  </div>;
}

function analyticsColumns(dimension: string) {
  const keyLabel = TRADE_ANALYTICS_DIMENSIONS.find(item => item.key === dimension)?.label ?? "Group";
  const base = [
    { key: "key", label: keyLabel, render: (row: Row) => asText(row.key) },
    { key: "count", label: "Trades", numeric: true, render: (row: Row) => formatNumber(asRow(row.metrics)?.tradeCount, 0) },
    { key: "winRate", label: "Win rate", numeric: true, render: (row: Row) => { const value = asNumber(asRow(row.metrics)?.winRate); return value === null ? "Unavailable" : formatPercent(value * 100, 1); } },
    { key: "net", label: "Net PnL", numeric: true, render: (row: Row) => formatMoney(asRow(row.metrics)?.totalNetPnlUsdt) },
  ];
  if (dimension === "exitReason") return [base[0]!, base[1]!, base[3]!, { key: "averageR", label: "Average R", numeric: true, render: (row: Row) => formatR(asRow(row.metrics)?.expectancyR) }];
  return [...base, { key: "expectancy", label: "Expectancy R", numeric: true, render: (row: Row) => formatR(asRow(row.metrics)?.expectancyR) }, { key: "profitFactor", label: "Profit factor", numeric: true, render: (row: Row) => formatNumber(asRow(row.metrics)?.profitFactor) }];
}

function engineLabel(value: unknown): string {
  const engine = asText(value, "");
  return engine === "SWING_15M" ? "Swing" : engine === "SCALP_5M" ? "Scalp" : "Engine unavailable";
}

export function TradeDetailDialog({ tradeId, onClose }: { tradeId: string; onClose: () => void }) {
  const api = useApi<unknown>(`/api/trades/${encodeURIComponent(tradeId)}`, 15_000);
  const dialog = useRef<HTMLDialogElement>(null);
  const [section, setSection] = useState<"summary" | "chart" | "decision" | "execution" | "review">("summary");
  const [copied, setCopied] = useState(false);
  const data = asRow(api.data);
  const trade = asRow(data?.trade);
  const decision = asRow(data?.decision);
  const review = asRow(data?.review);
  const orders = asRows(data?.orders);
  const fills = asRows(data?.fills);
  const candles = asRows(data?.candles);

  useEffect(() => {
    const node = dialog.current;
    if (node && !node.open) node.showModal();
  }, []);

  const close = () => { dialog.current?.close(); onClose(); };
  const features = trade ? asRow(parseJson(trade.entry_features, {})) : null;
  const observations = asRows(parseJson(review?.observations, []));
  const lessons = asRows(parseJson(review?.lesson_candidates, []));
  const riskVerdict = decision ? parseJson<Row>(decision.risk_verdict, {}) : {};
  const rawConfidence = decision && decision.raw_confidence !== null && decision.raw_confidence !== undefined ? Number(decision.raw_confidence) : null;
  const calibratedConfidence = decision && decision.calibrated_confidence !== null && decision.calibrated_confidence !== undefined ? Number(decision.calibrated_confidence) : null;
  const capital = trade?.status === "OPEN" || trade?.status === "RECONCILIATION_PENDING" ? trade : asRow(trade?.entry_capital);
  const trusted = trade ? isTrustedNetTrade(trade) : false;
  const financialPnl = trade?.status === "OPEN" ? asNumber(trade.upl) : trusted ? asNumber(trade?.pnl) : null;
  const financialR = trade?.status === "OPEN" ? asNumber(trade.live_r ?? trade.r) : trusted ? asNumber(trade?.result_r) : null;

  return <dialog ref={dialog} className="trade-dialog" aria-labelledby="trade-detail-title" onClose={onClose} onClick={event => { if (event.target === event.currentTarget) close(); }}>
    <div className="dialog-header">
      <div><span className="dialog-kicker">Trade journal</span><h2 id="trade-detail-title">{trade ? asText(trade.instrument) : tradeId}</h2><p>{trade ? `${asText(trade.side)} · ${asText(trade.strategy)} V${asText(trade.strategy_version)} · ${asText(trade.timeframe)}` : "Loading persisted trade record"}</p></div>
      <button className="icon-button dialog-close" onClick={close} aria-label="Close trade details"><X size={19}/></button>
    </div>
    {!trade ? <DataState loading={api.loading} error={api.error} empty={!data} hasData={data !== null} emptyTitle="Trade detail unavailable" emptyDetail="The requested record may no longer be available."><span/></DataState> : <>
      <div className="trade-detail-summary">
        <div><span>Side / status</span><strong><StatusBadge value={trade.side}/> <StatusBadge value={trade.status}/></strong></div>
        <div><span>{trade.status === "OPEN" ? "Unrealized PnL" : trusted ? "Verified NET PnL" : "Provisional / unavailable accounting"}</span><strong className={`mono ${toneFor(financialPnl)}`}>{formatMoney(financialPnl)}{trade.status === "OPEN" ? " · Unrealized" : !trusted ? " · Unavailable" : ""}</strong></div>
        <div><span>{trade.status === "OPEN" ? "Live R" : "Realized NET R"}</span><strong className={`mono ${toneFor(financialR)}`}>{formatR(financialR)}</strong></div>
        <div><span>Entry / exit time</span><strong>{formatTimestamp(trade.entry_ts)} / {formatTimestamp(trade.exit_ts)}</strong></div>
        <div><span>Strategy / engine</span><strong>{asText(trade.strategy)} V{asText(trade.strategy_version)} · {engineLabel(trade.engine)}</strong></div>
      </div>
      <nav className="trades-detail-tabs" aria-label="Trade detail sections">{[["summary", "Summary"], ["chart", "Chart & replay"], ["decision", "Decision"], ["execution", "Execution"], ["review", "Review & learning"]].map(([key, label]) => <button type="button" key={key} aria-pressed={section === key} onClick={() => setSection(key as typeof section)}>{label}</button>)}</nav>
      <div className="trade-detail-content">
        {section === "summary" ? <DetailSummary trade={trade} capital={capital}/> : null}
        {section === "chart" ? <>
          {trade.status === "OPEN" ? <Panel title="Live market" subtitle="Current market conditions around the active trade"><InstrumentChart instrument={String(trade.instrument)} markers={trade} initialTimeframe={trade.timeframe === "scalp" ? "1m" : String(trade.timeframe)}/></Panel> : null}
          <Panel title="Trade replay" subtitle="Stored confirmed candles and persisted trade levels" className="chart-panel">
            {trade.status === "CLOSED" ? <InstrumentChart key={tradeId} tradeId={tradeId} instrument={asText(trade.instrument)} markers={trade} initialTimeframe={trade.timeframe === "scalp" ? "1m" : String(trade.timeframe)}/> : <DataState loading={api.loading} error={api.error} empty={!candles.length} hasData={Boolean(data)} emptyTitle="No replay candles available" emptyDetail="This trade has no candle history stored for the selected replay window."><MarketChart candles={candles} markers={trade} title="Trade replay"/></DataState>}
            <div className="replay-excursions"><Field label="Maximum favorable excursion" value={trade.mfe === null || trade.mfe === undefined ? "Not recorded" : formatPrice(trade.mfe)}/><Field label="Maximum adverse excursion" value={trade.mae === null || trade.mae === undefined ? "Not recorded" : formatPrice(trade.mae)}/><span className="data-footnote">Excursion magnitudes are stored; their exact candle locations are not provided by the API.</span></div>
          </Panel>
        </> : null}
        {section === "decision" ? <>
          <Panel title="Decision snapshot" subtitle="Strategy Core action, context and deterministic Risk Engine verdict">
            {decision ? <><div className="decision-snapshot"><StatusBadge value={decision.decision}/><span className="muted-small">Decision ID {asText(decision.decision_id)}</span></div><Field label="LLM Gate verdict" value={<StatusBadge value={asText(decision.gate_result, "NOT RECORDED")}/>} detail="Gate is a veto; deterministic risk checks still govern execution"/><Field label="Raw confidence" value={formatPercent(rawConfidence !== null && Number.isFinite(rawConfidence) ? rawConfidence * 100 : null, 0)}/><Field label="Calibrated confidence" value={formatPercent(calibratedConfidence !== null && Number.isFinite(calibratedConfidence) ? calibratedConfidence * 100 : null, 0)}/><Field label="Strategy" value={asText(decision.strategy)} mono={false}/><Field label="Regime" value={asText(decision.regime).replaceAll("_", " ")} mono={false}/><Field label="Risk result" value={<StatusBadge value={asRow(riskVerdict)?.approved === true ? "APPROVED" : "REJECTED"}/>}/><Field label="Risk reason" value={asText(asRow(riskVerdict)?.reason)} mono={false}/><div className="review-copy">{renderThesis(decision.thesis)}</div></> : <div className="empty-state"><strong>No linked decision record</strong></div>}
          </Panel>
          <Panel title="Entry conditions and market snapshot" subtitle="Deterministic setup and features saved at entry"><div className="trace-list">{asRows(parseJson(trade.entry_conditions, [])).map((condition, index) => <div className="trace-step" key={index}><StatusBadge value={condition.passed ? "PASS" : "FAIL"}/><span>{asText(condition.name)} · {asText(condition.detail, "")}</span></div>)}{!asRows(parseJson(trade.entry_conditions, [])).length ? <p>No structured setup conditions stored for this trade.</p> : null}</div>{features ? <div className="snapshot-fields">{[["Price", features.price], ["EMA20", features.ema20], ["EMA50", features.ema50], ["EMA spread", features.emaSpreadPct], ["RSI14", features.rsi14], ["ADX14", features.adx14], ["ATR14", features.atr14], ["ATR %", features.atrPct], ["Volume ratio", features.volumeRatio]].map(([label, value]) => <Field key={String(label)} label={String(label)} value={formatNumber(value)}/>)}</div> : <div className="empty-state"><strong>Entry feature snapshot unavailable</strong></div>}</Panel>
        </> : null}
        {section === "execution" ? <>
          <Panel title="Native protection" subtitle="Persisted exchange verification status"><Field label="Protection state" value={<StatusBadge value={asText(trade.protection_state, "UNVERIFIED")}/>} detail={asText(trade.protection_checked_at, "Verification timestamp unavailable")}/><Field label="Exit confirmation" value={asText(trade.exit_confirmation, "Not recorded")} mono={false}/></Panel>
          <Panel title="Orders" subtitle="Persisted exchange order records">{orders.length ? <div className="detail-record-list">{orders.map((order, index) => <div className="detail-record" key={asText(order.ordId, String(index))}><div><strong>{asText(order.kind)} order</strong><StatusBadge value={order.state}/></div><Field label="Order ID" value={asText(order.ordId)}/><Field label="Side / position" value={`${asText(order.side)} / ${asText(order.posSide)}`}/><Field label="Size / average" value={`${asText(order.sz)} / ${formatPrice(order.avgPx)}`}/><Field label="Native protection" value={asText(order.protection_state, "See trade evidence")}/></div>)}</div> : <div className="empty-state"><strong>No order records stored</strong></div>}</Panel>
          <Panel title="Fills" subtitle="Individual exchange fill evidence">{fills.length ? <div className="table-scroll"><table className="compact-table"><thead><tr><th>Time</th><th>Price</th><th>Size</th><th>Fee</th></tr></thead><tbody>{fills.map((fill, index) => <tr key={`${asText(fill.tradeId)}-${index}`}><td>{formatTimestamp(fill.ts)}</td><td className="numeric mono">{formatPrice(fill.fillPx)}</td><td className="numeric mono">{asText(fill.fillSz)}</td><td className="numeric mono">{asText(fill.fee)} {asText(fill.feeCcy, "")}</td></tr>)}</tbody></table></div> : <p className="muted-small">No individual fills are linked to this trade.</p>}<Field label="Accounting evidence" value={<StatusBadge value={asText(trade.evidence_state, "PENDING")}/>} detail={asText(trade.evidence_reason, "Complete deterministic evidence required")}/><Field label="Accounting quality" value={asText(trade.accounting_quality, "PENDING")} detail={asText(trade.result_r_basis, "Result unavailable")}/></Panel>
        </> : null}
        {section === "review" ? <>
          <Panel title="Post-trade review" subtitle={review ? `Observational review · ${formatTimestamp(review.ts)}` : "No review has been recorded for this trade"}>{review ? <><div className="review-observations">{observations.length ? observations.map((observation, index) => <article className="observation-row" key={`${asText(observation.factor)}-${index}`}><div><strong>{asText(observation.factor, "Observation")}</strong><StatusBadge value={observation.effect}/></div><p>{asText(observation.evidence)}</p></article>) : <div className="empty-state"><strong>No structured observations recorded</strong></div>}</div><h3 className="subsection-title">Lesson candidates</h3>{lessons.length ? <div className="lesson-candidate-list">{lessons.map((lesson, index) => <article key={`${asText(lesson.statement)}-${index}`}><p>{asText(lesson.statement)}</p><div><StatusBadge value="PROVISIONAL"/><span>{formatPercent((asNumber(lesson.confidence) ?? NaN) * 100, 0)} confidence</span></div></article>)}</div> : <p className="muted-small">No lesson candidates were attached to this review.</p>}</> : <div className="empty-state"><strong>Review pending or unavailable</strong><span>Only persisted reviewer output is shown here.</span></div>}</Panel>
          <Panel title="Evidence eligibility" subtitle="Accounting validity and evolution eligibility are shown separately"><Field label="Financial accounting" value={<StatusBadge value={trusted ? "VALID NET" : asText(trade.evidence_state, "UNAVAILABLE")}/>} detail={trusted ? "Complete NET values are available" : asText(trade.evidence_reason, "Verified NET result unavailable")}/><Field label="Evolution evidence" value={<StatusBadge value={trade.evolution_evidence_eligible === 1 ? "ELIGIBLE" : "NOT ELIGIBLE"}/>}/></Panel>
        </> : null}
      </div>
      <div className="trade-detail-meta"><span>Trade ID <code>{asText(trade.trade_id)}</code></span><button type="button" className="secondary-button" onClick={() => { void navigator.clipboard?.writeText(asText(trade.trade_id)).then(() => setCopied(true)).catch(() => setCopied(false)); }}><Copy size={14}/>{copied ? "Copied" : "Copy ID"}</button><span>Regime {asText(trade.regime).replaceAll("_", " ")}</span></div>
    </>}
  </dialog>;
}

function DetailSummary({ trade, capital }: { trade: Row; capital: Row | null }) {
  return <>
    <Panel title="Position summary" subtitle="Entry, exit, and persisted position details"><div className="position-financials">
      <Field label="Entry price" value={formatPrice(trade.entry_px)}/><Field label="Exit price" value={formatPrice(trade.exit_px)}/><Field label="Mark price" value={trade.status === "OPEN" ? formatPrice(trade.mark_px) : "Not applicable"}/>
      <Field label="Contracts" value={asText(trade.contracts)}/><Field label="Margin used · USDT" value={formatAmount(capital?.margin_used)} detail={asText(capital?.margin_source, "UNAVAILABLE")}/><Field label="Notional" value={formatAmount(capital?.notional, asText(capital?.notional_currency, ""))}/>
      <Field label="Actual leverage" value={formatLeverage(capital?.actual_leverage ?? trade.leverage)} detail={capital?.leverage_mismatch ? "Differs from configured entry leverage" : asText(capital?.margin_mode).toUpperCase()}/><Field label="Initial stop" value={formatPrice(trade.initial_stop_px ?? trade.stop_px)}/><Field label="Active stop" value={formatPrice(trade.stop_px)}/>
      <Field label="Take profit" value={formatPrice(trade.take_profit_px)}/><Field label="Exit reason" value={asText(trade.exit_reason)} mono={false}/><Field label="Duration" value={formatDuration(trade.duration_s)}/>
      <Field label="Initial price risk" value={formatAmount(capital?.initial_risk)}/><Field label="Risk at active stop" value={formatAmount(capital?.risk_at_stop)} detail="Estimated, excludes execution costs"/><Field label="Cross IMR · USD" value={formatAmount(capital?.cross_imr_usd, "USD")} detail="Margin requirement, not allocated collateral"/>
    </div></Panel>
    <Panel title="Accounting evidence" subtitle="Only complete verified NET evidence is shown as realized profit"><Field label="Financial result" value={<StatusBadge value={isTrustedNetTrade(trade) ? "VALID NET" : asText(trade.evidence_state, "UNAVAILABLE")}/>} detail={asText(trade.evidence_reason, "Complete deterministic evidence required")}/><Field label="Accounting quality" value={asText(trade.accounting_quality, "PENDING")} detail={asText(trade.result_r_basis, "Result unavailable")}/><Field label="Capital snapshot" value={formatTimestamp(trade.capital_observed_at)} detail={asText(capital?.margin_source, "Entry snapshot unavailable")}/></Panel>
  </>;
}

function renderThesis(value: unknown) {
  const parsed = parseJson<unknown>(value, []);
  const points = Array.isArray(parsed) ? parsed : typeof parsed === "string" ? [parsed] : [];
  return points.map((item, index) => <p key={`${index}-${typeof item === "string" ? item : "point"}`}>{typeof item === "string" ? item : JSON.stringify(item)}</p>);
}
