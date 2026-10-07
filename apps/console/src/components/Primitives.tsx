import type { ReactNode } from "react";
import { AlertTriangle, LoaderCircle } from "lucide-react";
import { asText } from "../lib/types";

export function Badge({ children, tone = "neutral", className = "" }: { children: ReactNode; tone?: string; className?: string }) {
  return <span className={`badge badge-${toneClass(tone)} ${className}`.trim()}>{children}</span>;
}

export function StatusBadge({ value }: { value: unknown }) {
  const label = asText(value, "UNKNOWN");
  return <Badge tone={statusTone(label)}>{label.replaceAll("_", " ")}</Badge>;
}

export function Panel({ title, subtitle, action, className = "", children }: {
  title: string;
  subtitle?: string;
  action?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return <section className={`panel ${className}`.trim()}>
    <header className="panel-heading">
      <div><h2>{title}</h2>{subtitle ? <p>{subtitle}</p> : null}</div>
      {action ? <div className="panel-action">{action}</div> : null}
    </header>
    {children}
  </section>;
}

export function PageHeading({ title, description, detail }: { title: string; description: string; detail?: ReactNode }) {
  return <header className="page-heading">
    <div><h1>{title}</h1><p>{description}</p></div>
    {detail ? <div className="page-heading-detail">{detail}</div> : null}
  </header>;
}

export function Metric({ label, value, detail, tone = "neutral", className = "" }: {
  label: string;
  value: ReactNode;
  detail?: ReactNode;
  tone?: string;
  className?: string;
}) {
  return <div className={`metric ${className}`.trim()}>
    <span className="metric-label">{label}</span>
    <strong className={`metric-value ${toneClass(tone)}`}>{value}</strong>
    {detail !== undefined ? <span className="metric-detail">{detail}</span> : null}
  </div>;
}

export function DataState({ loading, error, empty, emptyTitle = "No records yet", emptyDetail, hasData = false, children }: {
  loading: boolean;
  error: string | null;
  empty: boolean;
  emptyTitle?: string;
  emptyDetail?: string;
  hasData?: boolean;
  children: ReactNode;
}) {
  if (loading && !hasData) return <div className="data-state" role="status"><LoaderCircle size={17} aria-hidden="true"/><span>Loading current records</span></div>;
  if (error && !hasData) return <div className="data-state data-error" role="alert"><AlertTriangle size={17} aria-hidden="true"/><span>{error}. Check the local bot connection.</span></div>;
  return <>
    {error ? <div className="inline-warning" role="status"><AlertTriangle size={15} aria-hidden="true"/>Showing last available data. Refresh failed: {error}</div> : null}
    {empty ? <div className="empty-state"><strong>{emptyTitle}</strong>{emptyDetail ? <span>{emptyDetail}</span> : null}</div> : children}
  </>;
}

export function Field({ label, value, detail, mono = true, tone = "neutral" }: {
  label: string;
  value: ReactNode;
  detail?: ReactNode;
  mono?: boolean;
  tone?: string;
}) {
  return <div className="field-row">
    <span className="field-label">{label}</span>
    <span className={`field-value ${mono ? "mono" : ""} ${toneClass(tone)}`.trim()}>{value}</span>
    {detail !== undefined ? <span className="field-detail">{detail}</span> : null}
  </div>;
}

export function DataTable({ columns, rows, rowKey, onRowClick, caption, minWidth = 680 }: {
  columns: Array<{ key: string; label: string; render: (row: Record<string, unknown>) => ReactNode; numeric?: boolean }>;
  rows: Array<Record<string, unknown>>;
  rowKey: (row: Record<string, unknown>, index: number) => string;
  onRowClick?: (row: Record<string, unknown>) => void;
  caption?: string;
  minWidth?: number;
}) {
  return <div className="table-scroll" role="region" aria-label={caption ?? "Data table"} tabIndex={0}>
    <table style={{ minWidth }}>
      {caption ? <caption className="sr-only">{caption}</caption> : null}
      <thead><tr>{columns.map(column => <th key={column.key} scope="col" className={column.numeric ? "numeric" : ""}>{column.label}</th>)}</tr></thead>
      <tbody>{rows.map((row, index) => <tr key={rowKey(row, index)} className={onRowClick ? "selectable-row" : ""}>
        {columns.map(column => <td key={column.key} className={column.numeric ? "numeric" : ""}>
          {onRowClick && column === columns[0]
            ? <button className="table-select" onClick={() => onRowClick(row)}>{column.render(row)}</button>
            : column.render(row)}
        </td>)}
      </tr>)}</tbody>
    </table>
  </div>;
}

export function Evidence({ sample }: { sample: unknown }) {
  const count = Number(sample) || 0;
  const level = count < 5 ? "INSUFFICIENT" : count < 15 ? "LOW" : count < 30 ? "MODERATE" : "HIGH";
  const tone = count < 5 ? "neutral" : count < 15 ? "warning" : count < 30 ? "info" : "positive";
  return <span className="evidence"><Badge tone={tone}>{level}</Badge><span>{count} {count === 1 ? "trade" : "trades"}</span></span>;
}

export function DividerLabel({ children }: { children: ReactNode }) {
  return <h3 className="divider-label">{children}</h3>;
}

function toneClass(tone: string): string {
  const value = tone.toLowerCase().replaceAll(" ", "-").replaceAll("_", "-");
  return ["positive", "negative", "warning", "critical", "info", "neutral", "long", "short"].includes(value) ? value : "neutral";
}

function statusTone(value: string): string {
  const status = value.toUpperCase();
  if (["AVAILABLE", "SUCCESS"].includes(status)) return "positive";
  if (["BUDGET_EXHAUSTED", "UNCONFIGURED", "DISABLED"].includes(status)) return status === "BUDGET_EXHAUSTED" ? "warning" : "neutral";
  if (["RUNNING", "APPROVED", "CHAMPION", "VERIFIED", "PROMOTED", "SAFE", "LONG", "WIN"].includes(status)) return status === "LONG" ? "long" : "positive";
  if (["RISK_HALTED", "ERROR", "REJECTED", "HALTED", "LOSS", "SHORT", "DISCONNECTED"].includes(status)) return status === "SHORT" ? "short" : "critical";
  if (["PAUSED", "WARNING", "CHALLENGER", "PROVISIONAL", "REINFORCED", "TESTING"].includes(status)) return "warning";
  if (["CONNECTED", "DEMO", "OKX"].includes(status)) return "info";
  return "neutral";
}
