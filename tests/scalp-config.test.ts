import { test } from "node:test";
import assert from "node:assert/strict";
import { loadTradingConfig, ScalpConfigSchema } from "../src/core/config.ts";

test("production Scalp runtime receives the Moderate profile without changing size or trade cap", () => {
  const scalp = loadTradingConfig().scalp!;
  assert.deepEqual({
    ema_fast: scalp.ema_fast, ema_slow: scalp.ema_slow, rsi_period: scalp.rsi_period,
    rsi_long_min: scalp.rsi_long_min, rsi_long_max: scalp.rsi_long_max,
    rsi_short_min: scalp.rsi_short_min, rsi_short_max: scalp.rsi_short_max,
    vol_burst_min: scalp.vol_burst_min, min_score: scalp.min_score,
    stop_atr_mult: scalp.stop_atr_mult, tp_r: scalp.tp_r, min_tp_pct: scalp.min_tp_pct,
    cooldown_s: scalp.cooldown_s, max_daily_trades: scalp.max_daily_trades,
    stance_refresh_s: scalp.stance_refresh_s, llm_gate: scalp.llm_gate,
    position_pct: scalp.position_pct,
  }, {
    ema_fast: 9, ema_slow: 21, rsi_period: 7,
    rsi_long_min: 48, rsi_long_max: 72, rsi_short_min: 28, rsi_short_max: 52,
    vol_burst_min: 1.1, min_score: 0.55,
    stop_atr_mult: 1.4, tp_r: 2, min_tp_pct: 0.25,
    cooldown_s: 240, max_daily_trades: 20, stance_refresh_s: 900,
    llm_gate: true, position_pct: 20,
  });
});

test("Scalp config keeps bounded fields and rejects invalid EMA/RSI ordering", () => {
  const base = loadTradingConfig().scalp!;
  assert.equal(ScalpConfigSchema.safeParse({ ...base, ema_fast: base.ema_slow }).success, false);
  assert.equal(ScalpConfigSchema.safeParse({ ...base, rsi_long_min: base.rsi_long_max }).success, false);
  assert.equal(ScalpConfigSchema.safeParse({ ...base, rsi_short_min: base.rsi_short_max }).success, false);
  assert.equal(ScalpConfigSchema.safeParse({ ...base, min_score: 1.5 }).success, false);
});
