import { useState } from "react";
import { useApi } from "../hooks/useApi";
import { asNumber, asRow, asRows, asText, parseJson, type Row } from "../lib/types";
import { formatNumber, formatPercent, formatR, formatTimestamp } from "../lib/format";
import { DataState, DataTable, Field, PageHeading, Panel, StatusBadge } from "../components/Primitives";
import { EvolutionPage } from "./EvolutionPage";
import { StrategiesPage } from "./StrategiesPage";

export function EvolutionWorkspace() {
  const api = useApi<unknown>("/api/evolution", 30_000);
  const [family, setFamily] = useState("");
  const [version, setVersion] = useState<number | null>(null);
  const [tab, setTab] = useState("Lifecycle");
  const data = asRow(api.data);
  const families = asRows(data?.families);
  const current = families.find(f => f.family === family) ?? families[0];
  const champion = asRow(current?.champion);
  const challenger = asRow(current?.challenger);
  const versions = asRows(current?.versions);
  const selected = versions.find(v => v.version === version) ?? challenger ?? champion;
  const evaluation = asRow(current?.evaluation);
  const challengerEvidence = asRow(parseJson(challenger?.evidence, {}));
  const metrics = asRow(parseJson(evaluation?.metrics, null)) ?? asRow(challengerEvidence?.validation);
  const evidence = asRow(parseJson(selected?.evidence, {}));
  const validation = selected?.version === challenger?.version ? metrics : asRow(evidence?.validation);
  const validationReasons = Array.isArray(validation?.reasons) ? validation.reasons.map(String) : [];
  const params = asRow(parseJson(selected?.params, {})) ?? {};
  const perf = asRow(current?.performance);
  const core = asRow(data?.strategyCore);
  if (core?.version === 1) return <EvolutionPage/>;
  return <div className="page">
    <PageHeading title="Evolution" description="Family-scoped evidence, immutable proposals and matched Champion versus Challenger validation." detail={<StatusBadge value={core?.baselineMode ? "FROZEN" : data?.evolutionEnabled === false ? "DISABLED" : data?.evolutionEnabled === true ? "ACTIVE" : "UNKNOWN"}/>}/>
    <div className="workstation-tabs">{["Lifecycle", "Strategies"].map(t => <button key={t} aria-pressed={tab === t} onClick={() => setTab(t)}>{t}</button>)}</div>
    {tab === "Strategies" ? <StrategiesPage/> : <DataState loading={api.loading} error={api.error} empty={!families.length} hasData={api.data !== null} emptyTitle="No Strategy Core V2 registry available" emptyDetail="The lifecycle appears after V2 strategy definitions are initialized.">
      <div className="workstation-tabs" aria-label="Strategy family">{families.map(f => <button key={String(f.family)} aria-pressed={current?.family === f.family} onClick={() => { setFamily(String(f.family)); setVersion(null); }}>{String(f.family).replaceAll("_", " ")}</button>)}</div>
      <Panel title={`${asText(current?.family)} · Champion V${asText(champion?.version)}`} subtitle="Evidence includes only net closed Demo trades from this engine, family and champion version">
        <div className="position-financials">
          <Field label="Eligible evidence" value={`${asText(current?.sample, "0")} / ${asText(current?.nextReview)} trades`}/>
          <Field label="Next proposal review" value={`${asText(current?.remaining)} additional trades`}/>
          <Field label="Net expectancy" value={formatR(perf?.expectancy_r)}/>
          <Field label="Profit factor" value={formatNumber(perf?.profit_factor)}/>
          <Field label="Modeled drawdown" value={formatPercent(perf?.max_drawdown_pct, 2, false)}/>
          <Field label="Challenger" value={challenger ? `V${challenger.version} · ${challenger.status}` : "None active"}/>
        </div>
        <div className="risk-form"><progress max={Number(current?.nextReview) || 1} value={Math.min(Number(current?.sample) || 0, Number(current?.nextReview) || 1)} aria-label="Evidence toward next review"/>
          {!challenger ? <span>No Challenger currently active. Next strategy review after {asText(current?.remaining)} additional eligible trades.</span> : <span>One active Challenger per family. New proposals wait for this validation lifecycle.</span>}
        </div>
      </Panel>
      {challenger ? <Panel title={`Challenger V${challenger.version}`} subtitle={asText(challenger.hypothesis)}>
        <div className="position-financials"><Field label="Changed parameter" value={asText(challenger.changed_parameter)}/><Field label="Parameter value" value={`${asText(challenger.old_value)} → ${asText(challenger.new_value)}`}/><Field label="Validation" value={<StatusBadge value={metrics?.state ?? challenger.status}/>}/></div>
        <div className="trace-list">{["Reviewer evidence", "Evolution hypothesis", "Critic", "Deterministic validator", "Historical / OOS / robustness", "Matched shadow", "Promote or reject"].map((label, index) => <div className="trace-step" key={label}><strong>{label}</strong><span>{index === 2 ? asText(challengerEvidence?.criticVerdict, "Unavailable") : index === 4 ? `${asText(metrics?.historicalTrades)} historical / ${asText(metrics?.outOfSampleTrades)} OOS trades` : index === 5 ? `Champion ${asText(metrics?.championShadowTrades)} · Challenger ${asText(metrics?.challengerShadowTrades)}` : index === 6 ? asText(challenger.status) : index === 0 ? `${asText(challengerEvidence?.sample)} eligible trades at proposal` : index === 1 ? asText(challenger.hypothesis) : "Bounded immutable parameter definition accepted"}</span></div>)}</div>
        <Comparison metrics={metrics}/>
        <div className="risk-form">{Array.isArray(metrics?.reasons) ? metrics.reasons.map((r, i) => <p key={i}>{String(r)}</p>) : <p>Waiting for first persisted validation result.</p>}</div>
      </Panel> : null}
      <Panel title="Version timeline" subtitle="Select a version to inspect its parent, proposal and evidence">
        <DataTable rows={[...versions].reverse()} rowKey={r => String(r.version)} minWidth={730} onRowClick={r => setVersion(Number(r.version))} columns={[
          { key: "version", label: "Version", render: r => `V${r.version}` },
          { key: "parent", label: "Parent", render: r => r.parent_version ? `V${r.parent_version}` : "Initial" },
          { key: "status", label: "State", render: r => <StatusBadge value={r.status}/> },
          { key: "change", label: "Parameter", render: r => asText(r.changed_parameter, "Initial parameters") },
          { key: "time", label: "Created", render: r => formatTimestamp(r.created_ts) },
          { key: "reason", label: "Lifecycle reason", render: r => asText(r.status_reason, "Inspect evidence") },
        ]}/>
      </Panel>
      {selected ? <Panel title={`Version V${selected.version} detail`} subtitle={asText(selected.hypothesis, "Initial strategy definition")}>
        <div className="position-financials"><Field label="Parent" value={asText(selected.parent_version, "Initial")}/><Field label="Evolution model" value={asText(evidence?.evolutionModel)}/><Field label="Critic model" value={asText(evidence?.criticModel)}/><Field label="Critic verdict" value={asText(evidence?.criticVerdict)}/><Field label="Evidence sample" value={asText(evidence?.sample)}/><Field label="State" value={<StatusBadge value={selected.status}/>}/></div>
        <div className="trace-list"><div className="trace-step"><strong>Lifecycle reason</strong><span>{asText(selected.status_reason, "Initial strategy definition")}</span></div><div className="trace-step"><strong>Validation reason</strong><span>{validationReasons.length ? validationReasons.join(" | ") : validation ? asText(selected.status_reason, "No validation reason recorded") : "No persisted validation for this version"}</span></div></div>
        {validation ? <div className="position-financials"><Field label="Validation state" value={<StatusBadge value={validation.state}/>}/><Field label="Historical trades" value={formatNumber(validation.historicalTrades, 0)}/><Field label="Historical net expectancy" value={asNumber(validation.historicalTrades) ? formatR(validation.historicalExpectancyR) : "N/A"}/><Field label="OOS trades" value={formatNumber(validation.outOfSampleTrades, 0)}/><Field label="OOS net expectancy" value={asNumber(validation.outOfSampleTrades) ? formatR(validation.outOfSampleExpectancyR) : "N/A"}/><Field label="Rolling OOS folds" value={formatNumber(asRow(validation.rollingOos)?.folds, 0)}/></div> : null}
        {validation && selected.version !== challenger?.version ? <Comparison metrics={validation}/> : null}
        <div className="position-financials">{Object.entries(params).map(([key,value]) => <Field key={key} label={key.replaceAll("_", " ")} value={formatNumber(value)}/>)}</div>
        <details className="technical"><summary>Technical evidence</summary><pre>{JSON.stringify({ evidence, validation }, null, 2)}</pre></details>
      </Panel> : null}
    </DataState>}
  </div>;
}

