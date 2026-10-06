import { asRow, asRows, asText, parseJson, type Row } from "../lib/types";
import { formatNumber, formatPercent, formatR, toneFor } from "../lib/format";
import { Badge, DataState, Evidence, Field, PageHeading, Panel, StatusBadge } from "../components/Primitives";
import { useApi } from "../hooks/useApi";

type Strategy = Row & { name?: unknown; version?: unknown; parent_version?: unknown; params?: unknown; status?: unknown; hypothesis?: unknown; created_ts?: unknown };

export function StrategiesPage() {
  const api = useApi<unknown>("/api/strategies");
  const data = asRow(api.data);
  const strategies = asRows(data?.strategies) as Strategy[];
  const matrix = asRow(data?.regimeMatrix) ?? {};
  const performance = aggregateStrategyStats(matrix);

  return <div className="page">
    <PageHeading title="Strategies" description="Versioned research candidates with immutable parameters and observed outcomes." detail={<Badge tone="info">VERSION REGISTRY</Badge>}/>
    <DataState loading={api.loading} error={api.error} empty={!strategies.length} hasData={api.data !== null} emptyTitle="No strategy versions recorded" emptyDetail="The baseline strategies appear after the registry initializes.">
      <div className="strategy-list">
        {strategies.map(strategy => {
          const key = `${asText(strategy.name)}_V${asText(strategy.version)}`;
          const params = asRow(parseJson(strategy.params, {})) ?? {};
          const stats = performance[asText(strategy.name)] ?? null;
          return <details key={key} className={`strategy-record strategy-${String(strategy.status).toLowerCase()}`}>
            <summary>
              <div className="strategy-title"><div><strong>{asText(strategy.name)}</strong><span className="strategy-version">V{asText(strategy.version)}</span></div><span className="strategy-state"><StatusBadge value={strategy.status}/><span>{strategy.parent_version ? `Parent V${asText(strategy.parent_version)}` : "Base version"}</span></span></div>
              <div className="strategy-summary-metrics">
                <div><span>Observed trades</span><strong className="mono">{stats ? stats.trades : "N/A"}</strong></div>
                <div><span>Win rate</span><strong className="mono">{stats ? formatPercent(stats.winRate * 100, 1) : "N/A"}</strong></div>
                <div><span>Expectancy</span><strong className={`mono ${stats ? toneFor(stats.expectancy) : "neutral"}`}>{stats ? formatR(stats.expectancy) : "N/A"}</strong></div>
                {stats ? <Evidence sample={stats.trades}/> : <span className="muted-small">No performance evidence</span>}
              </div>
            </summary>
            <div className="strategy-detail">
              <div className="strategy-hypothesis"><span>Research hypothesis</span><p>{asText(strategy.hypothesis, "No hypothesis recorded for this version.")}</p></div>
              <div className="strategy-detail-grid">
                <div><h3>Parameters</h3>{Object.keys(params).length ? Object.entries(params).map(([name, value]) => <Field key={name} label={name.replaceAll("_", " ")} value={formatNumber(value)}/>) : <p className="muted-small">Parameter record unavailable.</p>}</div>
                <div><h3>Version record</h3><Field label="Created" value={asText(strategy.created_ts)} mono={false}/><Field label="Parent version" value={strategy.parent_version ? `V${asText(strategy.parent_version)}` : "Base"}/><Field label="State" value={<StatusBadge value={strategy.status}/>}/><Field label="Profit factor" value="Not available from strategy stats" mono={false}/></div>
              </div>
              {stats ? <div className="strategy-regime-list"><h3>Observed by regime</h3>{stats.byRegime.map(row => <div key={row.regime}><span>{row.regime}</span><span className={`mono ${toneFor(row.expectancy)}`}>{formatR(row.expectancy)}</span><span className="mono">{row.trades} trades</span></div>)}</div> : null}
            </div>
          </details>;
        })}
      </div>
    </DataState>
  </div>;
}

function aggregateStrategyStats(matrix: Row): Record<string, { trades: number; wins: number; winRate: number; expectancy: number; byRegime: Array<{ regime: string; trades: number; expectancy: number }> }> {
  const result: ReturnType<typeof aggregateStrategyStats> = {};
  for (const [regime, strategiesValue] of Object.entries(matrix)) {
    const strategies = asRow(strategiesValue) ?? {};
    for (const [name, sidesValue] of Object.entries(strategies)) {
      const sides = asRow(sidesValue) ?? {};
      let trades = 0, wins = 0, weightedR = 0;
      for (const cellValue of Object.values(sides)) {
        const cell = asRow(cellValue) ?? {};
        const n = Number(cell.trades) || 0;
        trades += n;
        wins += Number(cell.wins) || 0;
        weightedR += (Number(cell.expectancy_r) || 0) * n;
      }
      if (!trades) continue;
      const strategy = result[name] ??= { trades: 0, wins: 0, winRate: 0, expectancy: 0, byRegime: [] };
      strategy.trades += trades;
      strategy.wins += wins;
      strategy.expectancy += weightedR;
      strategy.byRegime.push({ regime, trades, expectancy: weightedR / trades });
    }
  }
  for (const strategy of Object.values(result)) {
    strategy.winRate = strategy.trades ? strategy.wins / strategy.trades : 0;
    strategy.expectancy = strategy.trades ? strategy.expectancy / strategy.trades : 0;
  }
  return result;
}
