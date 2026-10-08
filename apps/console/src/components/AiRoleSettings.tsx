import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Activity, PlugZap, Save, Trash2 } from "lucide-react";
import { useApi } from "../hooks/useApi";
import { asNumber, asRow, asRows, asText, type Row } from "../lib/types";
import { Badge, DataState, StatusBadge } from "./Primitives";

type RoleName = "gate" | "scalp" | "reviewer" | "evolution" | "critic";
interface RoleForm {
  enabled: boolean; provider: string; baseUrl: string; apiKey: string; model: string;
  temperature: string; timeoutMs: string; maxOutputTokens: string; retryCount: string;
  maxCallsPerHour: string; maxCallsPerDay: string; maxRevisionRounds: string;
}

const ROLE_NAMES: RoleName[] = ["gate", "scalp", "reviewer", "evolution", "critic"];
const ROLE_COPY: Record<RoleName, { title: string; purpose: string }> = {
  gate: { title: "Gate", purpose: "Candidate ALLOW / DENY. Failure blocks the entry." },
  scalp: { title: "Scalp", purpose: "Lightweight scalp context and veto. Failure skips entry." },
  reviewer: { title: "Reviewer", purpose: "Post-trade observations. Failure defers review only." },
  evolution: { title: "Evolution", purpose: "One bounded parameter proposal. Failure keeps Champion." },
  critic: { title: "Critic", purpose: "Challenge proposals before deterministic validation." },
};
const EMPTY: RoleForm = {
  enabled: true, provider: "", baseUrl: "", apiKey: "", model: "", temperature: "0.2",
  timeoutMs: "20000", maxOutputTokens: "250", retryCount: "1", maxCallsPerHour: "", maxCallsPerDay: "", maxRevisionRounds: "1",
};

