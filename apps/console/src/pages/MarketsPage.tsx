import { useState } from "react";
import { useApi } from "../hooks/useApi";
import { formatNumber, formatPrice, formatTimestamp, toneFor } from "../lib/format";
import { asRow, asRows, asText, type ApiState, type Row } from "../lib/types";
import { DataState, DataTable, DividerLabel, Field, PageHeading, Panel, StatusBadge } from "../components/Primitives";
import { InstrumentChart } from "../components/InstrumentChart";

export function MarketsPage({ status }: { status: ApiState<Row> }) {
  const market = useApi<unknown>("/api/market");
  const watchlist = useApi<unknown>("/api/watchlist", 60_000);
  const funnel = useApi<unknown>("/api/opportunity-funnel?hours=24", 60_000);
  const [selected, setSelected] = useState("");
  const d = asRow(market.data);
  const snapshot = asRow(d?.snapshot);
  const scanner = asRows(d?.scan);
  const weights = asRow(d?.weights) ?? {};
  const instrument = selected || asText(status.data?.instrument);
  const selectedRow = scanner.find(row => row.instrument === instrument);
  const wl = asRow(watchlist.data);
  const dynamic = asRows(wl?.dynamic);
  const historicalDynamic = asRows(wl?.historical_dynamic);
  const stats = asRow(wl?.statistics) ?? {};
  const [refreshError, setRefreshError] = useState("");
  const refreshWatchlist = async () => {
    if (!window.confirm("This normally refreshes once per day. Refresh now?")) return;
    setRefreshError("");
    const response = await fetch("/api/watchlist", { method: "POST" });
    if (!response.ok) {
      const failure = asRow(await response.json().catch(() => null));
      setRefreshError(asText(failure?.error, "DYNAMIC_WATCHLIST_REFRESH_FAILED"));
      return;
    }
    watchlist.applyResponse(await response.json() as unknown);
    window.dispatchEvent(new Event("evoquant:refresh"));
  };

  return <div className="page">
    <PageHeading title="Markets" description="Inspect the market inputs and regime used by the current decision cycle." detail={<span className="muted-small">Updated {formatTimestamp(d?.updatedAt)}</span>}/>
    <Panel title="Daily Dynamic Watchlist" subtitle={`Status ${asText(wl?.status, "LOADING")} · Selected ${formatNumber(stats.selected, 0)} / 8 · Analyzed ${formatNumber(stats.analyzed, 0)} · Failed analysis ${formatNumber(stats.candleRequestsFailed, 0)} · Minimum score 60 · Last updated ${formatTimestamp(wl?.generated_at)} · Next ${formatTimestamp(wl?.next_refresh)}`} action={<button className="button button-secondary" onClick={() => void refreshWatchlist()}>Refresh dynamic watchlist</button>}>
      {refreshError ? <p className="inline-warning">{refreshError}. Existing snapshot was preserved when available.</p> : null}
      {asText(wl?.status) === "DISABLED" ? <p className="muted-small">Dynamic Watchlist disabled. Core markets remain active for new entries; historical dynamic snapshots are retained for audit.</p> : null}
      <DataState loading={watchlist.loading} error={watchlist.error} empty={!dynamic.length} hasData={watchlist.data !== null} emptyTitle="No dynamic markets selected" emptyDetail="Core markets remain monitored. The next eligible daily discovery will retain only markets that pass quality filters.">
        <DataTable rows={dynamic} rowKey={r => String(r.symbol)} minWidth={900} columns={[
          { key: "rank", label: "Rank", numeric: true, render: r => `#${asText(r.rank)}` },
          { key: "symbol", label: "Symbol", render: r => asText(r.symbol) },
          { key: "trend", label: "Trend", render: r => <StatusBadge value={r.trend_direction}/> },
          { key: "score", label: "Score", numeric: true, render: r => formatNumber(r.score, 1) },
          { key: "1h", label: "1h", numeric: true, render: r => `${formatNumber(asRow(r.metrics)?.momentum1hPct, 2)}%` },
          { key: "4h", label: "4h", numeric: true, render: r => `${formatNumber(asRow(r.metrics)?.momentum4hPct, 2)}%` },
          { key: "adx", label: "ADX", numeric: true, render: r => formatNumber(asRow(r.metrics)?.adx14, 1) },
          { key: "volume", label: "Volume", numeric: true, render: r => `${formatNumber(asRow(r.metrics)?.relativeVolume, 2)}x` },
          { key: "spread", label: "Spread", numeric: true, render: r => `${formatNumber(asRow(r.metrics)?.spreadPct, 3)}%` },
          { key: "status", label: "Status", render: () => <StatusBadge value="DYNAMIC"/> },
        ]}/>
      </DataState>
      {asText(wl?.status) === "DISABLED" && historicalDynamic.length ? <p className="muted-small">Historical selection: {historicalDynamic.map(row => asText(row.symbol)).join(", ")}</p> : null}
      <p className="muted-small">Core symbols are always monitored. A selected dynamic market still must pass Strategy Core, Gate, Risk, and Execution; trending is not an entry signal.</p>
    </Panel>
    <Panel title="Opportunity funnel" subtitle="Persisted scanner and entry outcomes · rolling 24 hours">
      <DataState loading={funnel.loading} error={funnel.error} empty={!hasFunnelData(funnel.data)} hasData={funnel.data !== null}
        emptyTitle="Opportunity telemetry is accumulating" emptyDetail="Counts appear after Swing and Scalp complete their next market evaluations.">
        <div className="opportunity-funnel-grid">
          <OpportunityFunnelEngine title="Swing 15m" engine={asRow(asRow(funnel.data)?.engines)?.SWING_15M} />
          <OpportunityFunnelEngine title="Scalp 5m" engine={asRow(asRow(funnel.data)?.engines)?.SCALP_5M} />
        </div>
        {Number(asRow(funnel.data)?.confidenceBelowMinimum && asRow(asRow(funnel.data)?.confidenceBelowMinimum)?.count) > 0
          ? <p className="muted-small">Gate-allowed candidates later rejected solely by calibrated minimum confidence: {formatNumber(asRow(asRow(funnel.data)?.confidenceBelowMinimum)?.count, 0)} ({formatNumber(asRow(asRow(funnel.data)?.confidenceBelowMinimum)?.pct, 1)}% of Gate allows).</p>
          : null}
      </DataState>
    </Panel>
    <Panel title="Market scanner" subtitle="Select an instrument; setup, context veto and risk retain separate states">
      <DataState loading={market.loading} error={market.error} empty={!scanner.length} hasData={market.data !== null} emptyTitle="Scanner is waiting for a confirmed market cycle">
        <DataTable rows={scanner} rowKey={r => String(r.instrument)} onRowClick={r => setSelected(String(r.instrument))} minWidth={1050} columns={[
          { key: "symbol", label: "Instrument", render: r => asText(r.instrument) },
          { key: "price", label: "Price", numeric: true, render: r => formatPrice(r.price) },
          { key: "regime", label: "Regime", render: r => asText(r.regime) },
          { key: "strategy", label: "Strategy", render: r => asText(r.strategy, "No candidate") },
          { key: "side", label: "Side", render: r => asText(asRow(r.candidate)?.side, "None") },
          { key: "score", label: "Setup score", numeric: true, render: r => formatNumber(asRow(r.candidate)?.setupScore) },
          { key: "gate", label: "Gate", render: r => asText(r.gate) },
          { key: "risk", label: "Risk", render: r => asText(r.risk) },
          { key: "state", label: "Candidate state", render: r => <StatusBadge value={r.state}/> },
          { key: "scanned", label: "Last scanned", render: r => {
            const activity = asRow(asRow(r.scanActivity)?.swing);
            return activity?.lastScanAt ? formatTimestamp(activity.lastScanAt) : "Never scanned";
          } },
          { key: "signal", label: "Last signal", render: r => formatTimestamp(r.lastSignal) },
        ]}/>
      </DataState>
    </Panel>
    <Panel title="Market chart" subtitle={`${instrument} | confirmed exchange candles`} className="chart-panel">
      <InstrumentChart key={instrument} instrument={instrument} markers={asRows(status.data?.openPositions).find(p => p.instrument === instrument) ?? {}}/>
    </Panel>
    {selectedRow ? <Panel title={`${instrument} decision trace`} subtitle="Failures are deterministic setup conditions; unselected candidates have no Gate or risk result">
      <div className="trace-list"><div className="trace-step"><strong>Setup</strong><span>{selectedRow.tradable ? `PASS · ${asText(asRow(selectedRow.candidate)?.side)} · ${asText(selectedRow.strategy)}` : asText(selectedRow.state)}</span></div><div className="trace-step"><strong>Gate</strong><span>{asText(selectedRow.gate)}</span></div><div className="trace-step"><strong>Risk</strong><span>{asText(selectedRow.risk)}</span></div><div className="trace-step"><strong>Execution</strong><span>{selectedRow.position ? "OPEN POSITION" : "No open position recorded"}</span></div>
      <ScanActivityDetails engine="Swing scanner" activity={asRow(asRow(selectedRow.scanActivity)?.swing)} staleAfterMs={35 * 60_000}/>
      <ScanActivityDetails engine="Scalp scanner" activity={asRow(asRow(selectedRow.scanActivity)?.scalp)} staleAfterMs={12 * 60_000}/>
      {Array.isArray(selectedRow.reason) ? selectedRow.reason.slice(0,12).map((r,i) => <div className="trace-step" key={i}><strong>{i === 0 ? "Reasons" : ""}</strong><span>{String(r)}</span></div>) : null}</div>
    </Panel> : null}
    <DataState loading={market.loading} error={market.error} empty={!d} hasData={market.data !== null} emptyTitle="Market snapshot is not available" emptyDetail="The feature snapshot appears after the bot completes a market evaluation.">
      <div className="market-analysis-grid">
        <Panel title="Feature snapshot" subtitle="Values from the latest feature build">
          {snapshot ? <div className="feature-groups">
            <section><DividerLabel>Trend</DividerLabel><Field label="Price" value={formatPrice(snapshot.price)}/><Field label="EMA 20" value={formatPrice(snapshot.ema20)}/><Field label="EMA 50" value={formatPrice(snapshot.ema50)}/><Field label="EMA spread" value={`${formatNumber(snapshot.emaSpreadPct)}%`} tone={toneFor(snapshot.emaSpreadPct)}/></section>
            <section><DividerLabel>Momentum</DividerLabel><Field label="RSI 14" value={formatNumber(snapshot.rsi14, 1)}/><Field label="ADX 14" value={formatNumber(snapshot.adx14, 1)}/></section>
            <section><DividerLabel>Volatility</DividerLabel><Field label="ATR 14" value={formatPrice(snapshot.atr14)}/><Field label="ATR %" value={`${formatNumber(snapshot.atrPct)}%`}/></section>
            <section><DividerLabel>Volume</DividerLabel><Field label="Volume" value={formatNumber(snapshot.volume, 3)}/><Field label="Volume ratio" value={formatNumber(snapshot.volumeRatio)}/></section>
          </div> : <div className="empty-state"><strong>No feature snapshot recorded</strong><span>Wait for the bot's next completed market evaluation.</span></div>}
        </Panel>
        <Panel title="Market regime" subtitle="Classifier output for the latest tick" className="regime-panel">
          <StatusBadge value={d?.regime}/>
          <p className="regime-copy">This label is produced by the deterministic market regime classifier. It is context for the decision, not a trade instruction.</p>
          <div className="regime-last"><span>Snapshot time</span><strong className="mono">{formatTimestamp(d?.updatedAt)}</strong></div>
        </Panel>
      </div>
      <div className="market-analysis-grid market-lower-grid">
        <Panel title="Signal weights" subtitle="Current learning weights">
          {Object.keys(weights).length ? <DataTable caption="Current signal weights" rows={Object.entries(weights).map(([signal, weight]) => ({ signal, weight }))} rowKey={row => String(row.signal)} minWidth={460} columns={[
            { key: "signal", label: "Signal", render: row => asText(row.signal) },
            { key: "weight", label: "Weight", numeric: true, render: row => formatNumber(row.weight) },
            { key: "score", label: "Raw score", numeric: true, render: () => <span className="muted-small">Not supplied by API</span> },
            { key: "contribution", label: "Contribution", numeric: true, render: () => <span className="muted-small">Not supplied by API</span> },
          ]}/> : <div className="empty-state"><strong>No signal weights recorded</strong></div>}
        </Panel>
      </div>
    </DataState>
  </div>;
}

function hasFunnelData(value: unknown): boolean {
  const engines = asRow(asRow(value)?.engines);
  return ["SWING_15M", "SCALP_5M"].some(key => Object.keys(asRow(asRow(engines?.[key])?.totals) ?? {}).length > 0);
}

function OpportunityFunnelEngine({ title, engine }: { title: string; engine: unknown }) {
  const projected = asRow(engine);
  const totals = asRow(projected?.totals) ?? {};
  const metricLabels: Array<[string, string]> = [
    ["SYMBOLS_EVALUATED", "Symbols evaluated"], ["MARKET_DATA_FAILED", "Market data failed"],
    ["INSUFFICIENT_DATA", "Insufficient data"], ["NO_SETUP", "No setup"],
    ["CANDIDATE_GENERATED", "Candidates"], ["STANCE_REJECT", "Stance rejected"],
    ["GATE_ALLOW", "Gate allow"], ["GATE_DENY", "Gate deny"], ["GATE_ERROR", "Gate error"],
    ["RISK_PASS", "Risk pass"], ["RISK_REJECT", "Risk reject"],
    ["ORDER_SUBMITTED", "Order submitted"], ["POSITION_OPENED", "Positions opened"],
  ];
  const present = metricLabels.filter(([key]) => typeof totals[key] === "number");
  const blockers = asRows(projected?.blockers).slice(0, 5);
  return <section className="opportunity-funnel-engine">
    <h3>{title}</h3>
    <div className="opportunity-funnel-metrics">
      {present.map(([key, label]) => <div className="opportunity-funnel-metric" key={key}><span>{label}</span><strong>{formatNumber(totals[key], 0)}</strong></div>)}
    </div>
    {blockers.length ? <div className="opportunity-funnel-blockers"><span className="muted-small">Top deterministic blockers</span>
      {blockers.map((row, index) => <div className="opportunity-funnel-blocker" key={`${asText(row.strategy)}:${asText(row.condition)}:${index}`}>
        <span>{asText(row.strategy)} · {asText(row.condition)}</span><strong>{formatNumber(row.count, 0)}</strong>
      </div>)}
    </div> : <p className="muted-small">No blocker counts persisted in this window.</p>}
  </section>;
}

function ScanActivityDetails({ engine, activity, staleAfterMs }: { engine: string; activity: Row | null; staleAfterMs: number }) {
  if (!activity) return <div className="trace-step"><strong>{engine}</strong><span>Never scanned</span></div>;
  const lastSuccess = asText(activity.lastSuccessfulScanAt, "");
  const ageMs = lastSuccess ? Date.now() - new Date(lastSuccess).getTime() : null;
  const stale = ageMs !== null && Number.isFinite(ageMs) && ageMs > staleAfterMs;
  return <>
    <div className="trace-step"><strong>{engine}</strong><span>Last scanned {formatTimestamp(activity.lastScanAt)}</span></div>
    <div className="trace-step"><strong>Last successful</strong><span>{lastSuccess ? formatTimestamp(lastSuccess) : "None yet"}{stale ? " · STALE" : lastSuccess ? " · FRESH" : ""}</span></div>
    <div className="trace-step"><strong>Confirmed {asText(activity.candleTimeframe, "market")} candle</strong><span>{formatTimestamp(activity.candleTs)}</span></div>
    <div className="trace-step"><strong>Scan result</strong><span>{asText(activity.result)}</span></div>
    {activity.reason ? <div className="trace-step"><strong>Scan reason</strong><span>{asText(activity.reason)}</span></div> : null}
  </>;
}
