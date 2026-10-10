import { useState, type FormEvent } from "react";
import { useApi } from "../hooks/useApi";
import { asNumber, asRow, asRows, asText, parseJson, type Row } from "../lib/types";
import { formatAmount, formatTimestamp } from "../lib/format";
import { DataState, DataTable, Field, Panel } from "./Primitives";

const fields = [
  ["risk_per_trade_pct", "Risk per trade", "%", 0.1],
  ["max_concurrent_positions", "Maximum positions", "positions", 1],
  ["max_portfolio_open_risk_pct", "Portfolio open risk limit", "%", 0.1],
  ["max_leverage", "Maximum leverage", "x", 1],
  ["max_daily_loss_pct", "Daily loss limit", "%", 0.1],
  ["max_drawdown_pct", "Maximum drawdown", "%", 0.1],
] as const;

export function RiskSettings({ equity, positions, onSaved }: { equity: unknown; positions: Row[]; onSaved: () => Promise<void> }) {
  const api = useApi<Row>("/api/risk", 30_000);
  const [draft, setDraft] = useState<Record<string, string> | null>(null);
  const [editingRevision, setEditingRevision] = useState<number | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const current = asRow(api.data?.limits) ?? {};
  const ceilings = asRow(api.data?.ceilings) ?? {};
  const values = draft ?? Object.fromEntries(fields.map(([key]) => [key, asText(current[key], "")]));
  const revision = editingRevision ?? asNumber(api.data?.revision);
  const staleDraft = draft !== null && editingRevision !== asNumber(api.data?.revision);
  const change = (key: string, value: string) => {
    if (!draft) setEditingRevision(asNumber(api.data?.revision));
    setDraft({ ...values, [key]: value }); setNotice(null);
  };
  const save = async (event: FormEvent) => {
    event.preventDefault();
    const limits = Object.fromEntries(fields.map(([key]) => [key, Number(values[key])]));
    const increases = fields.filter(([key]) => limits[key]! > Number(current[key]));
    if (increases.length && !window.confirm(`Increase operational limits: ${increases.map(([key, label]) => `${label} ${current[key]} to ${limits[key]}`).join(", ")}? New entries will use these values.`)) return;
    setSaving(true); setNotice(null);
    try {
      const response = await fetch("/api/risk", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ revision, limits, confirmRiskIncrease: increases.length > 0 }) });
      const body = await response.json() as Row;
      if (!response.ok) throw new Error(asText(body.error, "Risk settings could not be saved."));
      api.applyResponse(body);
      setDraft(null); setEditingRevision(null);
      await api.reload(true); await onSaved();
      setNotice("Saved. New entries use these limits. Existing positions retain their current size and leverage.");
    } catch (error) { setNotice(error instanceof Error ? error.message : "Save failed."); }
    finally { setSaving(false); }
  };
  const eq = asNumber(equity);
  const discrepancies = positions.filter(p => Number(p.actual_leverage) > Number(current.max_leverage));
  return <DataState loading={api.loading} error={api.error} empty={!api.data} hasData={Boolean(api.data)} emptyTitle="Risk configuration unavailable">
    <div className="risk-editor">
      <Panel title="Trading risk" subtitle="Operational settings, enforced below absolute safety ceilings">
        <form className="risk-form" onSubmit={event => void save(event)}>
          {fields.map(([key, label, unit, step]) => <label className="risk-form-row" key={key}><span>{label}</span><input type="number" required min={step} max={Number(ceilings[key])} step={step} value={values[key] ?? ""} onChange={e => change(key, e.target.value)} disabled={saving}/><small>{unit} · ceiling {asText(ceilings[key])}</small></label>)}
          {eq !== null && eq > 0 && Number(values.risk_per_trade_pct) > 0 ? <div className="risk-preview">Maximum planned loss per new trade at {formatAmount(eq)} equity: <strong>{formatAmount(eq * Number(current.risk_per_trade_pct) / 100)}</strong> to <strong>{formatAmount(eq * Number(values.risk_per_trade_pct) / 100)}</strong>. Actual sizing may use less.</div> : null}
          {Number(values.risk_per_trade_pct) > Number(values.max_portfolio_open_risk_pct) ? <p className="inline-warning">Configured per-trade risk exceeds the portfolio open-risk limit. The deterministic portfolio gate can reject a new entry even when its individual trade limit is valid.</p> : null}
          {staleDraft ? <p className="inline-warning">Settings changed while editing. Reload before saving.</p> : null}
          <div className="risk-actions"><button type="submit" className="primary-button" disabled={saving || !draft || staleDraft}>{saving ? "Saving…" : "Save risk settings"}</button><button type="button" className="secondary-button" onClick={() => { setDraft(null); setEditingRevision(null); void api.reload(); }}>Reload saved values</button></div>
          {notice ? <p role="status">{notice}</p> : null}
        </form>
      </Panel>
      <Panel title="Absolute safety limits" subtitle="Read-only constants; neither operators nor AI can exceed these">
        <div className="risk-form">{fields.map(([key, label, unit]) => <Field key={key} label={label} value={`≤ ${asText(ceilings[key])} ${unit}`}/>)}
          <p className="muted-small">Lowering a limit blocks conflicting new entries. Existing positions are not resized. Account loss and drawdown limits still enforce the existing deterministic halt behavior. Leverage for new entries also stays below the configured trading leverage cap.</p>
          {discrepancies.length || positions.length > Number(current.max_concurrent_positions) ? <p className="inline-warning">Existing exposure exceeds current operational settings: {discrepancies.map(p => `${p.instrument} ${p.actual_leverage}x`).join(", ") || `${positions.length} positions`}. Position management remains active.</p> : null}
        </div>
      </Panel>
    </div>
    <Panel title="Risk changes" subtitle="Atomic audit history; source is dashboard">
      <DataTable caption="Risk configuration audit" rows={asRows(api.data?.audit)} rowKey={(r,i) => `${r.ts}-${i}`} minWidth={640} columns={[
        { key: "time", label: "Time", render: r => formatTimestamp(r.ts) },
        { key: "parameter", label: "Parameter", render: r => asText(asRow(parseJson(r.payload, {}))?.field) },
        { key: "old", label: "Before", render: r => asText(asRow(parseJson(r.payload, {}))?.oldValue) },
        { key: "new", label: "After", render: r => asText(asRow(parseJson(r.payload, {}))?.newValue) },
        { key: "source", label: "Source", render: () => "dashboard" },
      ]}/>
      {!asRows(api.data?.audit).length ? <div className="empty-state"><strong>No runtime risk changes recorded</strong></div> : null}
    </Panel>
  </DataState>;
}
