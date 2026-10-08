import { asNumber, asText, parseJson, type Row } from "../lib/types";
import { formatPercent } from "../lib/format";
import { Badge, Field, Panel } from "./Primitives";
import { parseVerdict } from "./PositionCard";

export function DecisionPanel({ decision }: { decision: Row | null }) {
  if (!decision) return <Panel title="Latest decision" subtitle="Recorded strategy action and deterministic risk">
    <div className="empty-state"><strong>Waiting for a recorded decision</strong><span>The first decision appears after the next evaluation cycle.</span></div>
  </Panel>;
  const action = asText(decision.decision, "UNKNOWN").toUpperCase();
  const tone = action === "LONG" ? "long" : action === "SHORT" ? "short" : "neutral";
  const verdict = parseVerdict(decision.risk_verdict);
  const approved = verdict.approved === true;
  const thesis = parseJson<unknown>(decision.thesis, []);
  const points = Array.isArray(thesis) ? thesis.map(item => typeof item === "string" ? item : JSON.stringify(item)) : typeof thesis === "string" ? [thesis] : [];
  const rawConfidence = asNumber(decision.raw_confidence);
  const calibratedConfidence = asNumber(decision.calibrated_confidence);

  return <Panel title="Latest decision" subtitle="Strategy Core determines the V2 direction. AI provides a context veto." className="decision-panel">
    <div className="decision-split">
      <section className="ai-decision" aria-label="Recorded action">
        <div className="decision-label">Recorded action</div>
        <strong className={`decision-action ${tone}`}>{action}</strong>
        <div className="confidence-pair">
          <div><span>Raw confidence</span><strong className="mono">{formatPercent(rawConfidence === null ? null : rawConfidence * 100, 0)}</strong></div>
          <div><span>Calibrated</span><strong className="mono">{formatPercent(calibratedConfidence === null ? null : calibratedConfidence * 100, 0)}</strong></div>
        </div>
        <div className="decision-fields">
          <Field label="Strategy" value={asText(decision.strategy)} mono={false}/>
          <Field label="Regime" value={asText(decision.regime)} mono={false}/>
        </div>
      </section>
      <section className={`risk-verdict ${approved ? "verdict-approved" : "verdict-rejected"}`} aria-label="Risk Engine decision">
        <div className="verdict-head"><span>Risk Engine</span><Badge tone={action === "HOLD" ? "neutral" : approved ? "positive" : "critical"}>{action === "HOLD" ? "NO ENTRY" : approved ? "APPROVED" : "REJECTED"}</Badge></div>
        <strong>{asText(verdict.reason, approved ? "Approved by deterministic checks" : "Reason not supplied")}</strong>
        <span className="verdict-note">Deterministic risk controls have final authority.</span>
      </section>
    </div>
    {points.length ? <div className="decision-reasoning"><div className="decision-label">Reasoning recorded with this decision</div><ul>{points.map((point, index) => <li key={`${index}-${point}`}>{point}</li>)}</ul></div> : null}
    {decision.invalidation ? <Field label="Invalidation" value={asText(decision.invalidation)} mono={false}/> : null}
  </Panel>;
}
