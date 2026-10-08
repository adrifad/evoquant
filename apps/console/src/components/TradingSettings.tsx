import { useState, type FormEvent } from "react";
import { useApi } from "../hooks/useApi";
import { asNumber, asRow, asRows, asText, parseJson, type Row } from "../lib/types";
import { formatLeverage, formatTimestamp } from "../lib/format";
import { DataState, DataTable, Field, Panel } from "./Primitives";

const keys = ["instrument_id", "leverage_default", "leverage_cap", "sizing_mode", "position_pct"] as const;

export function TradingSettings({ positions, onSaved }: { positions: Row[]; onSaved: () => Promise<void> }) {
  const api = useApi<Row>("/api/trading", 30_000);
  const [draft, setDraft] = useState<Record<string, string> | null>(null);
  const [editingRevision, setEditingRevision] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const current = asRow(api.data?.settings) ?? {};
  const constraints = asRow(api.data?.constraints) ?? {};
  const values = draft ?? Object.fromEntries(keys.map(key => [key, asText(current[key], "")]));
  const staleDraft = draft !== null && editingRevision !== asNumber(api.data?.revision);
  const change = (key: string, value: string) => {
    if (!draft) setEditingRevision(asNumber(api.data?.revision));
    setDraft({ ...values, [key]: value }); setNotice(null);
  };
  const save = async (event: FormEvent) => {
    event.preventDefault();
    const settings = { instrument_id: values.instrument_id, leverage_default: Number(values.leverage_default),
      leverage_cap: Number(values.leverage_cap), sizing_mode: values.sizing_mode, position_pct: Number(values.position_pct) };
    const increase = settings.leverage_default > Number(current.leverage_default) || settings.leverage_cap > Number(current.leverage_cap)
      || settings.position_pct > Number(current.position_pct) || settings.sizing_mode !== current.sizing_mode;
    if (increase && !window.confirm(`Change new-entry configuration to ${settings.leverage_default}x leverage (cap ${settings.leverage_cap}x), ${settings.sizing_mode}, ${settings.position_pct}% allocation? Deterministic risk limits still apply.`)) return;
    setSaving(true); setNotice(null);
    try {
      const response = await fetch("/api/trading", { method: "PUT", headers: { "content-type": "application/json" },
        body: JSON.stringify({ revision: editingRevision ?? api.data?.revision, settings, confirmIncrease: increase }) });
      const result = await response.json() as Row;
      if (!response.ok) throw new Error(asText(result.error, "Trading settings could not be saved."));
      api.applyResponse(result);
      setDraft(null); setEditingRevision(null); await api.reload(true); await onSaved();
      setNotice("Saved. New entries use these settings. Open positions retain their size, leverage and protection.");
    } catch (error) { setNotice(error instanceof Error ? error.message : "Save failed."); }
    finally { setSaving(false); }
  };
  const actualLeverage = asNumber(api.data?.effective_leverage);
  const discrepancies = positions.filter(p => actualLeverage !== null && Number(p.actual_leverage) > actualLeverage);
  return <DataState loading={api.loading} error={api.error} empty={!api.data} hasData={Boolean(api.data)} emptyTitle="Trading configuration unavailable">
    <div className="risk-editor trading-editor">
      <Panel title="Trading configuration" subtitle="Entry settings, validated and audited by the server">
        <form className="risk-form trading-form" onSubmit={event => void save(event)}>
          <label className="risk-form-row"><span>Primary instrument</span><select required value={values.instrument_id} onChange={e => change("instrument_id", e.target.value)} disabled={saving}>{(Array.isArray(constraints.instruments) ? constraints.instruments : []).map(symbol => <option key={String(symbol)} value={String(symbol)}>{String(symbol)}</option>)}</select><small>Watchlist anchor</small></label>
          <label className="risk-form-row"><span>Entry leverage</span><input type="number" required min={1} max={Number(constraints.max_leverage)} step={1} value={values.leverage_default} onChange={e => change("leverage_default", e.target.value)} disabled={saving}/><small>x · default ≤ cap</small></label>
          <label className="risk-form-row"><span>Trading leverage cap</span><input type="number" required min={1} max={Number(constraints.max_leverage)} step={1} value={values.leverage_cap} onChange={e => change("leverage_cap", e.target.value)} disabled={saving}/><small>x · ceiling {asText(constraints.max_leverage)}</small></label>
          <label className="risk-form-row"><span>Swing sizing mode</span><select value={values.sizing_mode} onChange={e => change("sizing_mode", e.target.value)} disabled={saving}><option value="percent_of_equity">Percent of equity</option><option value="risk_based">Risk based</option></select><small>New swing entries</small></label>
          <label className="risk-form-row"><span>Swing notional allocation</span><input type="number" required min={Number(constraints.min_position_pct)} max={Number(constraints.max_position_pct)} step="any" value={values.position_pct} onChange={e => change("position_pct", e.target.value)} disabled={saving}/><small>% of equity</small></label>
          <p className="muted-small">Percent of equity sets target notional, not margin or loss at stop. Risk based sizes from stop distance and the Risk settings. Both remain capped by deterministic risk. Allocation is stored for percent-of-equity mode; Scalp keeps its own allocation.</p>
          {staleDraft ? <p className="inline-warning">Trading settings changed while editing. Reload before saving.</p> : null}
          <div className="risk-actions"><button className="primary-button" type="submit" disabled={saving || !draft || staleDraft}>{saving ? "Saving…" : "Save trading settings"}</button><button className="secondary-button" type="button" disabled={saving} onClick={() => { setDraft(null); setEditingRevision(null); setNotice(null); void api.reload(); }}>Reload saved values</button></div>
          {notice ? <p role="status">{notice}</p> : null}
        </form>
      </Panel>
      <Panel title="Execution context" subtitle="Current effective settings and engine constraints">
        <div className="risk-form">
          <Field label="Effective leverage for new entries" value={formatLeverage(actualLeverage)}/>
          <Field label="Strategy timeframe" value={asText(api.data?.timeframe)}/>
          <Field label="Margin mode" value={asText(api.data?.margin_mode).toUpperCase()}/>
          <Field label="Position mode" value={asText(api.data?.position_mode)}/>
          <p className="muted-small">Effective leverage is the lowest of entry leverage, trading cap and operational risk cap. The primary instrument changes the anchor; the bot continues scanning its configured watchlist.</p>
          <p className="muted-small">Timeframe and execution modes are read-only here. Their schedulers and strategy evidence require a coordinated engine change.</p>
          {discrepancies.length ? <p className="inline-warning">Existing positions exceed the new-entry leverage: {discrepancies.map(p => `${p.instrument} ${p.actual_leverage}x`).join(", ")}. Position management remains active.</p> : null}
        </div>
      </Panel>
    </div>
    <Panel title="Trading changes" subtitle="Persisted audit history; source is dashboard">
      <DataTable caption="Trading configuration audit" rows={asRows(api.data?.audit)} rowKey={(r, i) => `${r.ts}-${i}`} minWidth={660} columns={[
        { key: "time", label: "Time", render: r => formatTimestamp(r.ts) },
        { key: "parameter", label: "Parameter", render: r => asText(asRow(parseJson(r.payload, {}))?.field) },
        { key: "old", label: "Before", render: r => asText(asRow(parseJson(r.payload, {}))?.oldValue) },
        { key: "new", label: "After", render: r => asText(asRow(parseJson(r.payload, {}))?.newValue) },
        { key: "source", label: "Source", render: () => "dashboard" },
      ]}/>
      {!asRows(api.data?.audit).length ? <div className="empty-state"><strong>No trading changes recorded</strong></div> : null}
    </Panel>
  </DataState>;
}
