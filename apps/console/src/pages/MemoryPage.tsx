import { useState } from "react";
import { useApi } from "../hooks/useApi";
import { formatNumber, formatPercent, formatR, formatTimestamp, toneFor } from "../lib/format";
import { asNumber, asRow, asRows, asText, parseJson, type Row } from "../lib/types";
import { Badge, DataState, DataTable, Evidence, Field, PageHeading, Panel, StatusBadge } from "../components/Primitives";

type MemoryTab = "Lessons" | "Regimes" | "Signals" | "Confidence";

export function MemoryPage() {
  const [tab, setTab] = useState<MemoryTab>("Lessons");
  const lessons = useApi<unknown>("/api/lessons");
  const strategies = useApi<unknown>("/api/strategies");
  const evolution = useApi<unknown>("/api/evolution");
  const strategyData = asRow(strategies.data);
  const evolutionData = asRow(evolution.data);

  return <div className="page">
    <PageHeading title="Memory" description="Evidence-backed lessons, regime outcomes, signal weights, and confidence calibration."/>
    <div className="memory-tabs" role="tablist" aria-label="Memory views">
      {(["Lessons", "Regimes", "Signals", "Confidence"] as const).map(item => <button key={item} role="tab" aria-selected={tab === item} className={tab === item ? "tab-active" : ""} onClick={() => setTab(item)}>{item}</button>)}
    </div>
    {tab === "Lessons" ? <Panel title="Lessons" subtitle="Reviewer hypotheses change status only after statistical validation">
      <DataState loading={lessons.loading} error={lessons.error} empty={!asRows(lessons.data).length} hasData={lessons.data !== null} emptyTitle="No lessons recorded" emptyDetail="The reviewer may propose lessons after trades close and are reviewed.">
        <DataTable caption="Validated trading lessons" rows={asRows(lessons.data)} rowKey={(row, index) => asText(row.lesson_id, String(index))} minWidth={920} columns={[
          { key: "statement", label: "Lesson", render: row => <span className="lesson-statement">{asText(row.statement)}</span> },
          { key: "status", label: "Status", render: row => <StatusBadge value={row.status}/> },
          { key: "scope", label: "Scope", render: row => [row.scope_strategy, row.scope_instrument, row.scope_regime].filter(Boolean).map(String).join(" / ") || "General" },
          { key: "observations", label: "Observations", numeric: true, render: row => formatNumber(row.observations, 0) },
          { key: "winloss", label: "Wins / losses", numeric: true, render: row => `${formatNumber(row.wins, 0)} / ${formatNumber(row.losses, 0)}` },
          { key: "expectancy", label: "Expectancy", numeric: true, render: row => <span className={toneFor(row.expectancy_r)}>{formatR(row.expectancy_r)}</span> },
          { key: "confidence", label: "Confidence", numeric: true, render: row => { const confidence = asNumber(row.confidence); return confidence === null ? "N/A" : `${formatNumber(confidence * 100, 0)}%`; } },
          { key: "updated", label: "Last updated", render: row => formatTimestamp(row.updated_ts) },
        ]}/>
      </DataState>
    </Panel> : null}
    {tab === "Regimes" ? <RegimeMemory data={asRow(strategyData?.regimeMatrix) ?? {}} loading={strategies.loading} error={strategies.error}/> : null}
    {tab === "Signals" ? <SignalMemory weights={asRow(strategyData?.weights) ?? {}} events={asRows(evolutionData?.events)} loading={strategies.loading || evolution.loading} error={strategies.error ?? evolution.error}/> : null}
    {tab === "Confidence" ? <ConfidenceMemory calibration={asRow(strategyData?.calibration)} loading={strategies.loading} error={strategies.error}/> : null}
  </div>;
}

function RegimeMemory({ data, loading, error }: { data: Row; loading: boolean; error: string | null }) {
  const regimes = Object.keys(data);
  const strategyNames = [...new Set(Object.values(data).flatMap(value => Object.keys(asRow(value) ?? {})))];
  const rows = strategyNames.map(strategy => {
    const row: Row = { strategy };
    for (const regime of regimes) row[regime] = aggregateRegime(asRow(asRow(data[regime])?.[strategy]) ?? {});
    return row;
  });
  return <Panel title="Regime memory" subtitle="Observed strategy expectancy by regime, aggregated across LONG and SHORT">
    <DataState loading={loading} error={error} empty={!rows.length} hasData={regimes.length > 0} emptyTitle="No regime evidence recorded" emptyDetail="Closed trades populate this matrix by strategy, regime, and direction.">
      <DataTable caption="Strategy performance by market regime" rows={rows} rowKey={row => String(row.strategy)} minWidth={Math.max(620, 230 + regimes.length * 160)} columns={[
        { key: "strategy", label: "Strategy", render: row => asText(row.strategy) },
        ...regimes.map(regime => ({ key: regime, label: regime.replaceAll("_", " "), render: (row: Row) => <RegimeCell value={asRow(row[regime])}/> })),
      ]}/>
    </DataState>
  </Panel>;
}

function RegimeCell({ value }: { value: Row | null }) {
  if (!value || !Number(value.trades)) return <span className="muted-small">No sample</span>;
  const winRate = asNumber(value.winRate);
  return <span className="regime-cell"><strong className={toneFor(value.expectancy)}>{formatR(value.expectancy)}</strong><small>{formatNumber(value.trades, 0)} trades | {winRate === null ? "N/A" : formatPercent(winRate * 100, 0)} wins</small></span>;
}

