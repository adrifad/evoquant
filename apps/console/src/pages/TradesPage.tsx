import { useEffect, useRef, useState } from "react";
import { useApi } from "../hooks/useApi";
import { formatDuration, formatMoney, formatNumber, formatPercent, formatPrice, formatR, formatTimestamp, toneFor } from "../lib/format";
import { asNumber, asRow, asRows, asText, parseJson, type Row } from "../lib/types";
import { Badge, DataState, DataTable, Evidence, Field, PageHeading, Panel, StatusBadge } from "../components/Primitives";
import { MarketChart } from "../components/MarketChart";
import { X } from "lucide-react";

export function TradesPage() {
  const api = useApi<unknown>("/api/trades");
  const reviewsApi = useApi<unknown>("/api/reviews");
  const [search, setSearch] = useState("");
  const [side, setSide] = useState("ALL");
  const [result, setResult] = useState("ALL");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const trades = asRows(api.data);
  const reviewedTrades = new Set(asRows(reviewsApi.data).map(review => asText(review.trade_id, "")));
  const visible = trades.filter(row => {
    const matchesText = `${asText(row.trade_id)} ${asText(row.instrument)} ${asText(row.strategy)} ${asText(row.regime)}`.toLowerCase().includes(search.toLowerCase());
    const matchesSide = side === "ALL" || row.side === side;
    const isOpen = row.status === "OPEN";
    const pnl = row.pnl === null || row.pnl === undefined ? null : Number(row.pnl);
    const outcome = isOpen ? "OPEN" : pnl === null || !Number.isFinite(pnl) ? "UNKNOWN" : pnl > 0 ? "WIN" : pnl < 0 ? "LOSS" : "FLAT";
    return matchesText && matchesSide && (result === "ALL" || outcome === result);
  });

  return <div className="page">
    <PageHeading title="Trades" description="Search the ledger and trace each position through decision, execution, risk, and review." detail={<Evidence sample={trades.filter(row => row.status === "CLOSED").length}/>}/>
    <Panel title="Trade ledger" subtitle={`${visible.length} of ${trades.length} records`} className="ledger-panel">
      <div className="ledger-filters">
        <label className="filter-control filter-search"><span>Search records</span><input value={search} onChange={event => setSearch(event.target.value)} placeholder="Trade ID, symbol, strategy, regime"/></label>
        <label className="filter-control"><span>Side</span><select value={side} onChange={event => setSide(event.target.value)}><option>ALL</option><option>LONG</option><option>SHORT</option></select></label>
        <label className="filter-control"><span>Result</span><select value={result} onChange={event => setResult(event.target.value)}><option>ALL</option><option>OPEN</option><option>WIN</option><option>LOSS</option><option>FLAT</option></select></label>
      </div>
      <DataState loading={api.loading} error={api.error} empty={!visible.length} hasData={api.data !== null} emptyTitle={trades.length ? "No trades match these filters" : "No trades recorded yet"} emptyDetail={trades.length ? "Change the search or result filters to see other records." : "Trades appear here after an entry is recorded."}>
        <DataTable caption="Trade ledger. Select a trade ID to open its details." rows={visible} rowKey={(row, index) => asText(row.trade_id, String(index))} onRowClick={row => setSelectedId(asText(row.trade_id, ""))} minWidth={1180} columns={[
          { key: "trade_id", label: "Trade ID", render: row => asText(row.trade_id) },
          { key: "time", label: "Time", render: row => formatTimestamp(row.exit_ts ?? row.entry_ts) },
          { key: "symbol", label: "Symbol", render: row => asText(row.instrument) },
          { key: "side", label: "Side", render: row => <StatusBadge value={row.side}/> },
          { key: "strategy", label: "Strategy", render: row => `${asText(row.strategy)} V${asText(row.strategy_version)}` },
          { key: "regime", label: "Regime", render: row => asText(row.regime).replaceAll("_", " ") },
          { key: "entry", label: "Entry", numeric: true, render: row => formatPrice(row.entry_px) },
          { key: "exit", label: "Exit / mark", numeric: true, render: row => row.status === "OPEN" ? formatPrice(row.mark_px) : formatPrice(row.exit_px) },
          { key: "r", label: "R", numeric: true, render: row => <span className={toneFor(row.status === "OPEN" ? row.live_r : row.result_r)}>{formatR(row.status === "OPEN" ? row.live_r : row.result_r)}</span> },
          { key: "pnl", label: "PnL", numeric: true, render: row => <span className={toneFor(row.status === "OPEN" ? row.upl : row.pnl)}>{formatMoney(row.status === "OPEN" ? row.upl : row.pnl)}</span> },
          { key: "duration", label: "Duration", numeric: true, render: row => formatDuration(row.status === "OPEN" ? row.live_dur_s : row.duration_s) },
          { key: "result", label: "Result", render: row => <StatusBadge value={row.status === "OPEN" ? "OPEN" : row.pnl === null || row.pnl === undefined || !Number.isFinite(Number(row.pnl)) ? "UNKNOWN" : Number(row.pnl) > 0 ? "WIN" : Number(row.pnl) < 0 ? "LOSS" : "FLAT"}/> },
          { key: "review", label: "Review record", render: row => <StatusBadge value={reviewedTrades.has(asText(row.trade_id, "")) ? "RECENT REVIEW" : "CHECK DETAIL"}/> },
        ]}/>
      </DataState>
    </Panel>
    {selectedId ? <TradeDetailDialog tradeId={selectedId} onClose={() => setSelectedId(null)}/> : null}
  </div>;
}

