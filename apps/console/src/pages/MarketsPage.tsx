import { useApi } from "../hooks/useApi";
import { formatNumber, formatPrice, formatTimestamp, toneFor } from "../lib/format";
import { asRow, asRows, asText, type ApiState, type Row } from "../lib/types";
import { DataState, DataTable, DividerLabel, Field, PageHeading, Panel, StatusBadge } from "../components/Primitives";
import { MarketChart } from "../components/MarketChart";

export function MarketsPage({ status }: { status: ApiState<Row> }) {
  const market = useApi<unknown>("/api/market");
  const candles = useApi<unknown>(`/api/candles?limit=120&instId=${encodeURIComponent(asText(status.data?.instrument, "BTC-USDT-SWAP"))}`);
  const d = asRow(market.data);
  const snapshot = asRow(d?.snapshot);
  const scanner = asRows(d?.scan);
  const weights = asRow(d?.weights) ?? {};

  return <div className="page">
    <PageHeading title="Markets" description="Inspect the market inputs and regime used by the current decision cycle." detail={<span className="muted-small">Updated {formatTimestamp(d?.updatedAt)}</span>}/>
    <Panel title="Market chart" subtitle={`${asText(status.data?.instrument)} | ${asText(status.data?.timeframe)}`} className="chart-panel">
      <DataState loading={candles.loading} error={candles.error} empty={asRows(candles.data).length < 2} hasData={candles.data !== null} emptyTitle="Waiting for confirmed candles" emptyDetail="Market data is stored after each confirmed exchange candle.">
        <MarketChart candles={asRows(candles.data)} markers={asRow(status.data?.openPosition) ?? {}}/>
      </DataState>
    </Panel>
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
        <Panel title="Watchlist scanner" subtitle="Current instrument evaluations">
          <DataState loading={market.loading} error={market.error} empty={!scanner.length} hasData={market.data !== null} emptyTitle="Scanner is waiting for a market tick">
            <DataTable caption="Watchlist scanner" rows={scanner} rowKey={(row, index) => asText(row.instrument, String(index))} minWidth={640} columns={[
              { key: "instrument", label: "Instrument", render: row => asText(row.instrument) },
              { key: "regime", label: "Regime", render: row => <StatusBadge value={row.regime}/> },
              { key: "price", label: "Price", numeric: true, render: row => formatPrice(row.price) },
              { key: "score", label: "Score", numeric: true, render: row => <span className={toneFor(row.score)}>{formatNumber(row.score)}</span> },
              { key: "strategy", label: "Strategy", render: row => asText(row.strategy) },
              { key: "tradable", label: "Tradable", render: row => <StatusBadge value={row.tradable ? "YES" : "NO"}/> },
            ]}/>
          </DataState>
        </Panel>
      </div>
    </DataState>
  </div>;
}
