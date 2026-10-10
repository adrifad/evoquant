import { useState } from "react";
import { AiRoleSettings } from "../components/AiRoleSettings";
import { useApi } from "../hooks/useApi";
import { asNumber, asRow, asRows, asText } from "../lib/types";
import { formatNumber, formatTimestamp } from "../lib/format";
import { roleHealthPresentation } from "../lib/roleHealth";
import { DataState, DataTable, PageHeading, Panel, StatusBadge } from "../components/Primitives";
import { MemoryPage } from "./MemoryPage";

const purposes: Record<string, string> = {
  gate: "Candidate context veto · frequent", scalp: "Scalp context veto · frequent",
  reviewer: "Post-trade observations", evolution: "Evidence-based parameter proposal",
  critic: "Proposal critique before deterministic validation",
};
export function AiPage() {
  const api = useApi<unknown>("/api/settings/llm-roles", 30_000);
  const [tab, setTab] = useState("Roles");
  const roles = asRows(asRow(api.data)?.roles);
  return <div className="page">
    <PageHeading title="AI" description="Context, review and bounded evolution. Deterministic code owns risk, execution and promotion."/>
    <div className="workstation-tabs">{["Roles", "Role settings", "Memory"].map(t => <button key={t} aria-pressed={tab === t} onClick={() => setTab(t)}>{t}</button>)}</div>
    {tab === "Memory" ? <MemoryPage/> : tab === "Role settings" ? <AiRoleSettings/> : <>
      <Panel title="Role health" subtitle="HTTP counts record provider requests, including retries. Budgets include retained legacy charges where shown. Tokens are provider-reported.">
        <DataState loading={api.loading} error={api.error} empty={!roles.length} hasData={api.data !== null} emptyTitle="AI role configuration unavailable">
          <DataTable rows={roles} rowKey={r => String(r.role)} minWidth={1150} columns={[
            { key: "role", label: "Role / purpose", render: r => <><strong>{asText(r.role).toUpperCase()}</strong><small className="source-note">{purposes[String(r.role)]}</small></> },
            { key: "model", label: "Provider / model", render: r => <><span>{asText(r.provider)}</span><small className="source-note">{asText(r.model)}</small></> },
            { key: "health", label: "Health", render: r => <StatusBadge value={r.status}/> },
            { key: "latency", label: "Last latency", numeric: true, render: r => `${formatNumber(r.lastLatencyMs, 0)} ms` },
            { key: "logical", label: "Logical calls / day", numeric: true, render: r => formatNumber(r.callsToday, 0) },
            { key: "requests", label: "HTTP requests / day", numeric: true, render: r => <>{formatNumber(r.providerRequestsToday, 0)}{(asNumber(r.legacyBudgetChargesToday) ?? 0) > 0 ? <small className="source-note">{formatNumber(r.legacyBudgetChargesToday, 0)} legacy budget charges; HTTP count unavailable</small> : null}</> },
            { key: "retries", label: "Retries / day", numeric: true, render: r => formatNumber(r.retriesToday, 0) },
            { key: "tokens", label: "Input / output tokens", numeric: true, render: r => `${formatNumber(r.inputTokensToday, 0)} / ${formatNumber(r.outputTokensToday, 0)}` },
            { key: "budget", label: "Budget used / limit", render: r => { const b = asRow(r.budget); return <>{formatNumber(r.budgetRequestsThisHour ?? r.providerRequestsThisHour, 0)} / {asText(b?.maxCallsPerHour, "∞")} this hour<small className="source-note">{formatNumber(r.budgetRequestsToday ?? r.providerRequestsToday, 0)} / {asText(b?.maxCallsPerDay, "∞")} today</small></>; } },
            { key: "last", label: "Latest / previous failure", render: r => {
              const health = roleHealthPresentation(r);
              if (!health.currentStatus) return <span className="source-note">No requests yet</span>;
              const detail = health.currentReason || health.currentHttpStatus !== null
                ? <small className="source-note">{health.currentReason ? `Reason: ${health.currentReason}` : ""}{health.currentReason && health.currentHttpStatus !== null ? " · " : ""}{health.currentHttpStatus === null ? "" : `HTTP ${health.currentHttpStatus}`}</small>
                : health.previousFailureStatus ? <small className="source-note">Previous: {health.previousFailureStatus}{health.previousFailureReason ? ` · ${health.previousFailureReason}` : ""}{health.previousFailureHttpStatus === null ? "" : ` · HTTP ${health.previousFailureHttpStatus}`} · {formatTimestamp(health.previousFailureTimestamp)}</small> : null;
              return <><strong>{health.currentStatus}</strong><small className="source-note">{formatTimestamp(health.currentTimestamp)}</small>{detail}</>;
            } },
          ]}/>
        </DataState>
      </Panel>
      <Panel title="Role boundaries" subtitle="AI never chooses leverage, position risk or executes orders">
        <div className="trace-list">{[["Candidate", "Strategy Core selects side and setup; Gate may allow or deny context."], ["Closed trade", "Reviewer records provisional observations and lesson candidates."], ["Evidence ready", "Evolution proposes one bounded parameter change; Critic accepts, rejects or requests revision."], ["Validation", "Historical, OOS, rolling robustness and matched shadow evidence precede deterministic promotion."]].map(([label, text]) => <div className="trace-step" key={label}><strong>{label}</strong><span>{text}</span></div>)}</div>
      </Panel>
    </>}
  </div>;
}
