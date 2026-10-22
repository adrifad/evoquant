import { asNumber, asRow, asRows, asText, parseJson, type Row } from "../lib/types";
import { formatMoney, formatNumber, formatPercent, formatR, formatTimestamp, toneFor } from "../lib/format";
import { Badge, DataState, DataTable, Evidence, Field, Metric, PageHeading, Panel, StatusBadge } from "../components/Primitives";
import { useApi } from "../hooks/useApi";

type Strategy = Row & { name?: unknown; version?: unknown; parent_version?: unknown; params?: unknown; status?: unknown; hypothesis?: unknown; created_ts?: unknown };

export function StrategiesPage() {
  const api = useApi<unknown>("/api/strategies");
  const researchApi = useApi<unknown>("/api/research-intelligence");
  const data = asRow(api.data);
  const strategies = asRows(data?.strategies) as Strategy[];
  const matrix = asRow(data?.regimeMatrix) ?? {};
  const performance = aggregateStrategyStats(matrix);
  const research = asRow(researchApi.data);
  const evidence = asRow(research?.performance);
  const completeness = asRow(evidence?.completeness);
  const overall = asRow(evidence?.overall);
  const costGate = asRow(research?.costGate);
  const researchFunding = asRow(research?.researchFunding);
  const costByVerdict = asRow(costGate?.byVerdict) ?? {};
  const recentCosts = asRows(costGate?.recent);
  const suitability = asRow(research?.suitability);
  const suitabilitySummary = asRow(suitability?.summary) ?? {};
  const suitabilityScopes = asRows(suitability?.scopes);
  const shadowResults = asRows(research?.shadowResults);
  const comparisons = asRows(research?.championChallenger);

  return <div className="page">
    <PageHeading title="Strategies" description="Versioned research candidates with immutable parameters, verified NET evidence and observation-only suitability." detail={<Badge tone="info">VERSION REGISTRY</Badge>}/>

    <section className="metric-strip" aria-label="Research evidence summary">
      <Metric label="Verified NET trades" value={asText(completeness?.verifiedNetTrades, "N/A")} detail={`${asText(completeness?.closedTrades, "0")} closed, ${formatPercent(completeness?.evidenceCoveragePct, 1, false)} coverage`}/>
      <Metric label="NET expectancy" value={formatR(overall?.expectancyR)} tone={toneFor(overall?.expectancyR)} detail="Mean deterministic NET result R"/>
      <Metric label="Profit factor" value={asNumber(overall?.profitFactor) === null ? "N/A" : formatNumber(overall?.profitFactor, 2)} detail="Positive NET PnL / absolute negative NET PnL"/>
      <Metric label="NET realized PnL" value={formatMoney(overall?.netPnlUsdt)} tone={toneFor(overall?.netPnlUsdt)} detail={`${formatMoney(overall?.feesUsdt)} fees, ${formatMoney(overall?.fundingUsdt)} funding`}/>
      <Metric label="Trade-sequence drawdown" value={formatMoney(overall?.maxDrawdownUsdt)} tone={Number(overall?.maxDrawdownUsdt) > 0 ? "warning" : "neutral"} detail="Closed NET PnL, not account equity"/>
      <Metric label="Cost gate" value={asText(asRow(research?.mode)?.costGate, "SHADOW")} detail={`${asText(costGate?.total, "0")} observations · no authorization impact`}/>
    </section>

    <Panel title="Performance evidence" subtitle="Only complete, verified NET accounting contributes to profitability statistics" action={<Badge tone="info">M1</Badge>}>
      <DataState loading={researchApi.loading} error={researchApi.error} empty={!evidence} hasData={researchApi.data !== null} emptyTitle="No performance evidence yet" emptyDetail="Closed trades with complete exchange accounting appear here.">
        <div className="metric-strip compact-strip">
          <Metric label="Incomplete accounting" value={asText(completeness?.incompleteAccounting, "0")} detail="Excluded from NET statistics"/>
          <Metric label="Evidence pending" value={asText(completeness?.evidencePending, "0")} detail="Awaiting recovery"/>
          <Metric label="Uncertain exits" value={asText(completeness?.uncertainExitAttribution, "0")} detail="EXCHANGE_CLOSE_UNCLASSIFIED"/>
          <Metric label="Open / unrealized" value={asText(completeness?.openTrades, "0")} detail="Never included in realized PnL"/>
          <Metric label="Simulated shadow trades" value={asText(completeness?.simulatedResearchTrades, "0")} detail="Counterfactual research only"/>
          <Metric label="MFE/MAE coverage" value={asText(completeness?.excursionCoverage, "0")} detail="Raw price excursion, not profit"/>
        </div>
        <div className="strategy-detail-grid">
          <div>
            <h3>Verified cohorts</h3>
            <DataTable rows={asRows(evidence?.byEngine)} rowKey={row => asText(row.key)} minWidth={420} columns={[
              { key: "engine", label: "Engine", render: row => asText(row.key) },
              { key: "trades", label: "Trades", numeric: true, render: row => asText(asRow(row.metrics)?.trades, "0") },
              { key: "expectancy", label: "Expectancy", numeric: true, render: row => <span className={toneFor(asRow(row.metrics)?.expectancyR)}>{formatR(asRow(row.metrics)?.expectancyR)}</span> },
              { key: "pnl", label: "NET PnL", numeric: true, render: row => <span className={toneFor(asRow(row.metrics)?.netPnlUsdt)}>{formatMoney(asRow(row.metrics)?.netPnlUsdt)}</span> },
            ]}/>
          </div>
          <div>
            <h3>Evidence definitions</h3>
            <Field label="Net PnL" value="Exchange-derived gross − fees + funding" mono={false}/>
            <Field label="Expectancy" value="Mean verified NET result R" mono={false}/>
            <Field label="Drawdown" value="Peak-to-trough cumulative NET trade PnL" mono={false}/>
            <Field label="Excluded" value="Incomplete accounting, uncertain exits, unrealized, simulated" mono={false}/>
          </div>
        </div>
      </DataState>
    </Panel>

    <Panel title="Cost-aware NO_TRADE gate" subtitle="Deterministic economic assessment in SHADOW mode; never modifies entry authorization" action={<Badge tone="warning">OBSERVE ONLY</Badge>}>
      <div className="strategy-detail-grid">
        <Field label="Research NET funding" value={`${asText(researchFunding?.rateBpsPerSettlement, "N/A")} bps per ${asText(researchFunding?.settlementIntervalHours, "N/A")}h`} mono={false}/>
        <Field label="Funding assumption" value={asText(researchFunding?.source, "UNAVAILABLE").replaceAll("_", " ")} mono={false}/>
      </div>
      <div className="metric-strip compact-strip">
        {["ELIGIBLE_FOR_RESEARCH", "NO_TRADE_COST_DOMINATED", "NO_TRADE_INVALID_GEOMETRY", "NO_TRADE_UNSUPPORTED_REGIME", "UNPROVEN_EDGE", "INSUFFICIENT_DATA"].map(verdict =>
          <Metric key={verdict} label={verdict.replaceAll("_", " ")} value={asText(costByVerdict[verdict], "0")} detail="Persisted assessments"/>)}
      </div>
      <DataTable rows={recentCosts.slice(0, 12)} rowKey={(row, index) => `${asText(row.id, String(index))}`} minWidth={760} columns={[
        { key: "time", label: "Time", render: row => formatTimestamp(row.ts) },
        { key: "instrument", label: "Instrument", render: row => asText(row.instrument) },
        { key: "engine", label: "Engine", render: row => asText(row.engine) },
        { key: "side", label: "Side", render: row => <Badge tone={String(row.side).toLowerCase()}>{asText(row.side)}</Badge> },
        { key: "verdict", label: "Verdict", render: row => <StatusBadge value={row.verdict}/> },
        { key: "cost", label: "Cost / risk", numeric: true, render: row => formatNumber(row.costToRiskRatio, 3) },
        { key: "tp", label: "NET TP payout", numeric: true, render: row => <span className={toneFor(row.netPayoutAtTpR)}>{formatR(row.netPayoutAtTpR)}</span> },
        { key: "evidence", label: "Evidence", render: row => asText(row.evidenceQuality, "ESTIMATED_ONLY") },
      ]}/>
      {!recentCosts.length ? <div className="empty-state"><strong>No cost assessments recorded</strong><span>SHADOW observations appear after the next scanner cycle.</span></div> : null}
    </Panel>

    <Panel title="Strategy suitability" subtitle="Historical scoped evidence; observation-only and never an entry authorization" action={<Badge tone="info">M5</Badge>}>
      <div className="metric-strip compact-strip">
        {["ELIGIBLE", "UNPROVEN", "DISFAVORED", "NO_TRADE", "BLOCKED_BY_RISK"].map(decision =>
          <Metric key={decision} label={decision.replaceAll("_", " ")} value={asText(suitabilitySummary[decision], "0")} detail={`Minimum sample ${asText(suitability?.minimumSample, "20")}`}/>)}
      </div>
      <DataTable rows={suitabilityScopes.slice(0, 20)} rowKey={(row, index) => `${asText(row.engine)}-${asText(row.strategy)}-${asText(row.instrument)}-${asText(row.regime)}-${asText(row.direction)}-${index}`} minWidth={940} columns={[
        { key: "engine", label: "Engine", render: row => asText(row.engine) },
        { key: "strategy", label: "Strategy", render: row => `${asText(row.strategy)} C${asText(row.strategyCoreVersion)} V${asText(row.strategyVersion)}` },
        { key: "symbol", label: "Instrument", render: row => asText(row.instrument) },
        { key: "regime", label: "Regime", render: row => asText(row.regime) },
        { key: "side", label: "Side", render: row => asText(row.direction) },
        { key: "trades", label: "Trades", numeric: true, render: row => asText(asRow(row.metrics)?.trades, "0") },
        { key: "expectancy", label: "NET R", numeric: true, render: row => <span className={toneFor(asRow(row.metrics)?.netExpectancyR)}>{formatR(asRow(row.metrics)?.netExpectancyR)}</span> },
        { key: "decision", label: "Decision", render: row => <StatusBadge value={row.decision}/> },
        { key: "reason", label: "Reason", render: row => asText(row.reason).replaceAll("_", " ") },
      ]}/>
      {!suitabilityScopes.length ? <div className="empty-state"><strong>No verified scoped evidence</strong><span>Scopes remain unproven until complete NET trades exist.</span></div> : null}
    </Panel>

    <Panel title="Champion–Challenger and shadow results" subtitle="Simulated forward evidence remains separate from realized Demo NET PnL" action={<Badge tone="info">M4</Badge>}>
      {comparisons.length ? <DataTable rows={comparisons.slice(0, 10)} rowKey={(row, index) => `${asText(row.ts)}-${asText(row.challenger)}-${index}`} minWidth={760} columns={[
        { key: "time", label: "Time", render: row => formatTimestamp(row.ts) },
        { key: "champion", label: "Champion", render: row => asText(row.champion) },
        { key: "challenger", label: "Challenger", render: row => asText(row.challenger) },
        { key: "promoted", label: "Promoted", render: row => <Badge tone={row.promoted === 1 ? "positive" : "neutral"}>{row.promoted === 1 ? "YES" : "NO"}</Badge> },
        { key: "reasons", label: "Reasons", render: row => reasonList(row.reasons) },
      ]}/> : null}
      <DataTable rows={shadowResults.slice(0, 16)} rowKey={(row, index) => `${asText(row.strategy)}-${asText(row.strategy_version)}-${asText(row.shadow_role)}-${index}`} minWidth={640} columns={[
        { key: "strategy", label: "Strategy", render: row => `${asText(row.strategy)} C${asText(row.strategy_core_version)} V${asText(row.strategy_version)}` },
        { key: "role", label: "Role", render: row => <StatusBadge value={row.shadow_role}/> },
        { key: "trades", label: "Closed", numeric: true, render: row => asText(row.trades, "0") },
        { key: "expectancy", label: "Shadow NET R", numeric: true, render: row => <span className={toneFor(row.expectancy_r)}>{formatR(row.expectancy_r)}</span> },
        { key: "wins", label: "Wins", numeric: true, render: row => asText(row.wins, "0") },
      ]}/>
      {!shadowResults.length ? <div className="empty-state"><strong>No closed shadow trades</strong><span>Challenger promotion cannot be inferred from an empty sample.</span></div> : null}
    </Panel>

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

function reasonList(value: unknown): string {
  const parsed = parseJson<unknown>(value, []);
  if (Array.isArray(parsed)) return parsed.map(String).filter(Boolean).join("; ") || "None";
  return asText(parsed, "None");
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
