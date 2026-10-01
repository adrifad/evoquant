// M7 (§35/§52) — performance statistics over closed trades (list of R).
export interface PerfSummary {
  trades: number; win_rate: number; expectancy_r: number;
  avg_win_r: number; avg_loss_r: number; profit_factor: number;
  max_drawdown_pct: number; equity_curve_end: number;
}

export function summarize(rs: number[], initialEquity = 100, riskPctPerTrade = 0.5): PerfSummary {
  const trades = rs.length;
  if (trades === 0) {
    return { trades: 0, win_rate: 0, expectancy_r: 0, avg_win_r: 0, avg_loss_r: 0, profit_factor: 0, max_drawdown_pct: 0, equity_curve_end: initialEquity };
  }
  const wins = rs.filter((r) => r > 0);
  const losses = rs.filter((r) => r < 0);
  const sumWin = wins.reduce((a, b) => a + b, 0);
  const sumLoss = Math.abs(losses.reduce((a, b) => a + b, 0));
  // equity curve: each R = riskPctPerTrade of current equity
  let eq = initialEquity, peak = initialEquity, maxDD = 0;
  for (const r of rs) {
    eq *= 1 + r * (riskPctPerTrade / 100);
    peak = Math.max(peak, eq);
    maxDD = Math.max(maxDD, (peak - eq) / peak * 100);
  }
  return {
    trades,
    win_rate: wins.length / trades,
    expectancy_r: rs.reduce((a, b) => a + b, 0) / trades,
    avg_win_r: wins.length ? sumWin / wins.length : 0,
    avg_loss_r: losses.length ? -sumLoss / losses.length : 0,
    profit_factor: sumLoss > 0 ? sumWin / sumLoss : (sumWin > 0 ? Infinity : 0),
    max_drawdown_pct: Math.round(maxDD * 100) / 100,
    equity_curve_end: Math.round(eq * 1000) / 1000,
  };
}