function Comparison({ metrics }: { metrics: Row | null }) {
  const pairs = asRow(metrics?.shadowBySymbol) ?? {};
  const championMeasured = (asNumber(metrics?.championShadowTrades) ?? 0) > 0;
  const challengerMeasured = (asNumber(metrics?.challengerShadowTrades) ?? 0) > 0;
  return <>
    <DataTable rows={[
      { name: "Matched shadow trades", champion: metrics?.championShadowTrades, challenger: metrics?.challengerShadowTrades },
      { name: "Net expectancy (R)", champion: championMeasured ? metrics?.championShadowExpectancyR : null, challenger: challengerMeasured ? metrics?.challengerShadowExpectancyR : null },
      { name: "Mean MFE (R)", champion: championMeasured ? asRow(metrics?.shadowMfeR)?.champion : null, challenger: challengerMeasured ? asRow(metrics?.shadowMfeR)?.challenger : null },
      { name: "Mean MAE (R)", champion: championMeasured ? asRow(metrics?.shadowMaeR)?.champion : null, challenger: challengerMeasured ? asRow(metrics?.shadowMaeR)?.challenger : null },
    ]} rowKey={r => String(r.name)} minWidth={520} columns={[
      { key: "name", label: "Metric", render: r => asText(r.name) },
      { key: "champion", label: "Champion shadow", numeric: true, render: r => formatNumber(r.champion) },
      { key: "challenger", label: "Challenger shadow", numeric: true, render: r => formatNumber(r.challenger) },
    ]}/>
    {Object.keys(pairs).length ? <DataTable rows={Object.entries(pairs).map(([symbol, value]) => ({ symbol, ...asRow(value) }))} rowKey={r => String(r.symbol)} minWidth={1040} columns={[
      { key: "symbol", label: "Symbol", render: r => String(r.symbol) },
      { key: "champion", label: "Champion net R", numeric: true, render: r => asNumber(asRow(r.champion)?.trades) ? formatR(asRow(r.champion)?.expectancyR) : "N/A" },
      { key: "challenger", label: "Challenger net R", numeric: true, render: r => asNumber(asRow(r.challenger)?.trades) ? formatR(asRow(r.challenger)?.expectancyR) : "N/A" },
      { key: "championPf", label: "Champion PF", numeric: true, render: r => asNumber(asRow(r.champion)?.trades) ? formatNumber(asRow(r.champion)?.profitFactor) : "N/A" },
      { key: "challengerPf", label: "Challenger PF", numeric: true, render: r => asNumber(asRow(r.challenger)?.trades) ? formatNumber(asRow(r.challenger)?.profitFactor) : "N/A" },
      { key: "championDrawdown", label: "Champion drawdown", numeric: true, render: r => asNumber(asRow(r.champion)?.trades) ? `${formatNumber(asRow(r.champion)?.maxDrawdownPct)}%` : "N/A" },
      { key: "challengerDrawdown", label: "Challenger drawdown", numeric: true, render: r => asNumber(asRow(r.challenger)?.trades) ? `${formatNumber(asRow(r.challenger)?.maxDrawdownPct)}%` : "N/A" },
    ]}/> : null}
  </>;
}
