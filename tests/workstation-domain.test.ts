import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { accountCapital, finite, linearContract, positionCapital } from "../src/core/capital.ts";
import { setEnvKeys } from "../src/core/settings.ts";
import type { InstrumentInfo, Position } from "../src/exchange/okx/types.ts";

const meta: InstrumentInfo = { instId: "BTC-USDT-SWAP", ctVal: "0.01", ctValCcy: "BTC", lotSz: "0.01", minSz: "0.01", tickSz: "0.1" };
const trade = { instrument: meta.instId, side: "LONG", entry_px: 100, stop_px: 95, initial_stop_px: 90, contracts: "10" };
const position: Position = { posId: "p", instId: meta.instId, posSide: "long", pos: "10", avgPx: "100", markPx: "110",
  lever: "5", upl: "1", mgnMode: "isolated", ccy: "USDT", margin: "3", imr: "2", notionalUsd: "10.99" };
const balance = { totalEq: "1200", details: [{ ccy: "USDT", eq: "1000", availEq: "990", availBal: "980" },
  { ccy: "BTC", eq: "0.002", availEq: "0.001", availBal: "0.001" }] };

test("linear contract cash risk uses ctVal and exchange leverage, with initial and current stops distinct", () => {
  const row = positionCapital(trade, position, meta, 1000, 2);
  assert.equal(row.actual_leverage, 5);
  assert.equal(row.configured_leverage, 2);
  assert.equal(row.leverage_mismatch, true);
  assert.equal(row.margin_used, 3);
  assert.equal(row.margin_source, "EXCHANGE");
  assert.equal(row.notional_usd, 10.99);
  assert.equal(row.notional_usdt, 11);
  assert.equal(row.initial_risk, 1);
  assert.equal(row.risk_at_stop, 0.5);
  assert.equal(row.potential_loss_to_stop, 1.5);
  assert.equal(row.risk_pct, 0.1);
  assert.equal(positionCapital({ ...trade, stop_px: 105 }, position, meta, 1000, 2).risk_at_stop, 0);
  const short = positionCapital({ ...trade, side: "SHORT", stop_px: 105 }, { ...position, posSide: "short", markPx: "90", notionalUsd: "-9" }, meta, 1000, 2);
  assert.equal(short.risk_at_stop, 0.5);
  assert.equal(short.potential_loss_to_stop, 1.5);
  assert.equal(short.notional_usd, 9);
});

test("cross IMR and non-USDT collateral never become actual USDT margin", () => {
  const cross = positionCapital(trade, { ...position, mgnMode: "cross" }, meta, 1000, 2);
  assert.equal(cross.cross_imr_usd, 2);
  assert.equal(cross.margin_used, null);
  assert.equal(cross.margin_source, "UNAVAILABLE");
  const estimate = positionCapital(trade, { ...position, margin: "" }, meta, 1000, 2);
  assert.equal(estimate.margin_used, 2.2);
  assert.equal(estimate.margin_source, "ESTIMATED");
  const inverse = { ...meta, instId: "BTC-USD-SWAP", ctValCcy: "USD" };
  assert.equal(linearContract(inverse), false);
  const unsupported = positionCapital({ ...trade, instrument: inverse.instId }, { ...position, instId: inverse.instId, ccy: "BTC" }, inverse, 1000, 2);
  assert.equal(unsupported.margin_used, null);
  assert.equal(unsupported.risk_at_stop, null);
  assert.equal(unsupported.notional_usd, 10.99);
  assert.equal(positionCapital(trade, position, inverse, 1000, 2).risk_at_stop, null);
});

test("unknown values remain unavailable while exchange zero and an empty position set remain genuine zero", () => {
  for (const missing of [undefined, null, "", "  ", "NaN", "Infinity", false, [], {}]) assert.equal(finite(missing), null);
  assert.equal(finite("0"), 0);
  const unknown = positionCapital({}, undefined, undefined, null, 2);
  assert.equal(unknown.margin_used, null);
  assert.equal(unknown.risk_at_stop, null);
  assert.equal(unknown.actual_leverage, null);
  assert.equal(unknown.upl, null);
  assert.equal(accountCapital(null, null, [], {}, 2).margin_used, null);
  assert.equal(accountCapital(balance, [], [], {}, 2).margin_used, 0);
  const malformed = accountCapital(balance, [{ ...position, pos: "", notionalUsd: "", margin: "" }], [trade], { [meta.instId]: meta }, 2);
  assert.equal(malformed.exchange_positions, 1);
  assert.equal(malformed.margin_used, null);
  assert.equal(malformed.open_risk, null);
});

test("account sums keep USD exposure, USDT equity and margin distinct and fail closed on incomplete positions", () => {
  const result = accountCapital(balance, [position], [trade], { [meta.instId]: meta }, 2);
  assert.equal(result.equity, 1000);
  assert.equal(result.total_equity_usd, 1200);
  assert.equal(result.available, 980);
  assert.equal(result.margin_used, 3);
  assert.equal(result.utilization_pct, 0.3);
  assert.equal(result.notional_usd, 10.99);
  const incomplete = accountCapital(balance, [position, { ...position, posId: "cross", mgnMode: "cross", posSide: "short", notionalUsd: "" }], [trade], { [meta.instId]: meta }, 2);
  assert.equal(incomplete.margin_used, null);
  assert.equal(incomplete.notional_usd, null);
  assert.equal(incomplete.long_exposure_usd, 10.99);
  assert.equal(incomplete.short_exposure_usd, null);
  assert.equal(incomplete.open_risk, null);
});

test("settings writes are private and atomic and reject line injection before touching the file", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "evoq-settings-")), file = path.join(root, ".env");
  try {
    writeFileSync(file, "# retain\nOKX_SECRET=untouched\nLLM_GATE_MODEL=old\n", { mode: 0o644 });
    setEnvKeys(file, { LLM_GATE_MODEL: "new", LLM_GATE_API_KEY: "fixture=key" });
    const saved = readFileSync(file, "utf8");
    assert.match(saved, /OKX_SECRET=untouched/);
    assert.match(saved, /LLM_GATE_MODEL=new/);
    assert.match(saved, /LLM_GATE_API_KEY=fixture=key/);
    assert.equal(statSync(file).mode & 0o777, 0o600);
    for (const bad of ["bad\nINJECTED=true", "bad\rINJECTED=true", "bad\0"]) {
      assert.throws(() => setEnvKeys(file, { LLM_GATE_API_KEY: bad }), /Invalid settings value/);
      assert.equal(readFileSync(file, "utf8"), saved);
    }
    assert.throws(() => setEnvKeys(file, { "INVALID-KEY": "value" }), /Invalid settings value/);
    assert.deepEqual(readdirSync(root), [".env"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
