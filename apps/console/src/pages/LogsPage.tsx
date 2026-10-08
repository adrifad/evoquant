import { useMemo, useState } from "react";
import { Download } from "lucide-react";
import { useApi } from "../hooks/useApi";
import { formatTimestamp } from "../lib/format";
import { asRows, asText, type Row } from "../lib/types";
import { DataState, DataTable, PageHeading, Panel, StatusBadge } from "../components/Primitives";
import { summarizeEvent } from "./RiskPage";

const filters = ["ALL", "TRADING", "RISK", "AI", "EVOLUTION", "SYSTEM", "ERRORS"] as const;
type LogFilter = typeof filters[number];

export function LogsPage() {
  const api = useApi<unknown>("/api/events");
  const [filter, setFilter] = useState<LogFilter>("ALL");
  const [query, setQuery] = useState("");
  const events = asRows(api.data);
  const rows = useMemo(() => events.filter(event => matchesFilter(event, filter) && `${asText(event.kind)} ${summarizeEvent(event)} ${asText(event.ts)}`.toLowerCase().includes(query.toLowerCase())), [events, filter, query]);

  const exportRows = () => {
    const safeRows = rows.map(row => ({ timestamp: row.ts, kind: row.kind, summary: summarizeEvent(row) }));
    const objectUrl = URL.createObjectURL(new Blob([JSON.stringify(safeRows, null, 2)], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = objectUrl;
    link.download = "evoquant-events.json";
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(objectUrl), 0);
  };

  return <div className="page">
    <PageHeading title="Logs" description="Operational event history with explicit filters and safe, structured summaries." detail={<span className="muted-small">Latest {events.length} events from API</span>}/>
    <Panel title="Event stream" subtitle="Sensitive payloads are not expanded into the interface" action={<button className="secondary-button" onClick={exportRows} disabled={!rows.length}><Download size={15} aria-hidden="true"/>Export filtered logs</button>}>
      <div className="log-controls">
        <div className="log-tabs" role="tablist" aria-label="Filter logs by event class">
          {filters.map(item => <button key={item} role="tab" aria-selected={filter === item} className={filter === item ? "tab-active" : ""} onClick={() => setFilter(item)}>{item}</button>)}
        </div>
        <label className="filter-control filter-search"><span>Search events</span><input value={query} onChange={event => setQuery(event.target.value)} placeholder="Kind, event detail, timestamp"/></label>
      </div>
      <DataState loading={api.loading} error={api.error} empty={!rows.length} hasData={api.data !== null} emptyTitle={events.length ? "No events match this filter" : "No system events recorded"} emptyDetail={events.length ? "Try another event class or search term." : "System events will appear here when recorded by the bot."}>
        <DataTable caption="Operational event log" rows={rows} rowKey={(row, index) => `${asText(row.ts)}-${asText(row.kind)}-${index}`} minWidth={790} columns={[
          { key: "timestamp", label: "Timestamp", render: row => formatTimestamp(row.ts) },
          { key: "kind", label: "Event kind", render: row => <StatusBadge value={row.kind}/> },
          { key: "summary", label: "Summary", render: row => <span className="log-summary">{summarizeEvent(row)}</span> },
        ]}/>
      </DataState>
    </Panel>
  </div>;
}

function matchesFilter(event: Row, filter: LogFilter): boolean {
  if (filter === "ALL") return true;
  const kind = String(event.kind ?? "").toUpperCase();
  if (filter === "RISK") return kind.includes("RISK") || kind === "STATE";
  if (filter === "TRADING") return /TRADE|ORDER|FILL|CANDIDATE|STRATEGY_|DECISION/.test(kind);
  if (filter === "ERRORS") return /ERROR|FAIL|TIMEOUT|EXHAUSTED/.test(kind);
  if (filter === "EVOLUTION") return /PROMOTION|EVOLUTION|CRITIC|CHALLENGER|SHADOW|WEIGHTS/.test(kind);
  if (filter === "AI") return /LLM|REVIEW|CRITIC/.test(kind);
  return /STATE|SYSTEM|START|ERROR|RECONCILE|HALT/.test(kind);
}