function TradeDetailDialog({ tradeId, onClose }: { tradeId: string; onClose: () => void }) {
  const api = useApi<unknown>(`/api/trades/${encodeURIComponent(tradeId)}`, 15_000);
  const dialog = useRef<HTMLDialogElement>(null);
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

  return <dialog ref={dialog} className="trade-dialog" aria-labelledby="trade-detail-title" onClose={onClose} onClick={event => { if (event.target === event.currentTarget) close(); }}>
    <div className="dialog-header">
      <div><span className="dialog-kicker">Trade detail</span><h2 id="trade-detail-title">{trade ? asText(trade.trade_id) : tradeId}</h2><p>{trade ? `${asText(trade.instrument)} | ${asText(trade.timeframe)} | ${asText(trade.strategy)} V${asText(trade.strategy_version)}` : "Loading persisted trade record"}</p></div>
      <button className="icon-button dialog-close" onClick={close} aria-label="Close trade details"><X size={19}/></button>
    </div>
    {!trade ? <DataState loading={api.loading} error={api.error} empty={!data} hasData={data !== null} emptyTitle="Trade detail unavailable" emptyDetail="The requested record may no longer be available."><span/></DataState> : <>
      <div className="trade-detail-summary">
        <div><span>Side</span><StatusBadge value={trade.side}/></div>
        <div><span>Result</span><strong className={`mono ${toneFor(trade.result_r)}`}>{trade.status === "OPEN" ? "OPEN" : formatR(trade.result_r)}</strong></div>
        <div><span>PnL</span><strong className={`mono ${toneFor(trade.pnl)}`}>{trade.status === "OPEN" ? "Not realized" : formatMoney(trade.pnl)}</strong></div>
        <div><span>Regime</span><strong>{asText(trade.regime).replaceAll("_", " ")}</strong></div>
        <div><span>Entry time</span><strong>{formatTimestamp(trade.entry_ts)}</strong></div>
      </div>
      <div className="trade-detail-content">
        <Panel title="Trade replay" subtitle="Stored confirmed candles and persisted trade levels" className="chart-panel">
          <DataState loading={api.loading} error={api.error} empty={!candles.length} hasData={Boolean(data)} emptyTitle="No replay candles available" emptyDetail="This trade has no candle history stored for the selected replay window.">
            <MarketChart candles={candles} markers={trade} title="Trade replay"/>
          </DataState>
          <div className="replay-excursions"><Field label="Maximum favorable excursion" value={trade.mfe === null || trade.mfe === undefined ? "Not recorded" : formatPrice(trade.mfe)}/><Field label="Maximum adverse excursion" value={trade.mae === null || trade.mae === undefined ? "Not recorded" : formatPrice(trade.mae)}/><span className="data-footnote">Excursion magnitudes are stored; their exact candle locations are not provided by the API.</span></div>
        </Panel>
        <div className="trade-detail-grid">
          <Panel title="Decision snapshot" subtitle="AI proposal and deterministic Risk Engine verdict">
            {decision ? <><div className="decision-snapshot"><StatusBadge value={decision.decision}/><span className="muted-small">Decision ID {asText(decision.decision_id)}</span></div><Field label="Raw confidence" value={formatPercent(rawConfidence !== null && Number.isFinite(rawConfidence) ? rawConfidence * 100 : null, 0)}/><Field label="Calibrated confidence" value={formatPercent(calibratedConfidence !== null && Number.isFinite(calibratedConfidence) ? calibratedConfidence * 100 : null, 0)}/><Field label="Strategy" value={asText(decision.strategy)} mono={false}/><Field label="Regime" value={asText(decision.regime).replaceAll("_", " ")} mono={false}/><Field label="Risk result" value={<StatusBadge value={asRow(riskVerdict)?.approved === true ? "APPROVED" : "REJECTED"}/>}/><Field label="Risk reason" value={asText(asRow(riskVerdict)?.reason)} mono={false}/><div className="review-copy">{renderThesis(decision.thesis)}</div></> : <div className="empty-state"><strong>No linked decision record</strong></div>}
          </Panel>
          <Panel title="Execution" subtitle="Exchange order and fill records">
            {orders.length ? <div className="detail-record-list">{orders.map((order, index) => <div className="detail-record" key={asText(order.ordId, String(index))}><div><strong>{asText(order.kind)} order</strong><StatusBadge value={order.state}/></div><Field label="Order ID" value={asText(order.ordId)}/><Field label="Side / position" value={`${asText(order.side)} / ${asText(order.posSide)}`}/><Field label="Size / average" value={`${asText(order.sz)} / ${formatPrice(order.avgPx)}`}/></div>)}</div> : <div className="empty-state"><strong>No order records stored</strong></div>}
            <h3 className="subsection-title">Fills ({fills.length})</h3>
            {fills.length ? <div className="table-scroll"><table className="compact-table"><thead><tr><th>Time</th><th>Price</th><th>Size</th><th>Fee</th></tr></thead><tbody>{fills.map((fill, index) => <tr key={`${asText(fill.tradeId)}-${index}`}><td>{formatTimestamp(fill.ts)}</td><td className="numeric mono">{formatPrice(fill.fillPx)}</td><td className="numeric mono">{asText(fill.fillSz)}</td><td className="numeric mono">{asText(fill.fee)} {asText(fill.feeCcy, "")}</td></tr>)}</tbody></table></div> : <p className="muted-small">No individual fills are linked to this trade.</p>}
          </Panel>
          <Panel title="Risk" subtitle="Position parameters captured at entry">
            <Field label="Initial stop" value={formatPrice(trade.initial_stop_px ?? trade.stop_px)}/><Field label="Active stop" value={formatPrice(trade.stop_px)}/><Field label="Take profit" value={formatPrice(trade.take_profit_px)}/><Field label="Planned risk" value={`${formatNumber(trade.planned_risk_pct)}%`}/><Field label="Leverage" value={`${formatNumber(trade.leverage, 0)}x`}/><Field label="Contracts" value={asText(trade.contracts)}/><Field label="Exit reason" value={asText(trade.exit_reason)} mono={false}/><Field label="Duration" value={formatDuration(trade.duration_s)}/>
          </Panel>
          <Panel title="Market snapshot" subtitle="Entry features saved with the decision">
            {features ? <div className="snapshot-fields">{[["Price", features.price], ["EMA20", features.ema20], ["EMA50", features.ema50], ["EMA spread", features.emaSpreadPct], ["RSI14", features.rsi14], ["ADX14", features.adx14], ["ATR14", features.atr14], ["ATR %", features.atrPct], ["Volume ratio", features.volumeRatio]].map(([label, value]) => <Field key={String(label)} label={String(label)} value={formatNumber(value)} />)}</div> : <div className="empty-state"><strong>Entry feature snapshot unavailable</strong></div>}
          </Panel>
        </div>
        <Panel title="Post-trade review" subtitle={review ? `${asText(review.outcome)} | reviewed ${formatTimestamp(review.ts)}` : "No review has been recorded for this trade"}>
          {review ? <>
            <div className="review-observations">{observations.length ? observations.map((observation, index) => <article className="observation-row" key={`${asText(observation.factor)}-${index}`}><div><strong>{asText(observation.factor, "Observation")}</strong><StatusBadge value={observation.effect}/></div><p>{asText(observation.evidence)}</p></article>) : <div className="empty-state"><strong>No structured observations recorded</strong></div>}</div>
            <h3 className="subsection-title">Lesson candidates</h3>
            {lessons.length ? <div className="lesson-candidate-list">{lessons.map((lesson, index) => <article key={`${asText(lesson.statement)}-${index}`}><p>{asText(lesson.statement)}</p><div><StatusBadge value="PROVISIONAL"/><span>{formatPercent((asNumber(lesson.confidence) ?? NaN) * 100, 0)} confidence</span></div></article>)}</div> : <p className="muted-small">No lesson candidates were attached to this review.</p>}
          </> : <div className="empty-state"><strong>Review pending or unavailable</strong><span>Only persisted reviewer output is shown here.</span></div>}
        </Panel>
      </div>
    </>}
  </dialog>;
}

function renderThesis(value: unknown) {
  const parsed = parseJson<unknown>(value, []);
  const points = Array.isArray(parsed) ? parsed : typeof parsed === "string" ? [parsed] : [];
  return points.map((item, index) => <p key={`${index}-${typeof item === "string" ? item : "point"}`}>{typeof item === "string" ? item : JSON.stringify(item)}</p>);
}
