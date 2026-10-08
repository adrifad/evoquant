import { useEffect, useState, type ReactNode } from "react";
import {
  Activity, ArrowLeftRight, BrainCircuit, CandlestickChart, FlaskConical,
  LayoutDashboard, Menu, Network, ScrollText, Settings, ShieldAlert, X, ZapOff,
} from "lucide-react";
import type { ApiState, Row } from "../lib/types";
import { asText } from "../lib/types";
import { Badge, StatusBadge } from "./Primitives";

export type PageId = "dashboard" | "trading" | "markets" | "trades" | "strategies" | "evolution" | "memory" | "risk" | "ai" | "logs" | "settings";

const navigation = [
  { id: "dashboard", label: "Dashboard", Icon: LayoutDashboard },
  { id: "trading", label: "Trading", Icon: Activity },
  { id: "markets", label: "Markets", Icon: CandlestickChart },
  { id: "trades", label: "Trades", Icon: ArrowLeftRight },
  { id: "evolution", label: "Evolution", Icon: FlaskConical },
  { id: "risk", label: "Risk", Icon: ShieldAlert },
  { id: "ai", label: "AI", Icon: BrainCircuit },
  { id: "logs", label: "Logs", Icon: ScrollText },
  { id: "settings", label: "Settings", Icon: Settings },
] as const;

export function AppShell({ page, setPage, status, socketConnected, children }: {
  page: PageId;
  setPage: (page: PageId) => void;
  status: ApiState<Row>;
  socketConnected: boolean;
  children: ReactNode;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const s = status.data;
  const botState = s?.emergencyHalted || s?.killReason ? "HALTED" : asText(s?.botState, "CONNECTING");

  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") setMenuOpen(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [menuOpen]);

  const control = async (path: "/api/pause" | "/api/resume" | "/api/emergency-stop") => {
    if (path === "/api/emergency-stop" && !window.confirm("Emergency stop will halt new entries and cancel pending entry orders. Existing protective orders remain. Continue?")) return;
    setBusy(true);
    setNotice(null);
    try {
      const response = await fetch(path, { method: "POST" });
      const result = await response.json() as Row;
      if (!response.ok) throw new Error(asText(result.error, `Request failed (${response.status})`));
      setNotice(path === "/api/pause" ? "Bot paused." : path === "/api/resume" ? "Bot resumed." : "Emergency stop activated.");
      await status.reload();
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : "Control request failed.");
    } finally {
      setBusy(false);
    }
  };

  return <div className="app-shell">
    {menuOpen ? <button className="sidebar-backdrop" aria-label="Close navigation" onClick={() => setMenuOpen(false)} /> : null}
    <aside className={`sidebar ${menuOpen ? "sidebar-open" : ""}`} aria-label="Application sidebar">
      <div className="brand-lockup">
        <div className="brand-mark" aria-hidden="true"><Activity size={19}/></div>
        <div><div className="brand-name">EvoQuant</div><div className="brand-descriptor">Adaptive Quant Intelligence</div></div>
        <button className="icon-button sidebar-close" aria-label="Close navigation" onClick={() => setMenuOpen(false)}><X size={18}/></button>
      </div>
      <div className="side-section-label">Workspace</div>
      <nav className="primary-nav" aria-label="Primary navigation">
        {navigation.map(({ id, label, Icon }) => <button key={id} className={`nav-item ${page === id ? "nav-active" : ""}`} aria-current={page === id ? "page" : undefined} onClick={() => { setPage(id); setMenuOpen(false); }}>
          <Icon size={17} strokeWidth={1.8} aria-hidden="true"/><span>{label}</span>
        </button>)}
      </nav>
      <div className="sidebar-foot">
        <div className="sidebar-rule"/>
        <div className="foot-environment"><span className="status-pin"/>Simulated trading only</div>
        <span className="sidebar-version">Self-Evolving AI Quant Trading System</span>
      </div>
    </aside>

    <main className="main-shell">
      <header className="execution-tape">
        <button className="icon-button mobile-menu" aria-label="Open navigation" onClick={() => setMenuOpen(true)}><Menu size={20}/></button>
        <div className="tape-identity"><span className="tape-product">EvoQuant</span><span className="tape-product-sub">Adaptive Quant Intelligence</span></div>
        <div className="tape-divider"/>
        <Badge tone="info" className="demo-badge">OKX DEMO</Badge>
        <div className="tape-instrument"><span className="tape-symbol">{asText(s?.instrument, "N/A")}</span><span className="tape-timeframe">{asText(s?.timeframe, "N/A")}</span></div>
        <div className={`connection-state ${status.error ? "connection-offline" : socketConnected ? "connection-live" : "connection-waiting"}`}>
          <Network size={14} aria-hidden="true"/><span>{status.error && !s ? "Disconnected" : socketConnected ? "Connected" : "Connecting"}</span>
        </div>
        <div className="tape-spacer"/>
        <div className="bot-state-wrap"><span className="bot-state-label">BOT</span><StatusBadge value={botState}/></div>
        <div className="tape-controls">
          {botState === "PAUSED"
            ? <button className="control-button" disabled={busy} onClick={() => void control("/api/resume")}>Resume</button>
            : <button className="control-button" disabled={busy || botState !== "RUNNING"} onClick={() => void control("/api/pause")}>Pause</button>}
          <button className="control-button control-emergency" disabled={busy || Boolean(s?.emergencyHalted)} onClick={() => void control("/api/emergency-stop")}><ZapOff size={14} aria-hidden="true"/><span>Emergency stop</span></button>
        </div>
      </header>
      {notice ? <div className="toast" role="status"><span>{notice}</span><button className="icon-button" aria-label="Dismiss notification" onClick={() => setNotice(null)}><X size={15}/></button></div> : null}
      {status.error && s ? <div className="stale-banner" role="status">Connection refresh failed. Displaying last received status.</div> : null}
      <div className="page-outlet">{children}</div>
      <footer className="app-footer"><span>OKX Demo Trading</span><span className="footer-separator"/><span>Self-Evolving AI Quant Trading System</span></footer>
    </main>
  </div>;
}
