import { LockKeyhole } from "lucide-react";
import { useState } from "react";
import { useApi } from "../hooks/useApi";
import { asRow, asRows, asText, type ApiState, type Row } from "../lib/types";
import { Badge, DataState, Field, PageHeading, Panel, StatusBadge } from "../components/Primitives";
import { RiskSettings } from "../components/RiskSettings";
import { TradingSettings } from "../components/TradingSettings";

export function SettingsPage({ status }: { status: ApiState<Row> }) {
  const api = useApi<unknown>("/api/settings", 30_000);
  const [tab, setTab] = useState("Trading");
  const settings = asRow(api.data);
  const exchange = asRow(settings?.exchange) ?? {};
  const learning = asRow(settings?.learning) ?? {};

  return <div className="page">
    <PageHeading title="Settings" description="Edit operational trading and risk settings. Demo execution and absolute safety boundaries remain enforced." detail={<Badge tone="info"><LockKeyhole size={12}/> OKX DEMO</Badge>}/>
    <div className="workstation-tabs" aria-label="Settings section">{["Trading", "Risk", "General"].map(name => <button key={name} aria-pressed={tab === name} onClick={() => setTab(name)}>{name}</button>)}</div>
    {tab === "Trading" ? <TradingSettings positions={asRows(status.data?.openPositions)} onSaved={() => status.reload(true)}/> : tab === "Risk" ? <RiskSettings equity={status.data?.equity} positions={asRows(status.data?.openPositions)} onSaved={() => status.reload(true)}/> : <DataState loading={api.loading} error={api.error} empty={!settings} hasData={api.data !== null} emptyTitle="Settings are not available" emptyDetail="The console could not retrieve its current configuration.">
      <div className="settings-grid">
        <Panel title="Exchange" subtitle="Environment is fixed for this system">
          <Field label="Exchange" value={asText(exchange.exchange)}/>
          <Field label="Environment" value={<StatusBadge value={exchange.environment}/>}/>
          <Field label="Mode" value="Simulated trading only" mono={false}/>
          <p className="settings-note">{asText(exchange.note)}</p>
        </Panel>
        <Panel title="Learning and evolution" subtitle="Current schedule from the existing settings endpoint">
          <Field label="Post-trade review" value={learning.reviewEvery ? "Every closed trade" : "Disabled"} mono={false}/>
          <Field label="Signal evolution" value={`Every ${asText(learning.signalInterval)} closed trades`} mono={false}/>
          <Field label="Strategy evolution" value={`Every ${asText(learning.strategyInterval)} closed trades`} mono={false}/>
          <Field label="Minimum validation sample" value={`${asText(learning.minSample)} trades`} mono={false}/>
          <Field label="Maximum weight change" value={`±${asText(learning.maxWeightChangePct)}%`} mono={false}/>
          <Field label="Parameter changes per challenger" value={asText(learning.maxParamChanges)} mono={false}/>
        </Panel>
        <Panel title="Appearance" subtitle="Operator workstation display">
          <Field label="Theme" value="Light workspace / navy navigation" mono={false}/>
          <p className="settings-note">Compact tables and a light workspace support desktop monitoring.</p>
        </Panel>
      </div>
      <Panel title="AI providers" subtitle="Role configuration is available in AI → Role settings"><p className="settings-note">Configure Gate, Scalp, Reviewer, Evolution and Critic independently, including provider credentials and request budgets.</p></Panel>
      <Panel title="Locked controls" subtitle="These values are not editable by AI output or console forms">
        <div className="locked-control-list">{(Array.isArray(settings?.controlsLocked) ? settings.controlsLocked : []).map((item, index) => <Badge tone="neutral" key={`${String(item)}-${index}`}><LockKeyhole size={12}/>{asText(item)}</Badge>)}</div>
      </Panel>
    </DataState>}
  </div>;
}
