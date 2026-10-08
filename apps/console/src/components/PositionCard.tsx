import { ArrowDownRight, ArrowUpRight, CircleMinus } from "lucide-react";
import { asNumber, asRow, asText, parseJson, type Row } from "../lib/types";
import { formatDuration, formatMoney, formatPercent, formatPrice, formatR, toneFor } from "../lib/format";
import { Badge, Field, Panel } from "./Primitives";

export function PositionCard({ status }: { status: Row }) {
  const positions = Array.isArray(status.openPositions) ? status.openPositions : [];
  const mappedPosition = asRow(positions[0]);
  const position = mappedPosition
    ? { ...mappedPosition, ...(asRow(status.openPosition) ?? {}), live: mappedPosition.live }
    : asRow(status.openPosition);
  if (!position) {
    const decision = asRow(status.latestDecision);
    const verdict = parseVerdict(decision?.risk_verdict);
    const thesis = parseJson<unknown>(decision?.thesis, []);
    const holdReason = Array.isArray(thesis) ? thesis.map(item => typeof item === "string" ? item : JSON.stringify(item)).join(" | ") : typeof thesis === "string" ? thesis : "";
    const contextReason = holdReason || asText(verdict.reason, "No HOLD reason recorded");
    return <Panel title="Current position" subtitle="Exchange-sourced position state" className="position-panel position-empty">
      <div className="no-position"><CircleMinus size={19} aria-hidden="true"/><strong>NO OPEN POSITION</strong><span>There is no active position on the account.</span></div>
      <div className="empty-context">
        <div><span>Latest decision</span><strong>{asText(decision?.decision, "Waiting for decision")}</strong></div>
        <div><span>Risk Engine</span><strong>{asText(verdict.reason, "No risk verdict")}</strong></div>
        <p>{decision && String(decision.decision) === "HOLD" ? contextReason : "The next evaluation runs on the configured candle schedule."}</p>
      </div>
    </Panel>;
  }
  const side = asText(position.side, "N/A");
  const liveKnown = position.live !== false;
  const pnl = liveKnown ? asNumber(position.upl) : null;
  const strategy = position.strategy_version ? `${asText(position.strategy)} V${asText(position.strategy_version)}` : asText(position.strategy);
  const Icon = side === "LONG" ? ArrowUpRight : ArrowDownRight;

  return <Panel title="Current position" subtitle="Exchange mark and unrealized PnL" className={`position-panel position-${side.toLowerCase()}`}>
    <div className="position-heading">
      <div><span className="position-symbol">{asText(position.instrument)}</span><span className="position-id">{asText(position.trade_id)}</span></div>
      <Badge tone={side === "LONG" ? "long" : "short"}><Icon size={13} aria-hidden="true"/>{side}</Badge>
    </div>
    <div className="position-main-metrics">
        <div><span>Unrealized PnL</span><strong className={`mono ${toneFor(pnl)}`}>{formatMoney(pnl)}</strong><small>{liveKnown ? `${formatR(position.r)} price return, before costs` : "Live return unavailable"}</small></div>
      <div className="position-live-state"><span className={position.live === false ? "state-dot state-muted" : "state-dot"}/>{position.live === false ? "Mark unavailable" : "Exchange mark live"}</div>
    </div>
    <div className="position-grid">
      <Field label="Entry" value={formatPrice(position.entry_px)}/>
      <Field label="Mark" value={liveKnown ? formatPrice(position.mark_px) : "Unavailable"}/>
      <Field label="Stop loss" value={formatPrice(position.stop_px)} tone="negative"/>
      <Field label="Take profit" value={formatPrice(position.take_profit_px)} tone="positive"/>
      <Field label="Contracts" value={asText(position.contracts)}/>
      <Field label="Duration" value={formatDuration(position.duration_s)}/>
      <Field label="Actual leverage" value={asNumber(position.actual_leverage) === null ? "Unavailable" : `${asText(position.actual_leverage)}x`} detail={position.leverage_mismatch ? "Differs from configured leverage" : asText(position.margin_mode, "Exchange value")}/>
      <Field label="Strategy" value={strategy} mono={false}/>
      <Field label="Regime" value={asText(position.regime ?? status.regime)} mono={false}/>
    </div>
  </Panel>;
}

export function parseVerdict(value: unknown): Row {
  if (typeof value === "string") {
    try { return asRow(JSON.parse(value)) ?? {}; } catch { return {}; }
  }
  return asRow(value) ?? {};
}
