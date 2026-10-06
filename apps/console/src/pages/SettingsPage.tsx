import { useEffect, useState, type FormEvent } from "react";
import { LockKeyhole } from "lucide-react";
import { useApi } from "../hooks/useApi";
import { formatNumber } from "../lib/format";
import { asRow, asText, type ApiState, type Row } from "../lib/types";
import { Badge, DataState, Field, PageHeading, Panel, StatusBadge } from "../components/Primitives";

export function SettingsPage({ status }: { status: ApiState<Row> }) {
  const api = useApi<unknown>("/api/settings", 30_000);
  const settings = asRow(api.data);
  const exchange = asRow(settings?.exchange) ?? {};
  const llm = asRow(settings?.llm) ?? {};
  const learning = asRow(settings?.learning) ?? {};
  const limits = asRow(status.data?.limits) ?? {};
  const models = Array.isArray(llm.models) ? llm.models.map(String) : [];
  const [baseUrl, setBaseUrl] = useState("");
  const [model, setModel] = useState("");
  const [temperature, setTemperature] = useState("0.2");
  const [apiKey, setApiKey] = useState("");
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    if (dirty || !settings) return;
    setBaseUrl(asText(llm.baseUrl, ""));
    setModel(asText(llm.model, ""));
    setTemperature(String(llm.temperature ?? 0.2));
  }, [dirty, settings, llm.baseUrl, llm.model, llm.temperature]);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSaving(true); setMessage(null);
    const body: Row = { LLM_BASE_URL: baseUrl, model, temperature: Number(temperature) };
    if (apiKey) body.apiKey = apiKey;
    try {
      const response = await fetch("/api/settings", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const result = await response.json() as Row;
      if (!response.ok) throw new Error(asText(result.error, `Request failed (${response.status})`));
      setApiKey(""); setDirty(false); setMessage(asText(result.note, "Settings saved."));
      await api.reload();
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : "Settings could not be saved.");
    } finally {
      setSaving(false);
    }
  };

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
        <Panel title="AI Provider" subtitle="Only provider settings already supported by the API are editable">
          <form className="provider-form" onSubmit={event => void submit(event)}>
            <Field label="Provider" value={asText(llm.provider)} mono={false}/>
            <label className="form-field"><span>Base URL</span><input value={baseUrl} onChange={event => { setDirty(true); setBaseUrl(event.target.value); }} autoComplete="url"/></label>
            <label className="form-field"><span>Model</span><input list="available-models" value={model} onChange={event => { setDirty(true); setModel(event.target.value); }} autoComplete="off"/><datalist id="available-models">{models.map(name => <option value={name} key={name}/>)}</datalist></label>
            <label className="form-field"><span>Temperature</span><input type="number" min="0" max="1" step="0.1" value={temperature} onChange={event => { setDirty(true); setTemperature(event.target.value); }}/></label>
            <Field label="Saved API key" value={asText(llm.apiKeyMasked, "Not configured")} mono={false}/>
            <label className="form-field"><span>Replace API key (optional)</span><input type="password" value={apiKey} onChange={event => setApiKey(event.target.value)} autoComplete="new-password" placeholder="Leave blank to keep current key"/></label>
            <div className="form-actions"><button className="primary-button" type="submit" disabled={saving}>{saving ? "Saving" : "Save provider settings"}</button>{message ? <span role="status" className="form-message">{message}</span> : null}</div>
            <p className="settings-note">A new key is sent only when you enter one. The server does not return saved keys to the browser.</p>
          </form>
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
      <Panel title="Locked controls" subtitle="These values are not editable by AI output or console forms">
        <div className="locked-control-list">{(Array.isArray(settings?.controlsLocked) ? settings.controlsLocked : []).map((item, index) => <Badge tone="neutral" key={`${String(item)}-${index}`}><LockKeyhole size={12}/>{asText(item)}</Badge>)}</div>
      </Panel>
    </DataState>
  </div>;
}