function aggregateRegime(sides: Row): Row | null {
  let trades = 0, wins = 0, expectancySum = 0;
  for (const value of Object.values(sides)) {
    const side = asRow(value) ?? {};
    const count = Number(side.trades) || 0;
    trades += count;
    wins += Number(side.wins) || 0;
    expectancySum += (Number(side.expectancy_r) || 0) * count;
  }
  return trades ? { trades, wins, winRate: wins / trades, expectancy: expectancySum / trades } : null;
}

function SignalMemory({ weights, events, loading, error }: { weights: Row; events: Row[]; loading: boolean; error: string | null }) {
  const lastUpdate = events.find(event => event.kind === "WEIGHTS");
  const payload = lastUpdate ? asRow(parseJson(lastUpdate.payload, {})) ?? {} : {};
  const before = asRow(payload.before) ?? {};
  const after = asRow(payload.after) ?? {};
  const signals = Object.keys(weights);
  return <Panel title="Signal weights" subtitle="Current coefficients and the most recent recorded adjustment">
    <DataState loading={loading} error={error} empty={!signals.length} hasData={signals.length > 0} emptyTitle="No signal weights recorded">
      <DataTable caption="Signal weight history" rows={signals.map(signal => ({ signal }))} rowKey={row => String(row.signal)} minWidth={760} columns={[
        { key: "signal", label: "Signal", render: row => asText(row.signal) },
        { key: "previous", label: "Previous weight", numeric: true, render: row => before[String(row.signal)] === undefined ? "Not recorded" : formatNumber(before[String(row.signal)]) },
        { key: "current", label: "Current weight", numeric: true, render: row => formatNumber(weights[String(row.signal)]) },
        { key: "delta", label: "Change", numeric: true, render: row => {
          const key = String(row.signal), current = Number(weights[key]), previous = Number(before[key]);
          return Number.isFinite(previous) ? <span className={toneFor(current - previous)}>{formatNumber(current - previous, 2)}</span> : "Not recorded";
        } },
        { key: "evidence", label: "Evidence", numeric: true, render: () => lastUpdate ? `${formatNumber(payload.trades, 0)} trades at update` : "Not recorded" },
        { key: "updated", label: "Last update", render: () => lastUpdate ? formatTimestamp(lastUpdate.ts) : "Not recorded" },
      ]}/>
      {lastUpdate && Object.keys(after).length ? <p className="data-footnote">Previous and updated weights are read from the latest persisted WEIGHTS event. Current values come from the active weights record.</p> : <p className="data-footnote">No weight-change event is available yet. Previous values and update dates are not inferred.</p>}
    </DataState>
  </Panel>;
}

function ConfidenceMemory({ calibration, loading, error }: { calibration: Row | null; loading: boolean; error: string | null }) {
  const buckets = asRows(calibration?.buckets);
  const sample = Number(calibration?.sample) || 0;
  const canShow = buckets.some(bucket => Number(bucket.n) > 0);
  return <Panel title="Confidence calibration" subtitle="AI confidence bins compared with realized win rate">
    <DataState loading={loading} error={error} empty={!calibration || !canShow} hasData={calibration !== null} emptyTitle="Not enough closed trades to calculate confidence calibration" emptyDetail={`${sample} / 10 observations required before a calibration table is created.`}>
      <div className="calibration-summary"><div><span>Calibration sample</span><strong className="mono">{sample} trades</strong></div><Evidence sample={sample}/><span className="muted-small">Updated {formatTimestamp(calibration?.updatedTs)}</span></div>
      <div className="calibration-chart" role="img" aria-label="Actual win rate within each recorded AI confidence bucket">
        <div className="calibration-axis"><span>Confidence bucket</span><span>Observed win rate</span></div>
        {buckets.filter(bucket => Number(bucket.lo) >= 0.5).map(bucket => {
          const n = Number(bucket.n) || 0;
          const lo = Number(bucket.lo) * 100, hi = Number(bucket.hi) * 100;
          const label = `${lo.toFixed(0)}–${hi.toFixed(0)}%`;
          const winRate = Number(bucket.winRate) || 0;
          const midpoint = (lo + hi) / 200;
          const calibrationLabel = n < 5 ? "Insufficient sample" : midpoint > winRate ? "Overconfident" : midpoint < winRate ? "Underconfident" : "Aligned";
          return <div className="calibration-row" key={label}>
            <span className="calibration-range">{label}</span>
            <div className="calibration-bar-track"><span style={{ width: n ? `${Math.max(0, Math.min(100, winRate * 100))}%` : "0%" }}/></div>
            <strong className="mono">{n ? formatPercent(winRate * 100, 0) : "N/A"}</strong>
            <span className="calibration-count">{n ? `${n} trades` : "No sample"}</span>
            <Badge tone={n < 5 ? "neutral" : midpoint > winRate ? "warning" : "info"}>{calibrationLabel}</Badge>
          </div>;
        })}
      </div>
      <p className="data-footnote">Observed win rate is defined by positive result R. Labels are withheld for buckets with fewer than five observations.</p>
    </DataState>
  </Panel>;
}
