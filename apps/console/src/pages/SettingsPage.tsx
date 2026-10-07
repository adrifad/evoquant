import { LockKeyhole } from "lucide-react";
import { AiRoleSettings } from "../components/AiRoleSettings";
import { useApi } from "../hooks/useApi";
import { formatNumber } from "../lib/format";
import { asRow, asText, type ApiState, type Row } from "../lib/types";
import { Badge, DataState, Field, PageHeading, Panel, StatusBadge } from "../components/Primitives";

export function SettingsPage({ status }: { status: ApiState<Row> }) {
  const api = useApi<unknown>("/api/settings", 30_000);
  const settings = asRow(api.data);
  const exchange = asRow(settings?.exchange) ?? {};
  const learning = asRow(settings?.learning) ?? {};
  const limits = asRow(status.data?.limits) ?? {};

  return <div className="page">
    <PageHeading title="Settings" description="Configuration is grouped by responsibility. Exchange and hard risk controls stay locked to Demo safety rules." detail={<Badge tone="info"><LockKeyhole size={12}/> DEMO LOCKED</Badge>}/>
    <DataState loading={api.loading} error={api.error} empty={!settings} hasData={api.data !== null} emptyTitle="Settings are not available" emptyDetail="The console could not retrieve its current configuration.">
      <div className="settings-grid">
        <Panel title="Exchange" subtitle="Environment is fixed for this system">
          <Field label="Exchange" value={asText(exchange.exchange)}/>
          <Field label="Environment" value={<StatusBadge value={exchange.environment}/>}/>
          <Field label="Mode" value="Simulated trading only" mono={false}/>
          <p className="settings-note">{asText(exchange.note)}</p>
        </Panel>
        <Panel title="Trading" subtitle="Current operating context">
          <Field label="Instrument" value={asText(status.data?.instrument)} />
          <Field label="Timeframe" value={asText(status.data?.timeframe)} />
          <Field label="Leverage" value="Configured in trading settings, not returned by this API" mono={false}/>
          <Field label="Position mode" value="Not returned by settings API" mono={false}/>
        </Panel>
        <Panel title="Risk" subtitle="Hard limits are read-only in the console">
          <Field label="Risk per trade" value={`${formatNumber(limits.risk_per_trade_pct)}%`}/>
          <Field label="Maximum daily loss" value={`${formatNumber(limits.max_daily_loss_pct)}%`}/>
          <Field label="Maximum drawdown" value={`${formatNumber(limits.max_drawdown_pct)}%`}/>
          <Field label="Maximum leverage" value={`${formatNumber(limits.max_leverage, 0)}x`}/>
          <Field label="Maximum positions" value={formatNumber(limits.max_concurrent_positions, 0)}/>
          <div className="locked-note"><span>READ ONLY</span><span>Hard limits are not editable here.</span></div>
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
          <Field label="Theme" value="Dark, fixed" mono={false}/>
          <p className="settings-note">The dark theme is fixed for long-session monitoring. There is no partial theme toggle.</p>
        </Panel>
      </div>
      <AiRoleSettings />
      <Panel title="Locked controls" subtitle="These values are not editable by AI output or console forms">
        <div className="locked-control-list">{(Array.isArray(settings?.controlsLocked) ? settings.controlsLocked : []).map((item, index) => <Badge tone="neutral" key={`${String(item)}-${index}`}><LockKeyhole size={12}/>{asText(item)}</Badge>)}</div>
      </Panel>
    </DataState>
  </div>;
}
