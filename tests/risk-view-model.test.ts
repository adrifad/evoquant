import assert from "node:assert/strict";
import { test } from "node:test";
import { assessRiskStatus, monitorGroupState } from "../apps/console/src/pages/risk-view-model.ts";

function status(overrides: Record<string, unknown> = {}) {
  return { botState: "RUNNING", emergencyHalted: false, persistedHaltReason: null, killReason: null,
    exchangeConnectivity: "CONNECTED", protectionVerificationStatus: "VERIFIED_OR_FLAT", newEntriesPermitted: true,
    equity: 1000, daily: { lossPct: 0.2 }, drawdownPct: 0.4,
    limits: { max_daily_loss_pct: 3, max_drawdown_pct: 10 },
    entryReadiness: { state: "PRELIMINARY_READY", permitted: true, blockers: [] },
    positionMonitoring: { SWING_15M: { required: false, health: "NOT_REQUIRED" }, SCALP_5M: { required: false, health: "NOT_REQUIRED" } },
    ...overrides };
}

test("risk presentation is safe only with fresh known inputs and precheck readiness", () => {
  assert.equal(assessRiskStatus(status(), 100_000, 101_000).assessment, "SAFE");
  assert.equal(assessRiskStatus(status({ daily: { lossPct: 2.5 } }), 100_000, 101_000).assessment, "WARNING");
  assert.equal(assessRiskStatus(status({ botState: "RISK_HALTED", persistedHaltReason: "PROTECTION_UNVERIFIED" }), 100_000, 101_000).assessment, "HALTED");
  assert.equal(assessRiskStatus(status(), 1, 40_000).assessment, "UNKNOWN");
  assert.equal(assessRiskStatus(null).assessment, "UNKNOWN");
});

test("readiness blockers remain explicit and not-required monitoring is neutral", () => {
  const blocked = status({ newEntriesPermitted: false, entryReadiness: { state: "BLOCKED", permitted: false,
    blockers: [{ code: "RECONCILIATION_PENDING", message: "Trade evidence needs reconciliation." }] } });
  const result = assessRiskStatus(blocked, 100_000, 101_000);
  assert.equal(result.readiness, "BLOCKED");
  assert.deepEqual(result.blockers, [{ code: "RECONCILIATION_PENDING", message: "Trade evidence needs reconciliation." }]);
  assert.equal(monitorGroupState(status().positionMonitoring as Record<string, unknown>), "NOT_REQUIRED");
  assert.equal(monitorGroupState(null), "UNKNOWN");
  const missingMonitor = assessRiskStatus(status({ positionMonitoring: null, openPositionCount: 1 }), 100_000, 101_000);
  assert.equal(missingMonitor.assessment, "UNKNOWN", "open positions without monitor telemetry must never be presented as safe");
  assert.match(missingMonitor.reasons.join(" "), /monitoring health is unavailable/i);
});
