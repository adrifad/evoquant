import type { OkxClient } from "../exchange/okx/client.ts";
import type { InstrumentInfo, Position } from "../exchange/okx/types.ts";
import { amendConditionalStop, getAlgoOrder, normalizePriceToTick } from "../exchange/okx/algo.ts";
import type { Store } from "../memory/db.ts";
import { logSystemEvent } from "../memory/db.ts";
import { setBotState, setRiskHaltReason } from "../core/state.ts";
import { calculateSlPlusStop } from "./sl-plus.ts";
import { serializeTradeMutation } from "./trade-mutation.ts";

export interface SlPlusConfig {
  enabled: boolean;
  activation_r: number;
  lock_in_r: number;
  min_profit_buffer_pct: number;
}

export interface SlPlusResult {
  stopPx: number;
  updated: boolean;
}

export async function updateTradeStopPlus(
  client: OkxClient,
  store: Store,
  trade: Record<string, unknown>,
  position: Position,
  meta: InstrumentInfo,
  cfg: SlPlusConfig,
): Promise<SlPlusResult> {
  const tradeId = String(trade.trade_id ?? "");
  const oldStop = Number(trade.stop_px);
  if (!cfg.enabled || !tradeId || !(oldStop > 0)) return { stopPx: oldStop, updated: false };

  return serializeTradeMutation(tradeId, async () => {
    const current = store.db.prepare("SELECT * FROM trades WHERE trade_id=? AND status='OPEN'").get(tradeId) as Record<string, unknown> | undefined;
    if (!current) return { stopPx: oldStop, updated: false };
    const stopPx = Number(current.stop_px);
    const algoId = String(current.sl_algo_id ?? current.algo_id ?? "");
    const tpAlgoId = String(current.tp_algo_id ?? "");
    const candidate = calculateSlPlusStop({
      side: String(current.side) === "SHORT" ? "SHORT" : "LONG",
      entryPx: Number(current.entry_px),
      initialStopPx: Number(current.initial_stop_px ?? current.stop_px),
      currentStopPx: stopPx,
      markPx: Number(position.markPx),
      tickSz: Number(meta.tickSz),
      activationR: cfg.activation_r,
      lockInR: cfg.lock_in_r,
      minProfitBufferPct: cfg.min_profit_buffer_pct,
    });
    if (candidate === null) return { stopPx, updated: false };
    if (!algoId || !tpAlgoId || String(position.pos) === "0" || position.instId !== String(current.instrument)
      || meta.instId !== String(current.instrument) || !Number.isFinite(Number(meta.tickSz)) || Number(meta.tickSz) <= 0) {
      store.db.prepare("UPDATE trades SET protection_state='DEGRADED' WHERE trade_id=?").run(tradeId);
      setRiskHaltReason(store, "LIVE_POSITION_PROTECTION_UNVERIFIED");
      setBotState(store, "RISK_HALTED");
      logSystemEvent(store, "RISK_EVENT", { sl_plus_not_applied: "missing active position protection", tradeId, candidate });
      return { stopPx, updated: false };
    }

    try {
      await amendConditionalStop(client, { instId: String(current.instrument), algoId, stopPrice: candidate,
        tickSz: meta.tickSz, posSide: String(current.side) === "SHORT" ? "short" : "long" });
      const algo = await getAlgoOrder(client, String(current.instrument), algoId);
      const expectedStop = normalizePriceToTick(candidate, meta.tickSz, String(current.side) === "SHORT" ? "down" : "up");
      const normalized = Number(algo.slTriggerPx);
      const expectedSide = String(current.side) === "SHORT" ? "buy" : "sell";
      if (algo.state !== "live" || algo.instId !== String(current.instrument) || algo.tdMode !== "isolated"
        || algo.side !== expectedSide || algo.ordType !== "conditional" || algo.slTriggerPxType !== "mark"
        || algo.posSide !== String(current.side).toLowerCase() || !Number.isFinite(normalized)
        || Math.abs(normalized - Number(expectedStop)) > Math.max(Number(meta.tickSz) * 1e-9, 1e-12)) {
        throw new Error(`algo amendment not confirmed (state=${algo.state || "unknown"}, sl=${algo.slTriggerPx || "missing"})`);
      }
      const takeProfit = await getAlgoOrder(client, String(current.instrument), tpAlgoId);
      const expectedTakeProfit = normalizePriceToTick(Number(current.take_profit_px), meta.tickSz,
        String(current.side) === "SHORT" ? "up" : "down");
      if (takeProfit.state !== "live" || takeProfit.instId !== String(current.instrument) || takeProfit.tdMode !== "isolated"
        || takeProfit.side !== expectedSide || takeProfit.ordType !== "conditional" || takeProfit.tpTriggerPxType !== "mark"
        || takeProfit.posSide !== String(current.side).toLowerCase() || !Number.isFinite(Number(takeProfit.tpTriggerPx))
        || Math.abs(Number(takeProfit.tpTriggerPx) - Number(expectedTakeProfit)) > Math.max(Number(meta.tickSz) * 1e-9, 1e-12)) {
        throw new Error("take-profit protection is no longer verified after stop amendment");
      }
      const result = store.db.prepare(`UPDATE trades SET stop_px=? WHERE trade_id=? AND status='OPEN' AND stop_px=?`)
        .run(Number(expectedStop), tradeId, stopPx);
      if (result.changes !== 1) throw new Error("local stop changed during algo amendment; reconcile required");
      logSystemEvent(store, "SL_PLUS", { tradeId, previousStop: stopPx, stopPx: Number(expectedStop), activationR: cfg.activation_r });
      return { stopPx: Number(expectedStop), updated: true };
    } catch (error) {
      store.db.prepare("UPDATE trades SET protection_state='DEGRADED' WHERE trade_id=?").run(tradeId);
      setRiskHaltReason(store, "LIVE_POSITION_PROTECTION_UNVERIFIED");
      setBotState(store, "RISK_HALTED");
      logSystemEvent(store, "RISK_EVENT", {
        sl_plus_amend_failed: error instanceof Error ? error.message : String(error), tradeId, oldStop: stopPx, candidate,
        newEntriesHalted: true,
      });
      return { stopPx, updated: false };
    }
  });
}
