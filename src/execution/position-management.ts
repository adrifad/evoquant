import type { OkxClient } from "../exchange/okx/client.ts";
import type { InstrumentInfo, Position } from "../exchange/okx/types.ts";
import { amendConditionalStop, getAlgoOrder } from "../exchange/okx/algo.ts";
import type { Store } from "../memory/db.ts";
import { logSystemEvent } from "../memory/db.ts";
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
    const algoId = String(current.algo_id ?? "");
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
    if (!algoId || String(position.pos) === "0" || position.instId !== String(current.instrument)) {
      logSystemEvent(store, "RISK_EVENT", { sl_plus_not_applied: "missing active position protection", tradeId, candidate });
      return { stopPx, updated: false };
    }

    try {
      await amendConditionalStop(client, { instId: String(current.instrument), algoId, stopPrice: candidate });
      const algo = await getAlgoOrder(client, String(current.instrument), algoId);
      if (algo.state !== "live" || Math.abs(Number(algo.slTriggerPx) - candidate) > Number(meta.tickSz) / 2) {
        throw new Error(`algo amendment not confirmed (state=${algo.state || "unknown"}, sl=${algo.slTriggerPx || "missing"})`);
      }
      const result = store.db.prepare(`UPDATE trades SET stop_px=? WHERE trade_id=? AND status='OPEN' AND stop_px=?`)
        .run(candidate, tradeId, stopPx);
      if (result.changes !== 1) throw new Error("local stop changed during algo amendment; reconcile required");
      logSystemEvent(store, "SL_PLUS", { tradeId, previousStop: stopPx, stopPx: candidate, activationR: cfg.activation_r });
      return { stopPx: candidate, updated: true };
    } catch (error) {
      logSystemEvent(store, "RISK_EVENT", {
        sl_plus_amend_failed: error instanceof Error ? error.message : String(error), tradeId, oldStop: stopPx, candidate,
      });
      return { stopPx, updated: false };
    }
  });
}
