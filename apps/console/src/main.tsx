import { useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { AppShell, type PageId } from "./components/AppShell";
import { useApi, useRefreshSocket } from "./hooks/useApi";
import { asRow } from "./lib/types";
import { DashboardPage } from "./pages/DashboardPage";
import { EvolutionWorkspace } from "./pages/EvolutionWorkspace";
import { TradingPage } from "./pages/TradingPage";
import { AiPage } from "./pages/AiPage";
import { LogsPage } from "./pages/LogsPage";
import { MarketsPage } from "./pages/MarketsPage";
import { MemoryPage } from "./pages/MemoryPage";
import { RiskPage } from "./pages/RiskPage";
import { SettingsPage } from "./pages/SettingsPage";
import { StrategiesPage } from "./pages/StrategiesPage";
import { TradesPage } from "./pages/TradesPage";
import "./styles.css";
import "./workstation.css";

function App() {
  const [page, setPage] = useState<PageId>("dashboard");
  const status = useApi<Record<string, unknown>>("/api/status", 15_000);
  const socketConnected = useRefreshSocket();
  const data = asRow(status.data);

  const pages: Record<PageId, ReactNode> = {
    dashboard: <DashboardPage status={status}/>,
    trading: <TradingPage status={status}/>,
    ai: <AiPage/>,
    markets: <MarketsPage status={status}/>,
    trades: <TradesPage/>,
    strategies: <StrategiesPage/>,
    evolution: <EvolutionWorkspace/>,
    memory: <MemoryPage/>,
    risk: <RiskPage status={status}/>,
    logs: <LogsPage/>,
    settings: <SettingsPage status={status}/>,
  };

  return <AppShell page={page} setPage={setPage} status={{ ...status, data }} socketConnected={socketConnected}>
    {pages[page]}
  </AppShell>;
}

createRoot(document.getElementById("root")!).render(<App/>);
