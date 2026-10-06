import type { Candle } from "../exchange/okx/types.ts";
import type { FeatureSnapshot } from "../market/features.ts";
import { calculateExecutionCostR, type V2CostModel } from "./backtest.ts";
import { calculateSlPlusStop } from "../execution/sl-plus.ts";
import { logSystemEvent, type Store } from "../memory/db.ts";
import { evaluateV2Setup, type StrategyV2Id } from "../strategy/core-v2.ts";
import { completeV2Params, listV2Versions } from "../strategy/v2-registry.ts";

export interface ShadowSnapshot { instrument: string; features: FeatureSnapshot }
interface ShadowRow {
  shadow_trade_id: string; strategy: StrategyV2Id; strategy_version: number; instrument: string;
  side: "LONG" | "SHORT"; status: "PENDING" | "OPEN"; signal_ts: number; last_processed_ts: number;
  entry_ts: number | null; entry_price: number | null; stop_price: number | null; initial_stop_price: number | null;
  take_profit_price: number | null; stop_atr: number; target_r: number; max_hold_bars: number; bars_held: number;
  risk_distance: number | null; active_stop: number | null; costs_json: string; mfe_r: number; mae_r: number;
}

/** Shadow-only simulation. This module deliberately has no exchange client or order API imports. */
export function processShadowCycle(store: Store, snapshots: ShadowSnapshot[], histories: ReadonlyMap<string, Candle[]>,
  timeframe: string, costs: V2CostModel): number {
  void timeframe;
  let inserted = 0;
  const challengers = listV2Versions(store).filter((version) => version.status === "SHADOW");
  for (const version of challengers) {
    for (const snapshot of snapshots) {
      const candles = (histories.get(snapshot.instrument) ?? []).filter((c) => c.confirm === "1").slice().sort((a, b) => a.ts - b.ts);
      if (candles.length === 0) continue;
      processExisting(store, version.strategy, version.version, snapshot.instrument, candles);
      const occupied = store.db.prepare(`SELECT 1 AS open FROM shadow_trades WHERE strategy=? AND strategy_version=?
        AND instrument=? AND status IN ('PENDING','OPEN') LIMIT 1`).get(version.strategy, version.version, snapshot.instrument);
      if (occupied) continue;
      const candidate = evaluateV2Setup(version.strategy, snapshot.features, candles,
        completeV2Params(version.strategy, version.params), version.version).candidate;
      if (!candidate) continue;
      const shadowId = `SHD-${version.strategy}-${version.version}-${snapshot.instrument}-${candidate.signalTs}`;
      const riskDistance = candidate.stopAtr * candidate.features.atr14;
      const res = store.db.prepare(`INSERT OR IGNORE INTO shadow_trades
        (shadow_trade_id,engine,strategy,strategy_version,instrument,side,status,signal_ts,last_processed_ts,signal_price,
         stop_atr,target_r,max_hold_bars,risk_distance,regime,regime_axes,entry_conditions,costs_json)
        VALUES(?,'SWING_15M',?,?,?,?,'PENDING',?,?,?,?,?,?,?,?,?,?,?)`)
        .run(shadowId, version.strategy, version.version, snapshot.instrument, candidate.side, candidate.signalTs,
          candidate.signalTs, candidate.entryPrice, candidate.stopAtr, candidate.targetR, candidate.maxHoldBars,
          riskDistance, candidate.regime.trend, JSON.stringify(candidate.regime), JSON.stringify(candidate.conditions), JSON.stringify(costs));
      if (res.changes > 0) inserted++;
    }
  }
  return inserted;
}

