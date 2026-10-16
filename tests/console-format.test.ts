import assert from "node:assert/strict";
import test from "node:test";
import { formatMoney, formatPercent, formatR, formatTimestamp } from "../apps/console/src/lib/format.ts";

test("financial formatting distinguishes zero, small nonzero values, and unavailable values", () => {
  assert.equal(formatMoney(0), "0.00 USDT");
  assert.equal(formatMoney(0.001), "+0.001000 USDT");
  assert.equal(formatMoney(-0.0000001), "−<0.000001 USDT");
  assert.equal(formatMoney(null), "N/A");
  assert.equal(formatPercent(null), "N/A");
  assert.equal(formatR(null), "N/A");
});

test("timestamps label UTC explicitly regardless of host timezone", () => {
  assert.match(formatTimestamp("2026-10-16T00:00:00.000Z"), /UTC/);
});