export function AiRoleSettings() {
  const api = useApi<unknown>("/api/settings/llm-roles", 30_000);
  const roles = useMemo(() => asRows(asRow(api.data)?.roles), [api.data]);
  const [forms, setForms] = useState<Partial<Record<RoleName, RoleForm>>>({});
  const [dirty, setDirty] = useState<Partial<Record<RoleName, boolean>>>({});
  const [busy, setBusy] = useState<{ role: RoleName; action: "save" | "test" | "clear" } | null>(null);
  const [message, setMessage] = useState<Partial<Record<RoleName, { text: string; tone: string }>>>({});
  const [testMessage, setTestMessage] = useState<Partial<Record<RoleName, string>>>({});

  useEffect(() => {
    setForms(previous => {
      const next = { ...previous };
      for (const row of roles) {
        const role = asText(row.role) as RoleName;
        if (ROLE_NAMES.includes(role) && !dirty[role]) next[role] = fromRow(row);
      }
      return next;
    });
  }, [roles, dirty]);

  const change = (role: RoleName, key: keyof RoleForm, value: string | boolean) => {
    setDirty(previous => ({ ...previous, [role]: true }));
    setForms(previous => ({ ...previous, [role]: { ...(previous[role] ?? EMPTY), [key]: value } }));
    setMessage(previous => ({ ...previous, [role]: undefined }));
  };

  const submit = async (event: FormEvent<HTMLFormElement>, role: RoleName) => {
    event.preventDefault();
    setBusy({ role, action: "save" });
    try {
      const response = await fetch(`/api/settings/llm-roles/${role}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(payload(forms[role] ?? EMPTY)) });
      const result = await readResponse(response);
      if (!response.ok) throw new Error(asText(result.error, `Save failed (${response.status})`));
      setForms(previous => ({ ...previous, [role]: { ...(previous[role] ?? EMPTY), apiKey: "" } }));
      setDirty(previous => ({ ...previous, [role]: false }));
      setMessage(previous => ({ ...previous, [role]: { text: "Saved. The next request uses these settings.", tone: "positive" } }));
      await api.reload();
    } catch (error) {
      setMessage(previous => ({ ...previous, [role]: { text: error instanceof Error ? error.message : "Settings could not be saved.", tone: "negative" } }));
    } finally { setBusy(null); }
  };

  const testConnection = async (role: RoleName) => {
    setBusy({ role, action: "test" }); setTestMessage(previous => ({ ...previous, [role]: "" }));
    try {
      const response = await fetch(`/api/settings/llm-roles/${role}/test`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload(forms[role] ?? EMPTY)) });
      const result = await readResponse(response);
      if (!response.ok || result.success !== true) throw new Error(asText(result.error, `Connection test failed (${response.status})`));
      const latency = asNumber(result.latency_ms);
      setTestMessage(previous => ({ ...previous, [role]: `Connection succeeded${latency === null ? "." : ` in ${Math.round(latency)} ms.`}` }));
      await api.reload();
    } catch (error) {
      setTestMessage(previous => ({ ...previous, [role]: error instanceof Error ? error.message : "Connection test failed." }));
    } finally { setBusy(null); }
  };

  const clearKey = async (role: RoleName) => {
    if (!window.confirm(`Clear the saved API key for ${ROLE_COPY[role].title}? The role cannot make requests until a new key is saved.`)) return;
    setBusy({ role, action: "clear" });
    try {
      const response = await fetch(`/api/settings/llm-roles/${role}/api-key?confirm=yes`, { method: "DELETE" });
      const result = await readResponse(response);
      if (!response.ok) throw new Error(asText(result.error, `Clear failed (${response.status})`));
      setForms(previous => ({ ...previous, [role]: { ...(previous[role] ?? EMPTY), apiKey: "" } }));
      setDirty(previous => ({ ...previous, [role]: false }));
      setMessage(previous => ({ ...previous, [role]: { text: "Saved API key cleared.", tone: "warning" } }));
      await api.reload();
    } catch (error) {
      setMessage(previous => ({ ...previous, [role]: { text: error instanceof Error ? error.message : "API key could not be cleared.", tone: "negative" } }));
    } finally { setBusy(null); }
  };

  return <section className="ai-roles-section" aria-labelledby="ai-roles-title">
    <div className="ai-roles-heading">
      <div><h2 id="ai-roles-title">AI / LLM roles</h2><p>Independent endpoints, budgets, and health. API keys stay on this server.</p></div>
      <Badge tone="info"><Activity size={12} aria-hidden="true"/> Role routing</Badge>
    </div>
    <DataState loading={api.loading} error={api.error} empty={roles.length === 0} hasData={api.data !== null}
      emptyTitle="Role settings are not available" emptyDetail="The backend role-settings API is unavailable. Existing trading controls remain unchanged.">
      <div className="ai-role-grid">
        {ROLE_NAMES.map(roleName => {
          const role = roles.find(row => row.role === roleName) ?? {};
          const form = forms[roleName] ?? fromRow(role);
          const budget = asRow(role.budget) ?? {};
          const status = asText(role.status, "UNCONFIGURED");
          const currentMessage = message[roleName];
          const currentTest = testMessage[roleName];
          const isBusy = busy !== null;
          return <section className="ai-role-card" key={roleName} aria-labelledby={`role-${roleName}-title`}>
            <header className="ai-role-card-heading">
              <div className="ai-role-heading-copy">
                <div className="ai-role-title-line"><h3 id={`role-${roleName}-title`}>{ROLE_COPY[roleName].title}</h3><StatusBadge value={status}/></div>
                <p>{ROLE_COPY[roleName].purpose}</p>
                <div className="ai-role-endpoint"><span>{asText(role.provider, "Provider not set")}</span><span>{asText(role.model, "Model not set")}</span><span title={asText(role.baseUrlHost)}>{asText(role.baseUrlHost, "URL not configured")}</span></div>
              </div>
              <label className="role-enabled"><input type="checkbox" checked={form.enabled} onChange={event => change(roleName, "enabled", event.target.checked)}/><span>Enabled</span></label>
            </header>
            <form className="ai-role-form" onSubmit={event => void submit(event, roleName)}>
              <label className="role-form-field"><span>Provider</span><input value={form.provider} onChange={event => change(roleName, "provider", event.target.value)} maxLength={120} autoComplete="organization"/></label>
              <label className="role-form-field role-form-wide"><span>Base URL</span><input type="url" value={form.baseUrl} onChange={event => change(roleName, "baseUrl", event.target.value)} placeholder="https://provider.example/v1" autoComplete="url"/></label>
              <label className="role-form-field role-form-wide"><span>API key <small>{asText(role.apiKeyMasked, "Not configured")}</small></span><input type="password" value={form.apiKey} onChange={event => change(roleName, "apiKey", event.target.value)} placeholder="Blank keeps the saved key" autoComplete="new-password"/></label>
              <label className="role-form-field role-form-wide"><span>Model</span><input value={form.model} onChange={event => change(roleName, "model", event.target.value)} maxLength={200} autoComplete="off"/></label>
              <label className="role-form-field"><span>Temperature</span><input type="number" min="0" max="2" step="0.01" value={form.temperature} onChange={event => change(roleName, "temperature", event.target.value)}/></label>
              <label className="role-form-field"><span>Timeout (ms)</span><input type="number" min="500" max="120000" step="100" value={form.timeoutMs} onChange={event => change(roleName, "timeoutMs", event.target.value)}/></label>
              <label className="role-form-field"><span>Max output tokens</span><input type="number" min="1" max="16000" value={form.maxOutputTokens} onChange={event => change(roleName, "maxOutputTokens", event.target.value)}/></label>
              <label className="role-form-field"><span>Retry count</span><input type="number" min="0" max="3" value={form.retryCount} onChange={event => change(roleName, "retryCount", event.target.value)}/></label>
              <label className="role-form-field"><span>HTTP requests / hour</span><input type="number" min="1" max="100000" value={form.maxCallsPerHour} onChange={event => change(roleName, "maxCallsPerHour", event.target.value)} placeholder="Keep saved limit"/></label>
              <label className="role-form-field"><span>HTTP requests / day</span><input type="number" min="1" max="1000000" value={form.maxCallsPerDay} onChange={event => change(roleName, "maxCallsPerDay", event.target.value)} placeholder="Keep saved limit"/></label>
              {roleName === "critic" ? <label className="role-form-field"><span>Max revision rounds</span><select value={form.maxRevisionRounds} onChange={event => change(roleName, "maxRevisionRounds", event.target.value)}><option value="0">0 — no revision</option><option value="1">1 — one revision</option></select></label> : null}
              <div className="ai-role-actions role-form-wide">
                <button className="primary-button" type="submit" disabled={isBusy}><Save size={13} aria-hidden="true"/>{busy?.role === roleName && busy.action === "save" ? "Saving" : "Save role"}</button>
                <button className="secondary-button" type="button" onClick={() => void testConnection(roleName)} disabled={isBusy}><PlugZap size={13} aria-hidden="true"/>{busy?.role === roleName && busy.action === "test" ? "Testing" : "Test connection"}</button>
                <button className="secondary-button role-clear-key" type="button" onClick={() => void clearKey(roleName)} disabled={isBusy || role.apiKeyConfigured !== true}><Trash2 size={13} aria-hidden="true"/>{busy?.role === roleName && busy.action === "clear" ? "Clearing" : "Clear key"}</button>
              </div>
              {currentMessage ? <p className={`role-message role-message-${currentMessage.tone}`} role="status">{currentMessage.text}</p> : null}
              {currentTest ? <p className={`role-message ${currentTest.startsWith("Connection succeeded") ? "role-message-positive" : "role-message-negative"}`} role="status">{currentTest}</p> : null}
            </form>
            <div className="ai-role-health" aria-label={`${ROLE_COPY[roleName].title} request health`}>
              <div><span>Last success</span><strong>{formatTime(role.lastSuccess)}</strong></div>
              <div><span>Last failure</span><strong>{formatTime(role.lastFailure)}{role.errorClass ? ` · ${asText(role.errorClass)}` : ""}</strong></div>
              <div><span>Last latency</span><strong>{role.lastLatencyMs == null ? "—" : `${Math.round(Number(role.lastLatencyMs))} ms`}</strong></div>
              <div><span>Budget used this hour</span><strong>{asText(role.budgetRequestsThisHour ?? role.providerRequestsThisHour, "0")} / {asText(budget.maxCallsPerHour, "∞")}</strong></div>
              <div><span>Budget used today</span><strong>{asText(role.budgetRequestsToday ?? role.providerRequestsToday, "0")} / {asText(budget.maxCallsPerDay, "∞")}</strong></div>
            </div>
            {Number(role.legacyBudgetChargesThisHour ?? 0) > 0 || Number(role.legacyBudgetChargesToday ?? 0) > 0 ? <p className="role-legacy-note">Budget includes {asText(role.legacyBudgetChargesThisHour, "0")} legacy charges this hour and {asText(role.legacyBudgetChargesToday, "0")} today. Their HTTP request count is unavailable.</p> : null}
            {dirty[roleName] ? <span className="sr-only" role="status">Unsaved changes for {ROLE_COPY[roleName].title}</span> : null}
          </section>;
        })}
      </div>
    </DataState>
  </section>;
}

function fromRow(row: Row): RoleForm {
  const budget = asRow(row.budget) ?? {};
  return {
    enabled: row.enabled !== false, provider: asText(row.provider, ""), baseUrl: asText(row.baseUrl, ""), apiKey: "",
    model: asText(row.model, ""), temperature: String(row.temperature ?? EMPTY.temperature), timeoutMs: String(row.timeoutMs ?? EMPTY.timeoutMs),
    maxOutputTokens: String(row.maxOutputTokens ?? EMPTY.maxOutputTokens), retryCount: String(row.retryCount ?? EMPTY.retryCount),
    maxCallsPerHour: budget.maxCallsPerHour == null ? "" : String(budget.maxCallsPerHour),
    maxCallsPerDay: budget.maxCallsPerDay == null ? "" : String(budget.maxCallsPerDay),
    maxRevisionRounds: String(row.maxRevisionRounds ?? EMPTY.maxRevisionRounds),
  };
}

function payload(form: RoleForm): Row {
  const number = (value: string) => Number(value);
  const budget: Row = {};
  if (form.maxCallsPerHour) budget.maxCallsPerHour = number(form.maxCallsPerHour);
  if (form.maxCallsPerDay) budget.maxCallsPerDay = number(form.maxCallsPerDay);
  return {
    enabled: form.enabled, provider: form.provider, baseUrl: form.baseUrl, ...(form.apiKey ? { apiKey: form.apiKey } : {}),
    model: form.model, temperature: number(form.temperature), timeoutMs: number(form.timeoutMs),
    maxOutputTokens: number(form.maxOutputTokens), retryCount: number(form.retryCount), budget,
    ...(form.maxRevisionRounds !== "" ? { maxRevisionRounds: number(form.maxRevisionRounds) } : {}),
  };
}

async function readResponse(response: Response): Promise<Row> {
  try { return asRow(await response.json()) ?? {}; } catch { return {}; }
}

function formatTime(value: unknown): string {
  if (typeof value !== "string" || !value) return "—";
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toLocaleString() : "—";
}
