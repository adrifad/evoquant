import assert from "node:assert/strict";
import { test } from "node:test";
import { roleHealthPresentation } from "../apps/console/src/lib/roleHealth.ts";

test("recovered role keeps its historical failure separate from the latest success", () => {
  const health = roleHealthPresentation({
    lastStatus: "SUCCESS",
    lastRequestAt: "2026-10-10T06:30:26.000Z",
    lastSuccess: "2026-10-10T06:30:26.000Z",
    lastFailure: "2026-10-10T05:58:10.000Z",
    lastFailureStatus: "INVALID_RESPONSE",
    lastFailureReason: "SCHEMA_MISMATCH",
    lastFailureHttpStatus: null,
  });
  assert.deepEqual(health, {
    currentStatus: "SUCCESS",
    currentTimestamp: "2026-10-10T06:30:26.000Z",
    currentReason: null,
    currentHttpStatus: null,
    previousFailureStatus: "INVALID_RESPONSE",
    previousFailureReason: "SCHEMA_MISMATCH",
    previousFailureHttpStatus: null,
    previousFailureTimestamp: "2026-10-10T05:58:10.000Z",
  });
});

test("currently failed role presents reason as part of the latest request", () => {
  const health = roleHealthPresentation({
    lastStatus: "INVALID_RESPONSE",
    lastRequestAt: "2026-10-10T08:55:15.000Z",
    lastFailure: "2026-10-10T08:55:15.000Z",
    lastFailureStatus: "INVALID_RESPONSE",
    lastFailureReason: "SCHEMA_MISMATCH",
  });
  assert.equal(health.currentStatus, "INVALID_RESPONSE");
  assert.equal(health.currentReason, "SCHEMA_MISMATCH");
  assert.equal(health.previousFailureStatus, null);
});

test("recovered HTTP failure does not attach an old HTTP status to success", () => {
  const health = roleHealthPresentation({
    lastStatus: "SUCCESS",
    lastRequestAt: "2026-10-10T06:30:26.000Z",
    lastSuccess: "2026-10-10T06:30:26.000Z",
    lastFailure: "2026-10-10T05:58:10.000Z",
    lastFailureStatus: "HTTP_ERROR",
    lastFailureReason: "HTTP_ERROR",
    lastFailureHttpStatus: 400,
  });
  assert.equal(health.currentHttpStatus, null);
  assert.equal(health.previousFailureStatus, "HTTP_ERROR");
  assert.equal(health.previousFailureReason, null);
  assert.equal(health.previousFailureHttpStatus, 400);
});

test("role with no calls has no current or historical health presentation", () => {
  const health = roleHealthPresentation({});
  assert.deepEqual(health, {
    currentStatus: null,
    currentTimestamp: null,
    currentReason: null,
    currentHttpStatus: null,
    previousFailureStatus: null,
    previousFailureReason: null,
    previousFailureHttpStatus: null,
    previousFailureTimestamp: null,
  });
});