function processExisting(store: Store, strategy: StrategyV2Id, version: number, instrument: string,
  candles: Candle[]): void {
  const rows = store.db.prepare(`SELECT * FROM shadow_trades WHERE strategy=? AND strategy_version=? AND instrument=?
    AND status IN ('PENDING','OPEN') ORDER BY signal_ts`).all(strategy, version, instrument) as ShadowRow[];
  for (const row of rows) {
    const rowCosts = JSON.parse(row.costs_json) as V2CostModel;
    const remaining = candles.filter((c) => c.ts > row.last_processed_ts);
    for (const candle of remaining) {
      if (row.status === "PENDING") {
        if (candle.ts <= row.signal_ts) continue;
        enterShadow(store, row, candle);
        Object.assign(row, { status: "OPEN", entry_ts: candle.ts, entry_price: candle.o,
          stop_price: stopPrice(candle.o, row.side, row.risk_distance ?? 0),
          initial_stop_price: stopPrice(candle.o, row.side, row.risk_distance ?? 0),
          take_profit_price: targetPrice(candle.o, row.side, row.risk_distance ?? 0, row.target_r),
          active_stop: stopPrice(candle.o, row.side, row.risk_distance ?? 0), bars_held: 0, mfe_r: 0, mae_r: 0 });
      }
      if (row.status !== "OPEN" || row.entry_price === null || row.risk_distance === null || row.active_stop === null) continue;
      const sign = row.side === "LONG" ? 1 : -1;
      if (row.bars_held >= row.max_hold_bars) {
        closeShadow(store, row, candle, candle.o, "TIME_STOP", rowCosts);
        Object.assign(row, { status: "CLOSED", last_processed_ts: candle.ts });
        break;
      }
      const favorable = row.side === "LONG" ? candle.h - row.entry_price : row.entry_price - candle.l;
      const adverse = row.side === "LONG" ? row.entry_price - candle.l : candle.h - row.entry_price;
      row.mfe_r = Math.max(row.mfe_r, favorable / row.risk_distance);
      row.mae_r = Math.max(row.mae_r, adverse / row.risk_distance);
      const stopHit = row.side === "LONG" ? candle.l <= row.active_stop : candle.h >= row.active_stop;
      const targetHit = row.take_profit_price !== null && (row.side === "LONG" ? candle.h >= row.take_profit_price : candle.l <= row.take_profit_price);
      if (stopHit) {
        const fill = row.side === "LONG" ? Math.min(candle.o, row.active_stop) : Math.max(candle.o, row.active_stop);
        closeShadow(store, row, candle, fill, row.active_stop === row.initial_stop_price ? "SL" : "SL_PLUS", rowCosts);
        Object.assign(row, { status: "CLOSED", last_processed_ts: candle.ts });
        break;
      }
      if (targetHit && row.take_profit_price !== null) {
        closeShadow(store, row, candle, row.take_profit_price, "TP", rowCosts);
        Object.assign(row, { status: "CLOSED", last_processed_ts: candle.ts });
        break;
      }
      if (rowCosts.slPlus.enabled && favorable / row.risk_distance >= rowCosts.slPlus.activationR) {
        const nextStop = calculateSlPlusStop({ side: row.side, entryPx: row.entry_price,
          initialStopPx: row.initial_stop_price ?? row.stop_price ?? row.entry_price,
          currentStopPx: row.active_stop, markPx: candle.c, tickSz: Math.max(row.entry_price * 1e-8, Number.EPSILON),
          activationR: rowCosts.slPlus.activationR, lockInR: rowCosts.slPlus.lockInR,
          minProfitBufferPct: rowCosts.slPlus.minProfitBufferPct });
        if (nextStop !== null) row.active_stop = nextStop;
      }
      row.bars_held++;
      row.last_processed_ts = candle.ts;
      store.db.prepare(`UPDATE shadow_trades SET status='OPEN',last_processed_ts=?,bars_held=?,active_stop=?,stop_price=?,mfe_r=?,mae_r=?
        WHERE shadow_trade_id=? AND status='OPEN'`).run(row.last_processed_ts, row.bars_held,
        row.active_stop, row.active_stop, row.mfe_r, row.mae_r, row.shadow_trade_id);
    }
  }
}

function enterShadow(store: Store, row: ShadowRow, candle: Candle): void {
  const risk = row.risk_distance ?? 0;
  const stop = stopPrice(candle.o, row.side, risk);
  store.db.prepare(`UPDATE shadow_trades SET status='OPEN',entry_ts=?,entry_price=?,stop_price=?,initial_stop_price=?,
    take_profit_price=?,active_stop=?,last_processed_ts=? WHERE shadow_trade_id=? AND status='PENDING'`)
    .run(candle.ts, candle.o, stop, stop, targetPrice(candle.o, row.side, risk, row.target_r), stop, row.last_processed_ts, row.shadow_trade_id);
  logSystemEvent(store, "CHALLENGER_SHADOW_PROGRESS", { strategy: row.strategy, version: row.strategy_version,
    instrument: row.instrument, state: "entry_filled", signalTs: row.signal_ts, entryTs: candle.ts });
}

function closeShadow(store: Store, row: ShadowRow, candle: Candle, exitPrice: number,
  reason: "SL" | "TP" | "SL_PLUS" | "TIME_STOP", costs: V2CostModel): void {
  if (row.entry_price === null || row.risk_distance === null) return;
  const grossR = ((exitPrice - row.entry_price) * (row.side === "LONG" ? 1 : -1)) / row.risk_distance;
  const feesR = calculateExecutionCostR(row.entry_price, exitPrice, row.risk_distance, costs);
  store.db.prepare(`UPDATE shadow_trades SET status='CLOSED',exit_ts=?,exit_price=?,exit_reason=?,gross_r=?,net_r=?,fees_r=?,
    bars_held=bars_held+1,last_processed_ts=?,mfe_r=?,mae_r=? WHERE shadow_trade_id=? AND status='OPEN'`)
    .run(candle.ts, exitPrice, reason, grossR, grossR - feesR, feesR, candle.ts,
      row.mfe_r, row.mae_r, row.shadow_trade_id);
  logSystemEvent(store, "CHALLENGER_SHADOW_PROGRESS", { strategy: row.strategy, version: row.strategy_version,
    instrument: row.instrument, state: "trade_closed", tradeId: row.shadow_trade_id, reason, netR: grossR - feesR });
}

function stopPrice(entry: number, side: "LONG" | "SHORT", risk: number): number { return entry - (side === "LONG" ? 1 : -1) * risk; }
function targetPrice(entry: number, side: "LONG" | "SHORT", risk: number, targetR: number): number { return entry + (side === "LONG" ? 1 : -1) * risk * targetR; }
