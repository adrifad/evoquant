import assert from "node:assert/strict";
import test from "node:test";
import { areRequiredPositionMonitorsOperational, PositionMonitorHealthTracker, runMonitorItemsIsolated } from "../src/core/monitor-health.ts";

test("monitor health reports successful sweeps and returns from DEGRADED to HEALTHY", async () => {
  const tracker = new PositionMonitorHealthTracker();
  await tracker.execute("SCALP_5M", async () => undefined);
  let scalp = tracker.snapshot({ SWING_15M: false, SCALP_5M: true }).SCALP_5M;
  assert.equal(scalp.health, "HEALTHY");
  assert.ok(scalp.lastAttemptAt);
  assert.ok(scalp.lastSuccessfulSweepAt);
  assert.ok(Date.parse(scalp.lastSuccessfulSweepAt) >= Date.parse(scalp.lastAttemptAt!));
  const completeSweepAt = scalp.lastSuccessfulSweepAt;

  await tracker.execute("SCALP_5M", async (partialFailure) => partialFailure(new Error("one instrument failed")));
  scalp = tracker.snapshot({ SWING_15M: false, SCALP_5M: true }).SCALP_5M;
  assert.equal(scalp.health, "DEGRADED");
  assert.equal(scalp.lastError, "one instrument failed");
  assert.equal(scalp.lastSuccessfulSweepAt, completeSweepAt, "partial sweeps must not advance complete-success time");
  assert.ok(scalp.lastPartialSweepAt);

  await tracker.execute("SCALP_5M", async () => undefined);
  scalp = tracker.snapshot({ SWING_15M: false, SCALP_5M: true }).SCALP_5M;
  assert.equal(scalp.health, "HEALTHY");
  assert.equal(scalp.lastError, "one instrument failed", "last error remains historical after recovery");
});

test("monitor health exposes repeated exchange failure, stale heartbeat, and non-required states", async () => {
  const tracker = new PositionMonitorHealthTracker();
  for (let i = 0; i < 3; i++) await tracker.execute("SWING_15M", async () => { throw new Error("exchange timeout"); });
  let swing = tracker.snapshot({ SWING_15M: true, SCALP_5M: false }).SWING_15M;
  assert.equal(swing.health, "FAILED");
  assert.equal(swing.consecutiveFailures, 3);
  assert.equal(swing.lastError, "exchange timeout");
  assert.equal(tracker.snapshot({ SWING_15M: false, SCALP_5M: false }).SWING_15M.health, "NOT_REQUIRED");

  await tracker.execute("SCALP_5M", async () => undefined);
  swing = tracker.snapshot({ SWING_15M: true, SCALP_5M: false }, Date.now() + 1_000_000).SWING_15M;
  assert.equal(swing.health, "FAILED");
  assert.equal(tracker.snapshot({ SWING_15M: false, SCALP_5M: true }).SCALP_5M.health, "HEALTHY");
});

test("overlapping monitor sweeps are skipped and running state is observable", async () => {
  const tracker = new PositionMonitorHealthTracker();
  let release!: () => void;
  let entered!: () => void;
  const enteredRun = new Promise<void>(resolve => { entered = resolve; });
  const work = new Promise<void>(resolve => { release = resolve; });
  const first = tracker.execute("SWING_15M", async () => { entered(); await work; });
  await enteredRun;
  assert.equal(tracker.snapshot({ SWING_15M: true, SCALP_5M: false }).SWING_15M.currentlyRunning, true);
  assert.equal(await tracker.execute("SWING_15M", async () => { throw new Error("must not overlap"); }), false);
  release();
  assert.equal(await first, true);
  assert.equal(tracker.snapshot({ SWING_15M: true, SCALP_5M: false }).SWING_15M.currentlyRunning, false);
});

test("one position failure does not prevent later position checks", async () => {
  const visited: string[] = [];
  const failures: string[] = [];
  await runMonitorItemsIsolated(["BTC", "ETH", "SOL"], async (instrument) => {
    visited.push(instrument);
    if (instrument === "ETH") throw new Error("temporary exchange read failure");
  }, (instrument, error) => failures.push(`${instrument}:${(error as Error).message}`));
  assert.deepEqual(visited, ["BTC", "ETH", "SOL"]);
  assert.deepEqual(failures, ["ETH:temporary exchange read failure"]);
});

test("account monitoring operational flag requires at least one active required monitor", () => {
  assert.equal(areRequiredPositionMonitorsOperational(null), false);
  assert.equal(areRequiredPositionMonitorsOperational({
    SWING_15M: { enabled: true, required: false, lastAttemptAt: null, lastSuccessfulSweepAt: null, lastPartialSweepAt: null,
      lastErrorAt: null, lastError: null, consecutiveFailures: 0, currentlyRunning: false, durationMs: null, health: "NOT_REQUIRED" },
    SCALP_5M: { enabled: true, required: false, lastAttemptAt: null, lastSuccessfulSweepAt: null, lastPartialSweepAt: null,
      lastErrorAt: null, lastError: null, consecutiveFailures: 0, currentlyRunning: false, durationMs: null, health: "NOT_REQUIRED" },
  }), false);
});
