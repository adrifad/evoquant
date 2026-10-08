import { useState } from "react";
import { asRows, asText, type ApiState, type Row } from "../lib/types";
import { formatAmount, formatDuration, formatLeverage, formatMoney, formatNumber, formatPrice } from "../lib/format";
import { DataState, DataTable, PageHeading, Panel, StatusBadge } from "../components/Primitives";
import { CapitalSummary } from "../components/CapitalSummary";
import { InstrumentChart } from "../components/InstrumentChart";
import { TradeDetailDialog } from "./TradesPage";

export function TradingPage({ status }: { status: ApiState<Row> }) {
  const [selected, setSelected] = useState<string | null>(null);
  const [instrument, setInstrument] = useState("");
  const s = status.data;
  const open = asRows(s?.openPositions);
  const watchlist = Array.isArray(s?.watchlist) ? s.watchlist.map(String) : [];
  const symbol = instrument || asText(open[0]?.instrument, asText(s?.instrument, ""));
  return <div className="page">
    <PageHeading title="Trading" description="Current positions, exchange capital and the markets under management." detail={<StatusBadge value={s?.botState}/>}/>
    <DataState loading={status.loading} error={status.error} empty={!s} hasData={Boolean(s)}>
      {s ? <CapitalSummary status={s}/> : null}
      <Panel title="Open positions" subtitle={`${open.length} / ${asText((s?.limits as Row | undefined)?.max_concurrent_positions)} slots · select an instrument for full trade detail`}>
        <DataState loading={status.loading} error={status.error} empty={!open.length} hasData={Boolean(s)} emptyTitle="No active positions" emptyDetail={`EvoQuant is monitoring ${watchlist.length} markets. Candidates must pass Gate and deterministic risk before execution.`}>
          <DataTable caption="Open positions" rows={open} rowKey={row => String(row.trade_id)} minWidth={1300} onRowClick={row => setSelected(String(row.trade_id))} columns={[
            { key: "instrument", label: "Instrument", render: row => asText(row.instrument) },
            { key: "side", label: "Side", render: row => <StatusBadge value={row.side}/> },
            { key: "strategy", label: "Strategy", render: row => `${asText(row.strategy)} V${asText(row.strategy_version)}` },
            { key: "entry", label: "Entry / current", numeric: true, render: row => <>{formatPrice(row.entry_px)}<small className="source-note">{formatPrice(row.mark_px)}</small></> },
            { key: "stop", label: "SL / TP", numeric: true, render: row => <>{formatPrice(row.stop_px)}<small className="source-note">{formatPrice(row.take_profit_px)}</small></> },
            { key: "leverage", label: "Leverage / mode", render: row => <>{formatLeverage(row.actual_leverage)}<small className="source-note">{asText(row.margin_mode).toUpperCase()}{row.leverage_mismatch ? " · differs from setting" : ""}</small></> },
            { key: "margin", label: "Margin · USDT", numeric: true, render: row => <>{formatAmount(row.margin_used)}<small className="source-note">{asText(row.margin_source)}</small></> },
            { key: "notional", label: "Notional", numeric: true, render: row => <>{formatAmount(row.notional, asText(row.notional_currency, ""))}<small className="source-note">{asText(row.notional_source)}</small></> },
            { key: "contracts", label: "Contracts", numeric: true, render: row => asText(row.exchange_contracts ?? row.contracts) },
            { key: "risk", label: "Risk at stop", numeric: true, render: row => <>{formatAmount(row.risk_at_stop)}<small className="source-note">{formatNumber(row.risk_pct)}% initial/current equity</small></> },
            { key: "pnl", label: "Unrealized PnL", numeric: true, render: row => formatMoney(row.upl) },
            { key: "duration", label: "Duration", render: row => formatDuration(row.duration_s) },
          ]}/>
        </DataState>
      </Panel>
      <Panel title="Instrument workspace" subtitle="Single chart, four timeframes; confirmed exchange candles">
        <div className="instrument-toolbar"><label className="filter-control"><span>Instrument</span><select value={symbol} onChange={e => setInstrument(e.target.value)}>{watchlist.map(item => <option key={item}>{item}</option>)}</select></label></div>
        {symbol ? <InstrumentChart key={symbol} instrument={symbol} markers={open.find(row => row.instrument === symbol) ?? {}}/> : null}
      </Panel>
    </DataState>
    {selected ? <TradeDetailDialog tradeId={selected} onClose={() => setSelected(null)}/> : null}
  </div>;
}
