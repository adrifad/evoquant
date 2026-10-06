import { useMemo } from "react";
import { useApi } from "../hooks/useApi";
import { formatNumber, formatPercent, formatR, formatTimestamp, toneFor } from "../lib/format";
import { asNumber, asRow, asRows, asText, parseJson, type Row } from "../lib/types";
import { Badge, DataState, Evidence, PageHeading, Panel, StatusBadge } from "../components/Primitives";

export function EvolutionPage() {
  const api = useApi<unknown>("/api/evolution");
  const data = asRow(api.data);
  const strategies = asRows(data?.strategies);
  const events = asRows(data?.events);
  const comparisons = asRows(data?.comparisons);
  const champion = strategies.find(item => item.status === "CHAMPION");
  const challenger = strategies.find(item => item.status === "CHALLENGER" || item.status === "TESTING");
  const parent = challenger ? strategies.find(item => item.name === challenger.name && Number(item.version) === Number(challenger.parent_version)) : undefined;
  const changes = useMemo(() => parameterChanges(parent, challenger), [parent, challenger]);
  const comparison = comparisons.find(item => asText(item.challenger) === versionLabel(challenger)) ?? comparisons[0];
  const recentEvents = [...events].sort((a, b) => String(b.ts).localeCompare(String(a.ts))).slice(0, 24);

  return <div className="page evolution-page">
    <PageHeading title="Evolution" description="Review how a versioned challenger is tested against its champion before deterministic promotion." detail={<Badge tone="info">CONTROLLED PROMOTION</Badge>}/>
    <DataState loading={api.loading} error={api.error} empty={!strategies.length && !comparisons.length} hasData={api.data !== null} emptyTitle="No evolution evidence yet" emptyDetail="Strategy versions and comparisons will appear as the system records them.">
      <section className="version-pair" aria-label="Current champion and challenger">
        <VersionCard label="Current champion" strategy={champion} emphasis="champion"/>
        <div className="comparison-spine"><span>evaluated against</span></div>
        <VersionCard label="Active challenger" strategy={challenger} emphasis="challenger"/>
      </section>
      {challenger ? <Panel title="Proposed parameter changes" subtitle={asText(challenger.hypothesis, "No hypothesis recorded.")} className="change-panel">
        {changes.length ? <div className="change-list">{changes.map(change => <div className="parameter-change" key={change.name}><span>{change.name.replaceAll("_", " ")}</span><strong className="mono">{formatNumber(change.before)} <span>to</span> {formatNumber(change.after)}</strong></div>)}</div> : <div className="empty-state"><strong>No parameter delta available</strong><span>The version record does not contain comparable parent parameters.</span></div>}
      </Panel> : null}

      {comparison ? <ComparisonPanel comparison={comparison}/> : <Panel title="Champion comparison" subtitle="Historical comparison records">
        <div className="empty-state"><strong>No champion comparison recorded</strong><span>A comparison appears after the evaluation pipeline runs.</span></div>
      </Panel>}

      <Panel title="Evolution timeline" subtitle="Version creation and promotion decisions, newest first">
        <div className="timeline">
          {[...strategies.map(strategy => ({ ts: strategy.created_ts, kind: "VERSION_CREATED", payload: { name: strategy.name, version: strategy.version, status: strategy.status, hypothesis: strategy.hypothesis } })), ...recentEvents].sort((a, b) => String(b.ts).localeCompare(String(a.ts))).map((event, index) => {
            const payload = asRow(parseJson(event.payload, {})) ?? {};
            const headline = event.kind === "PROMOTION" ? "Candidate promoted" : event.kind === "PROMOTION_REJECTED" ? "Candidate rejected" : event.kind === "WEIGHTS" ? "Signal weights updated" : event.kind === "VERSION_CREATED" ? "Strategy version created" : asText(event.kind);
            const detail = event.kind === "VERSION_CREATED" ? `${asText(payload.name)} V${asText(payload.version)} | ${asText(payload.status)}` : summarizeEvolutionEvent(event.kind, payload);
            return <article className="timeline-entry" key={`${asText(event.ts)}-${asText(event.kind)}-${index}`}>
              <div className="timeline-marker"/><div className="timeline-copy"><div><strong>{headline}</strong><StatusBadge value={event.kind === "PROMOTION" ? "PROMOTED" : event.kind === "PROMOTION_REJECTED" ? "REJECTED" : payload.status ?? event.kind}/></div><p>{event.kind === "VERSION_CREATED" ? asText(payload.hypothesis, detail) : detail}</p><time>{formatTimestamp(event.ts)}</time></div>
            </article>;
          })}
          {!strategies.length && !recentEvents.length ? <div className="empty-state"><strong>No timeline events yet</strong></div> : null}
        </div>
      </Panel>
    </DataState>
  </div>;
}

