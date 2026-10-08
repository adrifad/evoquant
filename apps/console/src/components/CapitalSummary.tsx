import { asRow, type Row } from "../lib/types";
import { formatAmount, formatNumber } from "../lib/format";
import { Metric } from "./Primitives";

export function CapitalSummary({ status }: { status: Row }) {
  const capital = asRow(status.capital) ?? {};
  return <section className="metric-strip capital-strip" aria-label="Account capital">
    <Metric label="Equity · USDT" value={formatAmount(capital.equity)} detail="Exchange account"/>
    <Metric label="Available · USDT" value={formatAmount(capital.available)} detail="Exchange available balance"/>
    <Metric label="Margin used · USDT" value={formatAmount(capital.margin_used)} detail={`${String(capital.margin_source ?? "UNAVAILABLE")} · open positions`}/>
    <Metric label="Capital utilization" value={capital.utilization_pct === null || capital.utilization_pct === undefined ? "N/A" : `${formatNumber(capital.utilization_pct)}%`} detail="Margin / USDT equity"/>
    <Metric label="Gross exposure · USD" value={formatAmount(capital.notional_usd, "USD")} detail="Exchange notional, both sides"/>
    <Metric label="Open risk · USDT" value={formatAmount(capital.open_risk)} detail="Estimated loss at stop, before costs"/>
  </section>;
}