function VersionCard({ label, strategy, emphasis }: { label: string; strategy?: Row; emphasis: string }) {
  const params = asRow(parseJson(strategy?.params, {})) ?? {};
  return <section className={`version-card version-${emphasis}`}>
    <div className="version-card-head"><span>{label}</span>{strategy ? <StatusBadge value={strategy.status}/> : <Badge tone="neutral">NONE</Badge>}</div>
    {strategy ? <>
      <h2>{asText(strategy.name)} <span>V{asText(strategy.version)}</span></h2>
      <p>{strategy.parent_version ? `Parent version V${asText(strategy.parent_version)}` : "Baseline version"}</p>
      <div className="version-params">{Object.entries(params).map(([key, value]) => <div key={key}><span>{key.replaceAll("_", " ")}</span><strong className="mono">{formatNumber(value)}</strong></div>)}</div>
    </> : <div className="version-missing">{emphasis === "champion" ? "No champion record available." : "No active challenger is being evaluated."}</div>}
  </section>;
}

function ComparisonPanel({ comparison }: { comparison: Row }) {
  const champion = asRow(parseJson(comparison.champion_metrics, {})) ?? {};
  const challenger = asRow(parseJson(comparison.challenger_metrics, {})) ?? {};
  const reasonValues = parseJson<unknown>(comparison.reasons, []);
  const reasonList = Array.isArray(reasonValues) ? reasonValues.map(reason => asText(reason)) : [];
  const metrics = [
    ["Evaluation trades", "trades", (value: unknown) => formatNumber(value, 0)],
    ["Win rate", "win_rate", (value: unknown) => { const n = asNumber(value); return n === null ? "N/A" : formatPercent(n * 100, 1); }],
    ["Expectancy", "expectancy_r", formatR],
    ["Profit factor", "profit_factor", formatNumber],
    ["Max drawdown", "max_drawdown_pct", formatPercent],
    ["Average win", "avg_win_r", formatR],
    ["Average loss", "avg_loss_r", formatR],
  ] as const;
  const promoted = Number(comparison.promoted) === 1 || comparison.promoted === true;
  return <Panel title="Champion comparison" subtitle={`${asText(comparison.champion)} compared with ${asText(comparison.challenger)}`} className="comparison-panel">
    <div className="comparison-outcome"><div><span>Evaluation outcome</span><StatusBadge value={promoted ? "PROMOTED" : reasonList.length ? "NOT PROMOTED" : "AWAITING EVIDENCE"}/></div><time>{formatTimestamp(comparison.ts)}</time></div>
    <div className="comparison-table-wrap"><table className="comparison-table"><thead><tr><th>Metric</th><th>{asText(comparison.champion)}</th><th>{asText(comparison.challenger)}</th></tr></thead><tbody>
      {metrics.map(([label, key, format]) => { const championValue = asNumber(champion[key]); const challengerValue = asNumber(challenger[key]); return <tr key={key}><th scope="row">{label}</th><td className="mono">{championValue === null ? "N/A" : format(championValue)}</td><td className={`mono ${championValue === null || challengerValue === null ? "neutral" : toneFor(challengerValue - championValue)}`}>{challengerValue === null ? "N/A" : format(challengerValue)}</td></tr>; })}
    </tbody></table></div>
    <div className="comparison-evidence"><Evidence sample={challenger.trades}/><span>Historical backtest sample. Live demo-forward counts are not part of this comparison response.</span></div>
    <div className="comparison-reasons"><h3>{promoted ? "Promotion evidence" : "Evaluation notes"}</h3>{reasonList.length ? <ul>{reasonList.map((reason, index) => <li key={`${index}-${reason}`}>{reason}</li>)}</ul> : <p>{promoted ? "The comparison passed the configured deterministic promotion checks." : "No rejection reason was stored with this record."}</p>}</div>
  </Panel>;
}

function parameterChanges(parent?: Row, challenger?: Row): Array<{ name: string; before: number; after: number }> {
  if (!parent || !challenger) return [];
  const oldParams = asRow(parseJson(parent.params, {})) ?? {};
  const nextParams = asRow(parseJson(challenger.params, {})) ?? {};
  return Object.keys(nextParams).flatMap(name => {
    const before = Number(oldParams[name]), after = Number(nextParams[name]);
    return Number.isFinite(before) && Number.isFinite(after) && before !== after ? [{ name, before, after }] : [];
  });
}

function versionLabel(strategy?: Row): string | null {
  return strategy ? `${asText(strategy.name)}_V${asText(strategy.version)}` : null;
}

function summarizeEvolutionEvent(kind: unknown, payload: Row): string {
  const event = String(kind ?? "");
  if (event === "PROMOTION") return `${asText(payload.challenger)} promoted after deterministic comparison.`;
  if (event === "PROMOTION_REJECTED") {
    const reasons = parseJson<unknown>(payload.reasons, []);
    return Array.isArray(reasons) && reasons.length ? reasons.map(item => asText(item)).join("; ") : `${asText(payload.challenger)} was not promoted.`;
  }
  if (event === "WEIGHTS") return `Signal weights updated using ${asText(payload.tradesAtRun, "unreported")} closed trades.`;
  return "Evolution event recorded.";
}
