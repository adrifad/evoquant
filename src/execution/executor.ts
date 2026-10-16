// M2+ (§42/§43/§45) — trading executor: startup safety sequence, candle tick,
// approved-decision execution with exchange-native SL/TP (§16), reconciliation,
// closed-trade finalization, and review/evolution triggers.
// Multi-symbol (V1.1): runTick targets one symbol per call; deps carry
// instrument metadata for the whole watchlist (§17 "later" realized here).
//
// V1 note: OKX demo algo orders (order-algo) are used when available; if the
// endpoint rejects, we fall back to the bot-side SL/TP monitor (Layer B is
// always active) and log a RISK_EVENT — protection is never left off.

import { randomBytes } from "node:crypto";
import type { OkxClient } from "../exchange/okx/client.ts";
import type { InstrumentInfo, Position, OrderRequest } from "../exchange/okx/types.ts";
import { getCandles, getTicker, latestClosedCandle } from "../exchange/okx/market.ts";
import { getBalance, getPositions, setLeverage } from "../exchange/okx/account.ts";
import { closePosition, getOrder, getFills, getPendingOrders, placeOrder, OrderRejectedError, prepareOrderSize, requireFilledOrder, waitForOrderTerminal, deduplicateFills } from "../exchange/okx/orders.ts";
import { placeConditionalProtection, cancelAlgo, getAlgoOrder, getAlgoOrderByClientId, protectionClientIds, normalizePriceToTick, ProtectionPlacementError } from "../exchange/okx/algo.ts";
import { getServerTime } from "../exchange/okx/market.ts";
import type { RiskConfig, TradingConfig } from "../core/config.ts";
import { createLogger } from "../core/logger.ts";
import type { Store } from "../memory/db.ts";
import { logSystemEvent } from "../memory/db.ts";
import { nextDecisionId, openTrade, recordDecision, computeClosedMetrics, closeTrade, getOpenTrades, markReconciliationPending } from "../memory/trades.ts";
import { evaluateEntry } from "../risk/engine.ts";
import { evaluateKillSwitch } from "../risk/limits.ts";
import { evaluateGlobalEntryGate } from "../risk/global-entry-gate.ts";
import { sizePosition, stopPriceFor, takeProfitPriceFor } from "../risk/position-sizing.ts";
import { baseline, getBotState, setBotState, setEmergencyHalted, isEmergencyHalted, setRiskHaltReason, getRiskHaltReason, clearRiskHaltReason } from "../core/state.ts";
import type { FeatureSnapshot } from "../market/features.ts";
import type { Regime } from "../market/regime.ts";
import { buildFeatures } from "../market/features.ts";
import { classifyRegime } from "../market/regime.ts";
import { calibrate } from "../learning/confidence.ts";
import { maybeEvolveWeights } from "../learning/signal-weights.ts";
import { recomputeCalibration } from "../learning/confidence.ts";
import type { Decision } from "../agents/decision-agent.ts";
import type { StrategyDef } from "../strategy/library.ts";
import type { TradeCandidate } from "../strategy/core-v2.ts";
import { familyForV2, identityForV2 } from "../strategy/identity.ts";
import type { CandidateGate } from "../agents/decision-agent.ts";
import { serializeTradeMutation } from "./trade-mutation.ts";
import { msForBar } from "../core/scheduler.ts";
import { isTradeOwnedBy } from "../memory/engines.ts";
import { selectedEntryLeverage, serializeRiskEntry, reserveEntry, releaseEntry, unresolvedEntry } from "../core/runtime-risk.ts";
import { entrySettingsFingerprint } from "../core/runtime-trading.ts";
import { persistEntryCapital } from "../core/capital.ts";
import { candidateStopRiskPct, portfolioOpenRisk } from "../risk/portfolio-open-risk.ts";
import { recordOpportunityMetric } from "../market/opportunity-funnel.ts";

const log = createLogger("executor");

function decimalToScaled(value: string, scale: number): bigint {
  const match = value.match(/^([+-]?)(\d+)(?:\.(\d*))?$/);
  if (!match) throw new Error("invalid exchange decimal");
  const fraction = match[3] ?? "";
  const coefficient = BigInt(`${match[2]}${fraction}` || "0") * 10n ** BigInt(scale - fraction.length);
  return match[1] === "-" ? -coefficient : coefficient;
}

/** Compute fill VWAP using integer decimal arithmetic before converting to the
 * repository's numeric SQLite representation. */
function exactFillVwap(fills: Array<{ fillPx: string; fillSz: string }>): number {
  const decimals = fills.map((fill) => ({
    priceScale: (fill.fillPx.split(".")[1] ?? "").length,
    sizeScale: (fill.fillSz.split(".")[1] ?? "").length,
  }));
  const priceScale = Math.max(0, ...decimals.map((d) => d.priceScale));
  const sizeScale = Math.max(0, ...decimals.map((d) => d.sizeScale));
  let notional = 0n;
  let quantity = 0n;
  for (const fill of fills) {
    const px = decimalToScaled(fill.fillPx, priceScale);
    const sz = decimalToScaled(fill.fillSz, sizeScale);
    notional += px * sz;
    quantity += sz;
  }
  if (quantity <= 0n) throw new Error("exit fill quantity is invalid");
  return Number((Number(notional) / Number(quantity)) * 10 ** -priceScale);
}

function protectionDegraded(store: Store): boolean {
  return Boolean(store.db.prepare(`SELECT 1 FROM trades WHERE status='OPEN'
    AND COALESCE(protection_state,'UNVERIFIED')<>'VERIFIED' LIMIT 1`).get());
}

async function cancelAndVerifyProtection(client: OkxClient, instId: string, ids: Array<string | null | undefined>): Promise<void> {
  const uniqueIds = [...new Set(ids.filter((id): id is string => Boolean(id)))];
  for (const id of uniqueIds) {
    let algo = await getAlgoOrder(client, instId, id);
    if (algo.state === "live") {
      await cancelAlgo(client, instId, id);
      algo = await getAlgoOrder(client, instId, id);
    }
    if (!["canceled", "effective", "order_failed"].includes(algo.state)) {
      throw new Error(`PROTECTION_TERMINAL_STATE_UNCONFIRMED:${algo.state || "unknown"}`);
    }
  }
  // Historical rows may predate persisted algo IDs. A flat position is not
  // proof that an orphaned conditional order is absent, so query the exact
  // instrument's pending conditional orders before declaring cleanup complete.
  const pending = await client.get<Array<Record<string, string>>>("/api/v5/trade/orders-algo-pending",
    { instType: "SWAP", instId, ordType: "conditional" }, true);
  if (pending.length >= 100) throw new Error("PROTECTION_PENDING_ALGO_SCAN_INCOMPLETE");
  const orphaned = pending.find((algo) => algo.instId === instId);
  if (orphaned) throw new Error(uniqueIds.length ? "PROTECTION_ORPHANED_ALGO_UNVERIFIED" : "PROTECTION_IDS_UNAVAILABLE");
}

/** Re-read both exact native protection legs. Failure is observable and blocks all new entries. */
export async function verifyOpenTradeProtection(d: Pick<ExecutorDeps, "client" | "store" | "instruments">, instId?: string): Promise<boolean> {
  const now = new Date().toISOString();
  const rows = d.store.db.prepare(`SELECT * FROM trades WHERE status IN ('OPEN','RECONCILIATION_PENDING')
    AND (? IS NULL OR instrument=?)`).all(instId ?? null, instId ?? null) as Array<Record<string, unknown>>;
  let allVerified = true;
  for (const trade of rows) {
    const instrument = String(trade.instrument);
    const side = String(trade.side) === "LONG" ? "long" : "short";
    let positions: Position[];
    try { positions = await getPositions(d.client, instrument); }
    catch (error) {
      allVerified = false;
      d.store.db.prepare("UPDATE trades SET protection_state='DEGRADED',protection_checked_at=? WHERE trade_id=?").run(now, String(trade.trade_id));
      setRiskHaltReason(d.store, "EXCHANGE_STATE_UNKNOWN");
      setBotState(d.store, "RISK_HALTED");
      logSystemEvent(d.store, "RISK_EVENT", { tradeId: trade.trade_id, reason: "EXCHANGE_STATE_UNKNOWN", newEntriesHalted: true,
        detail: error instanceof Error ? error.message : "UNKNOWN" });
      continue;
    }
    const matching = positions.filter((p) => p.instId === instrument && p.posSide === side && Number(p.pos) > 0);
    const conflicting = positions.some((p) => p.instId === instrument && Number(p.pos) > 0 && p.posSide !== side);
    if (conflicting || matching.length > 1) {
      allVerified = false;
      d.store.db.prepare("UPDATE trades SET protection_state='DEGRADED',protection_checked_at=? WHERE trade_id=?").run(now, String(trade.trade_id));
      setRiskHaltReason(d.store, "EXCHANGE_POSITION_MISMATCH");
      setBotState(d.store, "RISK_HALTED");
      logSystemEvent(d.store, "RISK_EVENT", { tradeId: trade.trade_id, reason: "EXCHANGE_POSITION_MISMATCH", newEntriesHalted: true });
      continue;
    }
    const position = matching[0];
    if (!position) {
      // A successful exact position read proves there is no live exposure for
      // this trade. Historical IDs are irrelevant only after confirming that no
      // conditional algo remains active for the flat instrument.
      try {
        const pendingAlgos = await d.client.get<Array<Record<string, string>>>("/api/v5/trade/orders-algo-pending",
          { instType: "SWAP", instId: instrument, ordType: "conditional" }, true);
        if (pendingAlgos.length >= 100 || pendingAlgos.some((algo) => algo.instId === instrument)) {
          throw new Error(pendingAlgos.length >= 100 ? "PROTECTION_ALGO_SCAN_INCOMPLETE" : "ORPHANED_PROTECTION_ALGO");
        }
      } catch (error) {
        allVerified = false;
        const reason = error instanceof Error && error.message === "ORPHANED_PROTECTION_ALGO"
          ? "ORPHANED_PROTECTION_ALGO" : "EXCHANGE_STATE_UNKNOWN";
        d.store.db.prepare("UPDATE trades SET protection_state='DEGRADED',protection_checked_at=? WHERE trade_id=?").run(now, String(trade.trade_id));
        setRiskHaltReason(d.store, reason);
        setBotState(d.store, "RISK_HALTED");
        if (trade.protection_state !== "DEGRADED") logSystemEvent(d.store, "RISK_EVENT", { tradeId: trade.trade_id,
          reason, newEntriesHalted: true, detail: error instanceof Error ? error.message : "UNKNOWN" });
        continue;
      }
      if (trade.status === "OPEN") markReconciliationPending(d.store, String(trade.trade_id), "EXIT_FILL_NOT_PROVEN");
      d.store.db.prepare("UPDATE trades SET protection_state='EXITED_PENDING_ACCOUNTING',protection_checked_at=? WHERE trade_id=?").run(now, String(trade.trade_id));
      continue;
    }
    const checkedAt = Date.parse(String(trade.protection_checked_at ?? ""));
    if (Number.isFinite(checkedAt) && Date.now() - checkedAt < 60_000) {
      if (trade.protection_state !== "VERIFIED") allVerified = false;
      continue;
    }
    const metadata = d.instruments[instrument];
    let slId = String(trade.sl_algo_id ?? trade.algo_id ?? "");
    let tpId = String(trade.tp_algo_id ?? "");
    try {
      if ((!slId || !tpId) && trade.sl_algo_cl_ord_id && trade.tp_algo_cl_ord_id) {
        const [recoveredSl, recoveredTp] = await Promise.all([
          slId ? Promise.resolve(null) : getAlgoOrderByClientId(d.client, instrument, String(trade.sl_algo_cl_ord_id)),
          tpId ? Promise.resolve(null) : getAlgoOrderByClientId(d.client, instrument, String(trade.tp_algo_cl_ord_id)),
        ]);
        if (!slId && recoveredSl?.algoId) slId = recoveredSl.algoId;
        if (!tpId && recoveredTp?.algoId) tpId = recoveredTp.algoId;
        if (slId || tpId) d.store.db.prepare("UPDATE trades SET sl_algo_id=COALESCE(sl_algo_id,?),tp_algo_id=COALESCE(tp_algo_id,?),algo_id=COALESCE(algo_id,?) WHERE trade_id=?")
          .run(slId || null, tpId || null, slId || null, String(trade.trade_id));
      }
      if (!metadata || metadata.instId !== instrument || !slId || !tpId) throw new Error("PROTECTION_METADATA_OR_ID_MISSING");
      const positionSize = Math.abs(Number(position?.pos));
      const tradeSize = Number(trade.contracts);
      if (!position || !Number.isFinite(positionSize) || positionSize <= 0
        || !Number.isFinite(tradeSize) || Math.abs(positionSize - tradeSize) > Math.max(1e-9, tradeSize * 1e-8)) {
        throw new Error("EXCHANGE_POSITION_SIZE_UNVERIFIED");
      }
      const sl = await getAlgoOrder(d.client, instrument, slId);
      const tp = await getAlgoOrder(d.client, instrument, tpId);
      const contracts = Number(trade.contracts);
      const stop = Number(normalizePriceToTick(Number(trade.stop_px), metadata.tickSz, side === "long" ? "up" : "down"));
      const takeProfit = Number(normalizePriceToTick(Number(trade.take_profit_px), metadata.tickSz, side === "long" ? "down" : "up"));
      const exitSide = side === "long" ? "sell" : "buy";
      const stopOk = sl.state === "live" && sl.instId === instrument && sl.tdMode === "isolated" && sl.side === exitSide
        && sl.posSide === side && sl.ordType === "conditional" && sl.slTriggerPxType === "mark" && Number(sl.sz) === contracts
        && Number.isFinite(Number(sl.slTriggerPx)) && Math.abs(Number(sl.slTriggerPx) - stop) <= Math.max(Number(metadata.tickSz) * 1e-9, 1e-12);
      const takeProfitOk = tp.state === "live" && tp.instId === instrument && tp.tdMode === "isolated" && tp.side === exitSide
        && tp.posSide === side && tp.ordType === "conditional" && tp.tpTriggerPxType === "mark" && Number(tp.sz) === contracts
        && Number.isFinite(Number(tp.tpTriggerPx)) && Math.abs(Number(tp.tpTriggerPx) - takeProfit) <= Math.max(Number(metadata.tickSz) * 1e-9, 1e-12);
      if (!stopOk || !takeProfitOk) throw new Error(`PROTECTION_STATE_MISMATCH:${stopOk ? "TP" : "SL"}`);
      d.store.db.prepare("UPDATE trades SET protection_state='VERIFIED',protection_checked_at=? WHERE trade_id=?").run(now, String(trade.trade_id));
      if (trade.protection_state !== "VERIFIED") logSystemEvent(d.store, "STATE", { event: "PROTECTION_RECOVERED",
        tradeId: trade.trade_id, instrument, livePositionDetected: true });
    } catch (error) {
      allVerified = false;
      d.store.db.prepare("UPDATE trades SET protection_state='DEGRADED',protection_checked_at=? WHERE trade_id=?").run(now, String(trade.trade_id));
      setRiskHaltReason(d.store, "LIVE_POSITION_PROTECTION_UNVERIFIED");
      setBotState(d.store, "RISK_HALTED");
      logSystemEvent(d.store, "RISK_EVENT", { tradeId: trade.trade_id, reason: "PROTECTION_VERIFICATION_FAILED", detail: error instanceof Error ? error.message : "UNKNOWN", newEntriesHalted: true });
    }
  }
  return allVerified;
}

export function getLastKillReason(): string | null {
  return lastKillReason;
}

/** Recover provenance for pre-migration halts only when the latest persisted
 * risk event explicitly identifies protection verification/cleanup as cause. */
export function inferLegacyProtectionHalt(store: Store): boolean {
  if (getBotState(store) !== "RISK_HALTED" || getRiskHaltReason(store) || isEmergencyHalted(store)) return false;
  const row = store.db.prepare("SELECT payload FROM system_events WHERE kind='RISK_EVENT' ORDER BY id DESC LIMIT 1").get() as { payload?: string } | undefined;
  if (!row?.payload) return false;
  try {
    const payload = JSON.parse(row.payload) as Record<string, unknown>;
    if (typeof payload.protection_verification_failed === "string" || payload.reason === "EXIT_PROTECTION_CLEANUP_PENDING") {
      setRiskHaltReason(store, payload.reason === "EXIT_PROTECTION_CLEANUP_PENDING"
        ? "EXIT_PROTECTION_CLEANUP_UNVERIFIED" : "LIVE_POSITION_PROTECTION_UNVERIFIED");
      return true;
    }
  } catch { /* malformed historical event is not evidence */ }
  return false;
}
/** Reset at the start of every global tick: the kill reason describes THIS
 * cycle. Without a reset it freezes on the last runTick value, so a bot that
 * healed hours ago still reports the old reason in /api/status. */
export function resetLastKillReason(): void { lastKillReason = null; }
let lastKillReason: string | null = null;

export interface ExecutorDeps {
  client: OkxClient;
  trading: TradingConfig;
  risk: RiskConfig;
  store: Store;
  instruments: Record<string, InstrumentInfo>;   // keyed by instId (watchlist)
  watchlist: string[];
}

/** Symbol the current tick targets: instId + metadata. */
export interface TickSymbol {
  instId: string;
  meta: InstrumentInfo;
}

let tradeSeq = 0;
let consecutiveOrderFailures = 0; // §23 REPEATED_ORDER_FAILURE input
function nextTradeId(): string {
  tradeSeq += 1;
  return `TRD-${String(Date.now()).slice(-8)}${String(tradeSeq % 100).padStart(2, "0")}`;
}

// §43 startup safety sequence (1–13) — returns false when trading stays off.
export async function startupSafetySequence(d: ExecutorDeps): Promise<boolean> {
  const { client, trading, risk, store, watchlist } = d;
  const steps: Array<[string, () => Promise<void>]> = [
    ["unresolved-entry", async () => { await reconcileEntryReservation(d); }],
    ["server-time", async () => {
      const t = await getServerTime(client);
      const drift = Date.now() - t;
      if (Math.abs(drift) > risk.clock_drift_max_ms) throw new Error(`clock drift ${drift}ms (§23)`);
    }],
    ["balance", async () => { await getBalance(client); }],
    ["positions", async () => {
      const poss = await getPositions(client);
      const open = poss.filter((p) => p.pos !== "0");
      if (await reconcileOpen(d, open)) throw new Error("STATE_UNCERTAIN: unexpected exchange position");
    }],
    ["open-position-protection", async () => { await verifyOpenTradeProtection(d); }],
    ["pending-orders", async () => {
      const pending = await getPendingOrders(client);
      if (pending.length > 0) {
        logSystemEvent(store, "STATE", { recovery: "STATE_UNCERTAIN", pendingOrders: pending.map((p) => p.ordId) });
        throw new Error(`STATE_UNCERTAIN: ${pending.length} pending order(s) require reconciliation`);
      }
    }],
    ["position-mode", async () => {
      // only set when different — OKX rejects with 59000 while positions exist
      const cfg = await client.get<Array<Record<string, string>>>("/api/v5/account/config", undefined, true);
      const mode = cfg[0]?.posMode ?? "";
      if (mode === trading.account.position_mode) {
        log.info({ event: "position-mode", result: "already set", mode });
        return;
      }
      await client.post("/api/v5/account/set-position-mode", { posMode: trading.account.position_mode }, true);
    }],
  ];
  for (const [name, fn] of steps) {
    try { await fn(); log.info({ event: `startup:${name}`, result: "ok" }); }
    catch (e) {
      log.error({ event: `startup:${name}`, result: "fail", error: e instanceof Error ? e.message : String(e) });
      logSystemEvent(store, "STATE", { startupFail: name });
      return false;
    }
  }
  return true;
}

/** Clear only a protection-owned halt, and only after a fresh account-wide
 * reconciliation proves exchange connectivity, positions, orders and algos. */
export async function recoverProtectionHalt(d: ExecutorDeps, operatorConfirmed = false): Promise<boolean> {
  const haltReason = getRiskHaltReason(d.store);
  const recoverableReason = ["LIVE_POSITION_PROTECTION_UNVERIFIED", "EXIT_PROTECTION_CLEANUP_UNVERIFIED",
    "EXCHANGE_STATE_UNKNOWN", "EXCHANGE_POSITION_MISMATCH", "ORPHANED_PROTECTION_ALGO"].includes(haltReason ?? "")
    || (operatorConfirmed && (haltReason === "MANUAL_EMERGENCY_STOP" || haltReason === "STARTUP_SAFETY_FAILURE"
      || haltReason?.startsWith("KILL_SWITCH:") === true));
  if (getBotState(d.store) !== "RISK_HALTED" || !recoverableReason
    || isEmergencyHalted(d.store)) return false;
  try {
    const [balance, serverTime, positions, pendingOrders, pendingAlgos] = await Promise.all([
      getBalance(d.client), getServerTime(d.client), getPositions(d.client), getPendingOrders(d.client),
      d.client.get<Array<Record<string, string>>>("/api/v5/trade/orders-algo-pending", { instType: "SWAP", ordType: "conditional" }, true),
    ]);
    if (Math.abs(Date.now() - serverTime) > d.risk.clock_drift_max_ms || pendingOrders.length > 0 || pendingAlgos.length >= 100) return false;
    const livePositions = positions.filter((p) => Number(p.pos) !== 0);
    const local = getOpenTrades(d.store) as Array<Record<string, unknown>>;
    const localKeys = new Set(local.map((t) => `${String(t.instrument)}:${String(t.side).toLowerCase()}`));
    if (livePositions.some((p) => !localKeys.has(`${p.instId}:${p.posSide}`))) return false;
    if (await reconcileOpen(d, livePositions)) return false;
    if (!(await verifyOpenTradeProtection(d))) return false;
    const expectedAlgoIds = new Set(local.flatMap((t) => [t.sl_algo_id, t.tp_algo_id, t.algo_id]
      .filter((id): id is string => typeof id === "string" && id.length > 0)));
    if (pendingAlgos.some((algo) => !algo.algoId || !expectedAlgoIds.has(algo.algoId)
      || !livePositions.some((position) => position.instId === algo.instId && position.posSide === algo.posSide))) return false;
    const eq = usdtEquity(balance);
    const base = baseline(d.store, eq);
    const kill = evaluateKillSwitch({
      apiOk: true, positionMismatch: false, orderFailuresRecent: consecutiveOrderFailures,
      clockDriftMs: Date.now() - serverTime, dbOk: true, instrumentMetaOk: true,
      unexpectedPosition: livePositions.length > d.risk.hard_limits.max_concurrent_positions,
      dailyLossPct: base.dayStartEquity > 0 ? ((base.dayStartEquity - eq) / base.dayStartEquity) * 100 : 0,
      drawdownPct: base.peakEquity > 0 ? ((base.peakEquity - eq) / base.peakEquity) * 100 : 0,
    }, d.risk, d.store);
    if (kill) return false;
    clearRiskHaltReason(d.store);
    setBotState(d.store, "RUNNING");
    logSystemEvent(d.store, "STATE", { event: "RISK_HALT_RECOVERED", recoveryReason: "PROTECTION_STATE_VERIFIED",
      livePositionDetected: livePositions.length > 0 });
    return true;
  } catch (error) {
    logSystemEvent(d.store, "RISK_EVENT", { reason: "PROTECTION_RECOVERY_UNVERIFIED", newEntriesHalted: true,
      detail: error instanceof Error ? error.message : "UNKNOWN" });
    return false;
  }
}

// Only new entries may synchronize leverage. Startup/reloads never touch open positions.
export async function synchronizeEntryLeverage(d: Pick<ExecutorDeps, "client" | "trading" | "risk" | "store">, instId: string): Promise<number> {
  await reconcileEntryReservation(d);
  const positions = await getPositions(d.client);
  if (positions.some((p) => p.instId === instId && Number(p.pos) !== 0)
    || (getOpenTrades(d.store) as Array<Record<string, unknown>>).some((p) => p.instrument === instId)) {
    throw new Error("entry leverage: instrument already occupied");
  }
  // A timed-out submission may still be resting at the exchange.
  if ((await getPendingOrders(d.client)).length) throw new Error("entry leverage: pending orders require reconciliation");
  const leverage = selectedEntryLeverage(d.trading, d.risk);
  const actual = await setLeverage(d.client, instId, leverage, Math.min(d.risk.hard_limits.max_leverage, d.trading.leverage.hard_max));
  if (Number(actual.long.lever) !== leverage || Number(actual.short.lever) !== leverage) {
    throw new Error("entry leverage: exchange did not confirm selected leverage");
  }
  return leverage;
}

/** An empty positions/pending-orders response cannot prove that a timed-out POST was rejected. */
export async function reconcileEntryReservation(d: Pick<ExecutorDeps, "client" | "store">): Promise<void> {
  const entry = unresolvedEntry(d.store);
  if (!entry) return;
  const message = "STATE_UNCERTAIN: unresolved entry requires reconciliation";
  let orders: Array<Record<string, string>>;
  try {
    orders = await d.client.get<Array<Record<string, string>>>("/api/v5/trade/order",
      { instId: entry.instId, clOrdId: entry.clOrdId }, true);
  } catch { throw new Error(message); }
  const order = orders.find((o) => o.clOrdId === entry.clOrdId && o.instId === entry.instId && o.posSide === entry.posSide);
  if (!order || !order.ordId) throw new Error(message);
  const filled = order.accFillSz !== undefined && order.accFillSz !== "" ? Number(order.accFillSz) : NaN;
  const tracked = d.store.db.prepare("SELECT trade_id FROM trades WHERE cl_open_id=? AND ord_open_id=? AND instrument=? AND lower(side)=?")
    .get(entry.clOrdId, order.ordId, entry.instId, entry.posSide);
  // A partial/untracked fill needs explicit position recovery. Never retry the order.
  if (!(order.state === "canceled" && filled === 0) && !(order.state === "filled" && filled > 0 && tracked)) {
    throw new Error(message);
  }
  releaseEntry(d.store, entry.clOrdId);
}

/** Only proven POST rejection releases the durable entry intent; later failures stay reserved (§45). */
export async function submitReservedEntry(d: Pick<ExecutorDeps, "client" | "store">, order: OrderRequest & { clOrdId: string }) {
  reserveEntry(d.store, { clOrdId: order.clOrdId, instId: order.instId, posSide: order.posSide });
  try { return await placeOrder(d.client, order); }
  catch (error) {
    if (error instanceof OrderRejectedError && error.definitive) releaseEntry(d.store, order.clOrdId);
    throw error;
  }
}

export function confirmedFillLeverage(fill: { lever?: string }, selected: number): number {
  const actual = Number(fill.lever);
  return Number.isFinite(actual) && actual > 0 ? actual : selected;
}

// §45 — reconcile local open trades against exchange positions (all symbols).
async function reconcileOpen(d: ExecutorDeps, exPositions: Position[]): Promise<boolean> {
  const local = getOpenTrades(d.store) as Array<Record<string, unknown>>;
  const exByKey = new Map(exPositions.map((p) => [`${p.instId}:${p.posSide}`, p]));
  for (const t of local) {
    const key = `${String(t.instrument)}:${String(t.side).toLowerCase()}`;
    const ex = exByKey.get(key);
    if (!ex || ex.pos === "0") {
      // Pending rows belong to the durable, backoff-aware reconciliation sweep.
      // Reprocessing them here on every scanner tick would bypass that schedule.
      if (t.status === "RECONCILIATION_PENDING") continue;
      // local says open, exchange says gone → trade closed outside; finalize via fills
      log.warn({ event: "reconcile:exit_detected", tradeId: String(t.trade_id) });
      await finalizeFromExchange(d, t, ex);
    }
    exByKey.delete(key);
  }
  // exchange positions not known locally = unexpected (§23 unexpected_position)
  let unexpected = false;
  for (const [key, p] of exByKey) {
    if (p.pos !== "0") {
      unexpected = true;
      logSystemEvent(d.store, "STATE", { unexpected_position: key });
      log.warn({ event: "reconcile:unexpected_position", instId: p.instId, posSide: p.posSide });
    }
  }
  return unexpected;
}

async function finalizeFromExchange(d: ExecutorDeps, t: Record<string, unknown>, ex?: Position): Promise<void> {
  const tradeId = String(t.trade_id ?? "");
  if (!tradeId) return;
  await serializeTradeMutation(tradeId, async () => {
    const current = d.store.db.prepare("SELECT * FROM trades WHERE trade_id=? AND status IN ('OPEN','RECONCILIATION_PENDING')").get(tradeId) as Record<string, unknown> | undefined;
    if (!current) return;
    await finalizeOpenTradeFromExchangeLocked(d, current, ex);
  });
}

/** Reconcile exchange-flat trades whose exit evidence is not yet complete.
 * Attempts are leased, exponentially delayed, and escalated for manual review;
 * escalation never upgrades the trade to financially proven and slow retries
 * continue so later exchange evidence can still recover it. */
const EXIT_RECONCILE_BASE_MS = 60_000;
const EXIT_RECONCILE_MAX_MS = 6 * 60 * 60_000;
const EXIT_RECONCILE_REVIEW_AFTER = 8;
const EXIT_RECONCILE_REVIEW_DELAY_MS = 24 * 60 * 60_000;
const EXIT_RECONCILE_LEASE_MS = 30 * 60_000;
const EXIT_RECONCILE_BATCH_LIMIT = 10;
export async function sweepUnprovenExits(d: ExecutorDeps): Promise<number> {
  const stale = d.store.db.prepare(
    `SELECT trade_id,instrument,side,exit_reconcile_attempts,exit_reconcile_state FROM trades WHERE status='RECONCILIATION_PENDING'
     AND evidence_reason LIKE 'EXIT_%'
     AND (exit_reconcile_next_retry_ts IS NULL OR exit_reconcile_next_retry_ts<=?)
     AND (exit_reconcile_claim_until_ts IS NULL OR exit_reconcile_claim_until_ts<=?)
     ORDER BY COALESCE(exit_reconcile_last_attempt_ts,'') ASC LIMIT ?`).all(new Date().toISOString(), new Date().toISOString(), EXIT_RECONCILE_BATCH_LIMIT) as
    Array<{ trade_id: string; instrument: string; side: string; exit_reconcile_attempts: number; exit_reconcile_state: string }>;
  if (stale.length === 0) return 0;
  let liveKeys: Set<string>;
  try {
    liveKeys = new Set((await getPositions(d.client)).filter((p) => p.pos !== "0")
      .map((p) => `${p.instId}:${p.posSide}`));
  } catch (error) {
    const failedAt = Date.now();
    const reason = error instanceof Error ? error.message.slice(0, 160) : "EXCHANGE_POSITION_LOOKUP_UNAVAILABLE";
    for (const row of stale) {
      const attempts = Number(row.exit_reconcile_attempts ?? 0) + 1;
      const reviewRequired = attempts >= EXIT_RECONCILE_REVIEW_AFTER;
      const delay = reviewRequired ? EXIT_RECONCILE_REVIEW_DELAY_MS
        : Math.min(EXIT_RECONCILE_MAX_MS, EXIT_RECONCILE_BASE_MS * 2 ** Math.min(attempts - 1, 8));
      const updated = d.store.db.prepare(`UPDATE trades SET exit_reconcile_attempts=?,exit_reconcile_last_attempt_ts=?,
        exit_reconcile_state=?,exit_reconcile_last_failure_reason=?,exit_reconcile_next_retry_ts=?
        WHERE trade_id=? AND status='RECONCILIATION_PENDING'
          AND (exit_reconcile_next_retry_ts IS NULL OR exit_reconcile_next_retry_ts<=?)
          AND (exit_reconcile_claim_until_ts IS NULL OR exit_reconcile_claim_until_ts<=?)`)
        .run(attempts, new Date(failedAt).toISOString(), reviewRequired ? "ACCOUNTING_REVIEW_REQUIRED" : "RETRY_SCHEDULED",
          reason, new Date(failedAt + delay).toISOString(), row.trade_id, new Date(failedAt).toISOString(), new Date(failedAt).toISOString());
      if (reviewRequired && updated.changes === 1 && row.exit_reconcile_state !== "ACCOUNTING_REVIEW_REQUIRED") {
        logSystemEvent(d.store, "RISK_EVENT", { event: "ACCOUNTING_REVIEW_REQUIRED", tradeId: row.trade_id,
          instrument: row.instrument, retryCount: attempts, reason: "EXCHANGE_POSITION_LOOKUP_UNAVAILABLE" });
      }
    }
    return 0;
  }
  let healed = 0;
  for (const row of stale) {
    const tradeId = row.trade_id;
    // While the exchange still holds this side, the monitor path owns the trade.
    if (liveKeys.has(`${row.instrument}:${String(row.side).toLowerCase()}`)) {
      d.store.db.prepare(`UPDATE trades SET exit_reconcile_state='LIVE_POSITION_MANAGEMENT',
        exit_reconcile_next_retry_ts=? WHERE trade_id=? AND status='RECONCILIATION_PENDING'`)
        .run(new Date(Date.now() + 15 * 60_000).toISOString(), tradeId);
      continue;
    }
    const attemptedAt = Date.now();
    const attempts = Number(row.exit_reconcile_attempts ?? 0) + 1;
    const reviewRequired = attempts >= EXIT_RECONCILE_REVIEW_AFTER;
    const delay = reviewRequired ? EXIT_RECONCILE_REVIEW_DELAY_MS
      : Math.min(EXIT_RECONCILE_MAX_MS, EXIT_RECONCILE_BASE_MS * 2 ** Math.min(attempts - 1, 8));
    const claimUntil = new Date(attemptedAt + EXIT_RECONCILE_LEASE_MS).toISOString();
    const claimed = d.store.db.prepare(`UPDATE trades SET exit_reconcile_attempts=?,exit_reconcile_last_attempt_ts=?,exit_reconcile_next_retry_ts=?,
      exit_reconcile_claim_until_ts=?,exit_reconcile_state=?
      WHERE trade_id=? AND status='RECONCILIATION_PENDING'
        AND (exit_reconcile_next_retry_ts IS NULL OR exit_reconcile_next_retry_ts<=?)
        AND (exit_reconcile_claim_until_ts IS NULL OR exit_reconcile_claim_until_ts<=?)`)
      .run(attempts, new Date(attemptedAt).toISOString(), new Date(attemptedAt + delay).toISOString(), claimUntil,
        reviewRequired ? "ACCOUNTING_REVIEW_REQUIRED" : "RETRY_SCHEDULED", tradeId,
        new Date(attemptedAt).toISOString(), new Date(attemptedAt).toISOString());
    if (claimed.changes !== 1) continue;
    logSystemEvent(d.store, "STATE", { event: "EXIT_RECONCILIATION_RETRY", tradeId, instrument: row.instrument,
      retryCount: attempts, nextRetryAt: new Date(attemptedAt + delay).toISOString() });
    if (reviewRequired && row.exit_reconcile_state !== "ACCOUNTING_REVIEW_REQUIRED") {
      logSystemEvent(d.store, "RISK_EVENT", { event: "ACCOUNTING_REVIEW_REQUIRED", tradeId,
        instrument: row.instrument, retryCount: attempts, reason: "EXIT_ACCOUNTING_UNPROVEN" });
    }
    try {
      await serializeTradeMutation(tradeId, async () => {
        const current = d.store.db.prepare("SELECT * FROM trades WHERE trade_id=? AND status='RECONCILIATION_PENDING'").get(tradeId) as Record<string, unknown> | undefined;
        if (!current) return;
        await finalizeOpenTradeFromExchangeLocked(d, current, undefined);
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message.slice(0, 160) : "RECONCILIATION_FAILED";
      d.store.db.prepare("UPDATE trades SET exit_reconcile_last_failure_reason=? WHERE trade_id=?").run(reason, tradeId);
    } finally {
      d.store.db.prepare("UPDATE trades SET exit_reconcile_claim_until_ts=NULL WHERE trade_id=?").run(tradeId);
    }
    const after = d.store.db.prepare("SELECT status FROM trades WHERE trade_id=?").get(tradeId) as { status: string } | undefined;
    if (after && after.status !== "RECONCILIATION_PENDING") {
      healed++;
      d.store.db.prepare(`UPDATE trades SET exit_reconcile_next_retry_ts=NULL,exit_reconcile_claim_until_ts=NULL,
        exit_reconcile_state='RECONCILED',exit_reconcile_last_failure_reason=NULL WHERE trade_id=?`).run(tradeId);
      log.info({ event: "reconcile:sweep_healed", tradeId, status: after.status, attempts });
    } else {
      const reason = d.store.db.prepare("SELECT evidence_reason FROM trades WHERE trade_id=?").get(tradeId) as { evidence_reason?: string } | undefined;
      d.store.db.prepare("UPDATE trades SET exit_reconcile_last_failure_reason=? WHERE trade_id=?").run(reason?.evidence_reason ?? "EXIT_ACCOUNTING_UNPROVEN", tradeId);
      log.warn({ event: "reconcile:sweep_deferred", tradeId, attempts });
    }
  }
  return healed;
}

export async function finalizeOpenTradeFromExchange(d: ExecutorDeps, t: Record<string, unknown>, ex?: Position): Promise<void> {
  const tradeId = String(t.trade_id ?? "");
  if (!tradeId) return;
  await serializeTradeMutation(tradeId, async () => {
    const current = d.store.db.prepare("SELECT * FROM trades WHERE trade_id=? AND status IN ('OPEN','RECONCILIATION_PENDING')").get(tradeId) as Record<string, unknown> | undefined;
    if (current) await finalizeOpenTradeFromExchangeLocked(d, current, ex);
  });
}

async function finalizeOpenTradeFromExchangeLocked(d: ExecutorDeps, t: Record<string, unknown>, ex?: Position): Promise<void> {
  const tradeId = String(t.trade_id ?? "");
  if (!tradeId) return;
  // Exit print resolution (algo/external closes have NO local close order id):
  // symbol history fills ≥ entry → latest OPPOSITE-side fill is the exit.
  const closeId = String(t.ord_close_id ?? "");
  const entryMs = Date.parse(String(t.entry_ts));
  const sideL = String(t.side) === "LONG";
  const exitSide = sideL ? "sell" : "buy";
  let exitOrderFills: Awaited<ReturnType<typeof getFills>> = [];
  let exitOrderId = closeId;
  let fillLookupFailed = false;
  let historyComplete = true;
  let historyFillConflicts = 0;
  if (closeId) {
    try { exitOrderFills = await getFills(d.client, String(t.instrument), closeId); }
    catch { fillLookupFailed = true; }
    const { getFillsHistoryForOrder } = await import("../exchange/okx/orders.ts");
    try {
      const history = await getFillsHistoryForOrder(d.client, String(t.instrument), closeId);
      historyComplete = history.complete;
      historyFillConflicts += history.conflicts ?? 0;
      exitOrderFills = [...exitOrderFills, ...history.fills];
    } catch { fillLookupFailed = true; historyComplete = false; }
  } else {
    const { getFillsHistoryForInstrument } = await import("../exchange/okx/orders.ts");
    try {
      const history = await getFillsHistoryForInstrument(d.client, String(t.instrument));
      historyComplete = history.complete;
      historyFillConflicts += history.conflicts ?? 0;
      exitOrderFills = history.fills;
    } catch { fillLookupFailed = true; historyComplete = false; }
  }
  // Recent and historical OKX fill endpoints overlap. Deduplicate only within
  // this instrument/order scope before quantity, VWAP and fees are calculated.
  const scopedRawFills = exitOrderFills.filter((fill) => fill.instId === String(t.instrument)
    && (!closeId || fill.ordId === closeId));
  const normalized = deduplicateFills(scopedRawFills);
  exitOrderFills = normalized.fills;
  if (normalized.duplicateCount > 0) {
    logSystemEvent(d.store, "STATE", { tradeId, event: "EXIT_FILLS_DEDUPED", instrument: String(t.instrument),
      orderId: closeId || null, duplicateFillCount: normalized.duplicateCount, conflictingDuplicateCount: normalized.conflicts });
  }
  if (normalized.conflicts + historyFillConflicts > 0) {
    markReconciliationPending(d.store, tradeId, "EXIT_FILL_IDENTITY_CONFLICT");
    return;
  }
  const expectedContracts = Number(t.contracts);
  const posSide = sideL ? "long" : "short";
  const candidates = exitOrderFills.filter((fill) => fill.instId === String(t.instrument) && fill.side === exitSide
    && fill.posSide === posSide && (!closeId || fill.ordId === closeId) && Boolean(fill.ordId) && Boolean(fill.tradeId)
    && Number(fill.ts) >= entryMs && Number(fill.ts) <= Date.now()
    && Number.isFinite(Number(fill.fillPx)) && Number(fill.fillPx) > 0
    && Number.isFinite(Number(fill.fillSz)) && Number(fill.fillSz) > 0);
  const byOrder = new Map<string, typeof candidates>();
  for (const fill of candidates) byOrder.set(fill.ordId, [...(byOrder.get(fill.ordId) ?? []), fill]);
  const completeOrders = [...byOrder.entries()].filter(([, orderFills]) => {
    const quantity = orderFills.reduce((sum, fill) => sum + Number(fill.fillSz), 0);
    return Math.abs(quantity - expectedContracts) <= Math.max(1e-9, expectedContracts * 1e-8);
  });
  const matchedOrder = historyComplete && byOrder.size === 1 && completeOrders.length === 1 ? completeOrders[0] : undefined;
  if (!matchedOrder) {
    const reason = fillLookupFailed ? "EXIT_FILL_LOOKUP_UNAVAILABLE"
      : !historyComplete ? "EXIT_FILL_HISTORY_INCOMPLETE"
      : completeOrders.length > 1 || byOrder.size > 1 ? "EXIT_FILL_ORDER_AMBIGUOUS"
      : candidates.length ? "EXIT_FILL_QUANTITY_INCOMPLETE" : "EXIT_FILL_NOT_PROVEN";
    markReconciliationPending(d.store, tradeId, reason);
    logSystemEvent(d.store, "STATE", { tradeId, reconciliation: "RECONCILIATION_PENDING", reason });
    log.warn({ event: "reconcile:pending", tradeId, reason });
    return;
  }
  exitOrderId = matchedOrder[0];
  exitOrderFills = matchedOrder[1];
  const exitQuantity = exitOrderFills.reduce((sum, fill) => sum + Number(fill.fillSz), 0);
  const exitPx = exactFillVwap(exitOrderFills);
  const exitFill = exitOrderFills.reduce((latest, fill) => Number(fill.ts) > Number(latest.ts) ? fill : latest);
  const contracts = Number(t.contracts);
  const meta = d.instruments[String(t.instrument)];
  if (!meta || meta.instId !== String(t.instrument) || !Number.isFinite(Number(meta.ctVal)) || Number(meta.ctVal) <= 0) {
    markReconciliationPending(d.store, tradeId, "INSTRUMENT_METADATA_PENDING");
    logSystemEvent(d.store, "STATE", { tradeId, reconciliation: "RECONCILIATION_PENDING", reason: "INSTRUMENT_METADATA_PENDING" });
    return;
  }
  const ctVal = Number(meta?.ctVal ?? 0);
  const side = t.side === "LONG" ? "LONG" : "SHORT";
  persistOrder(d.store, { ordId: exitOrderId, instId: String(t.instrument), side: exitSide, posSide,
    ordType: "market", sz: String(contracts), state: "filled", avgPx: String(exitPx), uTime: exitFill.ts,
    tradeId, kind: "CLOSE" });
  persistFills(d.store, exitOrderFills.map((fill) => ({ tradeId: fill.tradeId, ordId: fill.ordId, clOrdId: fill.clOrdId,
    instId: fill.instId, fillPx: fill.fillPx, fillSz: fill.fillSz, fee: fill.fee, feeCcy: fill.feeCcy,
    side: fill.side, posSide: fill.posSide, ts: fill.ts })));
  const m = computeClosedMetrics({
    side, entryPx: Number(t.entry_px), stopPx: Number(t.stop_px),
    initialStopPx: Number(t.initial_stop_px ?? t.stop_px), exitPx,
    contracts, ctVal, exitReason: String(t.exit_reason ?? "EXCHANGE_CLOSE_UNCLASSIFIED"),
    entryTs: String(t.entry_ts), exitTs: new Date(Number(exitFill.ts)).toISOString(),
    candlesWhileOpen: await excursionCandles(d, t, Date.parse(String(t.entry_ts)), Number(exitFill.ts)),
    // Reconciliation history proves the exit, but it may omit entry fills.
    // Let the evidence finalizer resolve the complete fee ledger.
    fees: null, funding: null,
  });
  const protection = d.store.db.prepare("SELECT sl_algo_id,tp_algo_id,algo_id FROM trades WHERE trade_id=?")
    .get(tradeId) as { sl_algo_id?: string | null; tp_algo_id?: string | null; algo_id?: string | null } | undefined;
  try {
    await cancelAndVerifyProtection(d.client, String(t.instrument), [protection?.sl_algo_id, protection?.tp_algo_id, protection?.algo_id]);
  } catch (error) {
    markReconciliationPending(d.store, tradeId, "EXIT_PROTECTION_CLEANUP_PENDING");
    d.store.db.prepare("UPDATE trades SET protection_state='DEGRADED' WHERE trade_id=?").run(tradeId);
    setRiskHaltReason(d.store, "EXIT_PROTECTION_CLEANUP_UNVERIFIED");
    setBotState(d.store, "RISK_HALTED");
    logSystemEvent(d.store, "RISK_EVENT", { tradeId, reason: "EXIT_PROTECTION_CLEANUP_PENDING",
      detail: error instanceof Error ? error.message : "UNKNOWN", newEntriesHalted: true });
    return;
  }
  closeTrade(d.store, String(t.trade_id), m);
  d.store.db.prepare(`UPDATE trades SET ord_close_id=?,exit_confirmation='EXCHANGE_FILL_CONFIRMED',exit_reconcile_state='RECONCILED',
    exit_reconcile_next_retry_ts=NULL,exit_reconcile_claim_until_ts=NULL,exit_reconcile_last_failure_reason=NULL WHERE trade_id=?`).run(exitOrderId, tradeId);
  logSystemEvent(d.store, "STATE", { event: "EXIT_RECONCILIATION_SUCCEEDED", tradeId, instrument: String(t.instrument),
    orderId: exitOrderId, expectedContracts, uniqueFillContracts: exitQuantity, duplicateFillCount: normalized.duplicateCount });
  log.info({ event: "trade:finalized_reconcile", tradeId: String(t.trade_id), resultR: m.resultR });
}

/** Uses confirmed bars only and never turns missing coverage into a zero excursion. */
export async function excursionCandles(d: Pick<ExecutorDeps, "client" | "trading">, trade: Record<string, unknown>, entryMs: number, exitMs: number) {
  const bar = (String(trade.engine) === "SCALP_5M" ? "1m" : String(trade.timeframe || d.trading.timeframe)) as import("../exchange/okx/market.ts").Bar;
  try {
    const interval = msForBar(bar);
    const confirmed = (await getCandles(d.client, String(trade.instrument), bar, 300))
      .filter((c) => c.confirm === "1");
    // The returned window must cover both ends of the actual position lifetime.
    // A partial recent window would otherwise make an incomplete excursion look exact.
    const startCovered = confirmed.some((c) => c.ts <= entryMs && c.ts + interval >= entryMs);
    const endCovered = confirmed.some((c) => c.ts <= exitMs && c.ts + interval >= exitMs);
    if (!startCovered || !endCovered) return null;
    const rows = confirmed.filter((c) => c.ts + interval >= entryMs && c.ts <= exitMs);
    // Empty coverage means data availability is unknown. A legitimate zero excursion
    // has at least one confirmed candle and therefore remains distinguishable.
    return rows.length ? rows : null;
  } catch { return null; }
}

// ---- main per-candle tick (§42) --------------------------------------------

export function persistCandles(store: Store, instId: string, bar: string, candles: Array<{ ts: number; o: number; h: number; l: number; c: number; vol: number; volCcy: number; confirm: string }>): void {
  const ins = store.db.prepare(`INSERT INTO candles(instId,bar,ts,o,h,l,c,vol,volCcy,confirm) VALUES(?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(instId,bar,ts) DO UPDATE SET confirm=excluded.confirm`);
  for (const c of candles) ins.run(instId, bar, c.ts, c.o, c.h, c.l, c.c, c.vol, c.volCcy, c.confirm);
}

export function persistOrder(store: Store, o: { ordId: string; clOrdId?: string | undefined; instId: string; side?: string | undefined; posSide?: string | undefined; ordType?: string | undefined; sz?: string | undefined; state?: string | undefined; avgPx?: string | undefined; cTime?: string | undefined; uTime?: string | undefined; tradeId?: string | undefined; kind?: string | undefined }): void {
  store.db.prepare(`INSERT INTO orders(ordId,clOrdId,instId,side,posSide,ordType,sz,state,avgPx,cTime,uTime,trade_id,kind)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(ordId) DO UPDATE SET state=excluded.state, avgPx=excluded.avgPx, uTime=excluded.uTime`)
    .run(o.ordId, o.clOrdId ?? null, o.instId, o.side ?? null, o.posSide ?? null, o.ordType ?? null,
         o.sz ?? null, o.state ?? null, o.avgPx ?? null, o.cTime ?? null, o.uTime ?? null,
         o.tradeId ?? null, o.kind ?? null);
}

export function persistFills(store: Store, fills: Array<{ tradeId: string; ordId: string; clOrdId?: string | undefined; instId: string; fillPx: string; fillSz: string; fee?: string | undefined; feeCcy?: string | undefined; side: string; posSide: string; ts: string }>): void {
  const ins = store.db.prepare(`INSERT INTO fills(tradeId,ordId,clOrdId,instId,fillPx,fillSz,fee,feeCcy,side,posSide,ts)
    VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(tradeId,ordId,ts) DO NOTHING`);
  for (const f of fills) ins.run(f.tradeId, f.ordId, f.clOrdId ?? null, f.instId, f.fillPx, f.fillSz, f.fee ?? null, f.feeCcy ?? null, f.side, f.posSide, f.ts);
}

export interface TickContext {
  features: FeatureSnapshot;
  regime: Regime;
  strategies: StrategyDef[];
  decideFn: (f: FeatureSnapshot, regime: Regime, hasPosition: boolean) => Promise<Decision>;
  candidate?: TradeCandidate;
  gateCandidateFn?: (candidate: TradeCandidate) => Promise<CandidateGate | null>;
}

// USDT collateral equity — the $100-scale demo runs on actual USDT balance,
// not totalEq which includes ETH/BTC holdings (user constraint: simulate ~$100).
// MUST use `eq` (includes margin locked in isolated positions): `availEq`
// drops when a position is opened, which would fake a daily loss (probe
// 2026-10-02: margin $2.89 moved availEq 98.4→95.5 while eq stayed 101.48).
function usdtEquity(bal: Awaited<ReturnType<typeof getBalance>>): number {
  const usdt = bal.details.find((d) => d.ccy === "USDT");
  return usdt ? Number(usdt.eq) || Number(usdt.availEq) || Number(usdt.availBal) || 0 : 0;
}

export type SwingCandidateOutcome = "OPENED" | "GATE_DENY" | "GATE_ERROR" | "CANDIDATE_REJECT" | "GLOBAL_STOP";
export async function runTick(d: ExecutorDeps, ctx: TickContext, symbol: TickSymbol): Promise<{
  kill: string | null; candidateOutcome?: SwingCandidateOutcome; candidateReason?: string;
  candidateGateResult?: "ALLOW" | "DENY" | "ERROR"; candidateRiskResult?: string;
}> {
  const { trading, risk, store, client } = d;
  const instId = symbol.instId;
  const meta = symbol.meta;
  // §40 persistence: instrument metadata each tick (candles persisted in main)
  store.db.prepare(`INSERT INTO instruments(instId,instType,tickSz,lotSz,minSz,ctVal,ctValCcy,state,settleCcy,listTime,cached_ts)
    VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(instId) DO UPDATE SET tickSz=excluded.tickSz,lotSz=excluded.lotSz,minSz=excluded.minSz,ctVal=excluded.ctVal,ctValCcy=excluded.ctValCcy,state=excluded.state,settleCcy=excluded.settleCcy,listTime=excluded.listTime,cached_ts=excluded.cached_ts`)
    .run(meta.instId, "SWAP", meta.tickSz, meta.lotSz, meta.minSz, meta.ctVal, meta.ctValCcy, meta.state ?? null, meta.settleCcy ?? null, meta.listTime ?? null, new Date().toISOString());
  const bal = await getBalance(client);
  const eq = usdtEquity(bal);
  const base = baseline(store, eq);
  const possAll = (await getPositions(client)).filter((p) => p.pos !== "0");
  const possSym = possAll.filter((p) => p.instId === instId);
  let localOpenSym = (getOpenTrades(store) as Array<Record<string, unknown>>).filter((t) => String(t.instrument) === instId);
  if (localOpenSym.length) {
    await verifyOpenTradeProtection(d, instId);
    // Protection verification can prove a formerly OPEN row is exchange-flat
    // and move it to accounting reconciliation. Re-read before evaluating the
    // global position mismatch so stale pre-verification state cannot deadlock.
    localOpenSym = (getOpenTrades(store) as Array<Record<string, unknown>>).filter((t) => String(t.instrument) === instId);
  }
  const swingOpenSym = localOpenSym.filter((t) => isTradeOwnedBy(t, "SWING_15M"));
  const kill = evaluateKillSwitch(
    {
      apiOk: true,
      positionMismatch: possSym.some((p) => !localOpenSym.some((t) => String(t.side).toLowerCase() === p.posSide))
        || localOpenSym.some((t) => t.status === "OPEN" && !possSym.some((p) => String(t.side).toLowerCase() === p.posSide)),
      orderFailuresRecent: consecutiveOrderFailures,
      clockDriftMs: Date.now() - (await getServerTime(client)),
      dbOk: true, instrumentMetaOk: Number(meta.ctVal) > 0,
      unexpectedPosition: possAll.length > risk.hard_limits.max_concurrent_positions,
      dailyLossPct: base.dayStartEquity > 0 ? ((base.dayStartEquity - eq) / base.dayStartEquity) * 100 : 0,
      drawdownPct: base.peakEquity > 0 ? ((base.peakEquity - eq) / base.peakEquity) * 100 : 0,
    },
    risk, store,
  );
  if (kill) { setRiskHaltReason(store, `KILL_SWITCH:${kill}`); setBotState(store, "RISK_HALTED"); log.warn({ event: "kill_switch", reason: kill }); }
  else if (getBotState(store) === "RISK_HALTED") {
    inferLegacyProtectionHalt(store);
    const recovered = await recoverProtectionHalt(d);
    if (recovered) log.info({ event: "kill_switch_cleared", reason: "PROTECTION_STATE_VERIFIED" });
  }
  lastKillReason = kill;

  // orphan heal: local OPEN but exchange has no position (algo SL/TP closed it,
  // or tick race) → finalize from this trade's own fills so bookkeeping self-heals.
  if (localOpenSym.some((t) => t.status === "OPEN") && possSym.length === 0) {
    for (const t of localOpenSym) {
      log.warn({ event: "monitor:orphan_detected", tradeId: String(t.trade_id), instId });
      await finalizeFromExchange(d, t, undefined);
    }
  }

  // Monitor only swing-owned positions; baseline V2 additionally uses a deterministic time stop.
  if (possSym.length > 0 && swingOpenSym.length > 0) {
    const t = swingOpenSym[0]!;
    const pos = possSym[0]!;
    const mark = Number(pos.markPx);
    let reason: "SL" | "TP" | "AI_CLOSE" | "TIME_STOP" | null = priceTrigger(t, mark);
    const maxHoldBars = Number(t.max_hold_bars ?? 0);
    if (!reason && maxHoldBars > 0) {
      const ageBars = Math.floor((Date.now() - Date.parse(String(t.entry_ts))) / msForBar(trading.timeframe));
      if (ageBars >= maxHoldBars) reason = "TIME_STOP";
    }
    // Core 2 baseline exits are deterministic; an LLM CLOSE would make its
    // live evidence incomparable with V2 historical and shadow evaluation.
    if (!reason && shouldUseAiPositionExit(t)) {
      const dec = await ctx.decideFn(ctx.features, ctx.regime, true);
      if (dec.decision === "CLOSE") reason = "AI_CLOSE";
    }
    if (reason) await closeTradeOnExchange(d, t, pos, reason);
    else log.info({ event: "monitor:hold", tradeId: String(t.trade_id), instId, markPx: mark });
  }

  // §23 NO NEW ENTRIES when: kill active, global cap reached (max_concurrent),
  // or THIS symbol already holds a position (one position per symbol — V1 rule).
  const globalGate = evaluateGlobalEntryGate({
    killSwitchActive: kill ?? (isEmergencyHalted(store) ? "EMERGENCY_STOP" : null), botState: getBotState(store), openPositions: possAll.length,
    protectionDegraded: protectionDegraded(store),
    instrument: instId, instrumentOccupied: localOpenSym.length > 0 || possSym.length > 0,
  }, risk);
  if (!globalGate.allowed) {
    if (ctx.candidate) recordOpportunityMetric(store, "SWING_15M", "RISK_REJECT", globalGate.reason);
    log.info({ event: "entry_global_gate_deny", instId, engine: "SWING_15M", reason: globalGate.reason });
    return ctx.candidate ? { kill, candidateOutcome: isGlobalStopReason(globalGate.reason) ? "GLOBAL_STOP" : "CANDIDATE_REJECT",
      candidateReason: globalGate.reason, candidateRiskResult: globalGate.reason } : { kill };
  }

  const f = ctx.features;
  const hasPosition = false;
  let gate: CandidateGate | null = null;
  let gateErrored = false;
  if (ctx.candidate) {
    try { gate = await ctx.gateCandidateFn?.(ctx.candidate) ?? null; }
    catch { gateErrored = true; }
    if (!gate || gateErrored) {
      const latestRun = store.db.prepare(`SELECT status FROM llm_runs WHERE role='gate' AND context_ref='candidate_gate'
        ORDER BY id DESC LIMIT 1`).get() as { status?: string } | undefined;
      const reason = latestRun?.status === "BUDGET_EXHAUSTED" ? "LLM_BUDGET_EXHAUSTED" : "LLM_ROLE_UNAVAILABLE_OR_INVALID";
      recordOpportunityMetric(store, "SWING_15M", "GATE_ERROR", reason);
      if (reason === "LLM_BUDGET_EXHAUSTED") recordOpportunityMetric(store, "SWING_15M", "BUDGET_EXHAUSTED");
      return { kill, candidateOutcome: "GATE_ERROR", candidateReason: reason, candidateGateResult: "ERROR" };
    }
    recordOpportunityMetric(store, "SWING_15M", gate.verdict === "ALLOW" ? "GATE_ALLOW" : "GATE_DENY");
  }
  const candidateAllowed = !ctx.candidate || gate?.verdict === "ALLOW";
  const decision: Decision = ctx.candidate
    ? {
      decision: candidateAllowed ? ctx.candidate.side : "HOLD",
      strategy: ctx.candidate.strategy,
      confidence: candidateAllowed ? gate?.confidence ?? 0 : 0,
      thesis: candidateAllowed ? gate?.reasoning ?? ctx.candidate.reasoning : ["candidate gate denied or unavailable", ...(gate?.risk_flags ?? [])],
      invalidations: gate?.risk_flags ?? [],
      suggested_stop_atr: ctx.candidate.stopAtr,
      suggested_take_profit_atr: ctx.candidate.stopAtr * ctx.candidate.targetR,
    }
    : await ctx.decideFn(f, ctx.regime, hasPosition);
  const candidateIdentity = ctx.candidate ? identityForV2(ctx.candidate.strategy, ctx.candidate.strategyVersion) : null;
  const calConf = calibrate(store, decision.confidence, 30, "SWING_15M", candidateIdentity
    ? { strategy: candidateIdentity.family, strategyCoreVersion: candidateIdentity.coreVersion, strategyVersion: candidateIdentity.strategyVersion }
    : { strategyCoreVersion: 1 });
  const sid = decision.strategy ?? "";
  const verdict = evaluateEntry(
    {
      action: decision.decision, strategy: decision.strategy ?? undefined, confidence: calConf,
      regime: ctx.regime, instrument: instId,
      stopDistancePct: ctx.candidate ? Math.abs(ctx.candidate.entryPrice - ctx.candidate.stopPrice) / ctx.candidate.entryPrice
        : Number.isFinite(f.atr14) && f.price ? (decision.suggested_stop_atr * f.atr14) / f.price : undefined,
    },
    {
      equity: eq, dayStartEquity: base.dayStartEquity, peakEquity: base.peakEquity,
      openPositions: possAll.length, killSwitchActive: kill,
    },
    trading, risk,
  );
  const decisionId = nextDecisionId();
  recordDecision(store, {
    decisionId, ts: new Date().toISOString(), instrument: instId,
    decision: decision.decision,
    gateResult: ctx.candidate ? gateErrored || !gate ? "ERROR" : gate.verdict : "NOT_EVALUATED",
    strategy: decision.strategy ?? undefined, regime: ctx.regime,
    rawConfidence: decision.confidence, calibratedConfidence: calConf,
    thesis: decision.thesis, riskVerdict: verdict,
  });
  // heartbeat event so the console Logs tab shows the pipeline is alive
  // even during long HOLD streaks (system_events otherwise only trade/risk)
  logSystemEvent(store, "DECISION", { inst: instId, d: decision.decision, conf: calConf,
    rej: verdict.approved ? "ok" : verdict.reason });
  if (!verdict.approved) logSystemEvent(store, "RISK_REJECT", { engine: "SWING_15M", instrument: instId, reason: verdict.reason, checks: verdict.checks });
  if (ctx.candidate) logSystemEvent(store, `LLM_GATE_${candidateAllowed ? "ALLOW" : "DENY"}`, {
    instrument: instId, strategy: ctx.candidate.strategy, side: ctx.candidate.side,
    setupScore: ctx.candidate.setupScore, reasoning: gate?.reasoning ?? [], riskFlags: gate?.risk_flags ?? [],
  });
  if (ctx.candidate && !candidateAllowed) return { kill, candidateOutcome: "GATE_DENY", candidateReason: "GATE_DENIED", candidateGateResult: "DENY" };
  if (ctx.candidate && candidateAllowed && calConf < trading.decision.minimum_confidence) {
    recordOpportunityMetric(store, "SWING_15M", "CONFIDENCE_BELOW_MIN");
  }
  if (ctx.candidate && !verdict.approved) recordOpportunityMetric(store, "SWING_15M", "RISK_REJECT", String(verdict.reason));
  log.info({ event: "decision", instId, action: decision.decision, strategy: decision.strategy, raw: decision.confidence, calibrated: calConf, approved: verdict.approved, reason: verdict.reason });

  if (!verdict.approved || decision.decision === "HOLD") return ctx.candidate
    ? { kill, candidateOutcome: verdict.reason === "KILL_SWITCH_ACTIVE" || isGlobalStopReason(String(verdict.reason)) ? "GLOBAL_STOP" : "CANDIDATE_REJECT",
      candidateReason: String(verdict.reason), candidateGateResult: "ALLOW", candidateRiskResult: String(verdict.reason) }
    : { kill };

  // §24 sizing from strategy params
  const strat = ctx.candidate
    ? { name: familyForV2(ctx.candidate.strategy), version: ctx.candidate.strategyVersion }
    : ctx.strategies.find((s) => `${s.name}_V${s.version}` === sid) ?? ctx.strategies[0]!;
  const side = decision.decision as "LONG" | "SHORT";
  const stopPx = ctx.candidate ? ctx.candidate.stopPrice : stopPriceFor(f.price, f.atr14, decision.suggested_stop_atr, side);
  let sz;
  try {
    sz = sizePosition(
      { equity: eq, entryPrice: f.price, stopPrice: stopPx, leverage: selectedEntryLeverage(trading, risk), instrument: meta },
      risk,
      trading.sizing,
    );
  } catch (szErr) {
    logSystemEvent(store, "RISK_EVENT", { sizing_rejected: szErr instanceof Error ? szErr.message : String(szErr), instId, mode: trading.sizing.mode });
    if (ctx.candidate) recordOpportunityMetric(store, "SWING_15M", "RISK_REJECT", "SIZING_REJECTED");
    return ctx.candidate ? { kill, candidateOutcome: "CANDIDATE_REJECT", candidateReason: "SIZING_REJECTED", candidateGateResult: "ALLOW", candidateRiskResult: "SIZING_REJECTED" } : { kill };
  }
  return serializeRiskEntry(store, async () => {
    const settingsAtPreparation = entrySettingsFingerprint(trading, risk);
    let leverage: number;
    try { leverage = await synchronizeEntryLeverage(d, instId); }
    catch (error) {
      logSystemEvent(store, "RISK_EVENT", { entry_preparation_rejected: String(error), instId });
      return ctx.candidate ? { kill, candidateOutcome: "GLOBAL_STOP", candidateReason: "ENTRY_PREPARATION_FAILED", candidateGateResult: "ALLOW", candidateRiskResult: "PASS" } : { kill };
    }
    // RACE GUARD: decision took ~60-90s; re-check slots before placing (§23)
    const freshPoss = (await getPositions(client)).filter((p) => p.pos !== "0");
    const freshBal = await getBalance(client);
    const freshEq = usdtEquity(freshBal);
    const freshBase = baseline(store, freshEq);
    const freshLocal = (getOpenTrades(store) as Array<Record<string, unknown>>);
    if (freshLocal.some((trade) => String(trade.status) === "RECONCILIATION_PENDING")) {
      if (ctx.candidate) recordOpportunityMetric(store, "SWING_15M", "RISK_REJECT", "RECONCILIATION_PENDING");
      logSystemEvent(store, "RISK_REJECT", { engine: "SWING_15M", instId, reason: "RECONCILIATION_PENDING" });
      return ctx.candidate ? { kill, candidateOutcome: "GLOBAL_STOP", candidateReason: "RECONCILIATION_PENDING", candidateGateResult: "ALLOW", candidateRiskResult: "RECONCILIATION_PENDING" } : { kill };
    }
    const freshKeys = new Set(freshPoss.map((p) => `${p.instId}:${p.posSide}`));
    const localKeys = new Set(freshLocal.map((x) => `${String(x.instrument)}:${String(x.side).toLowerCase()}`));
    const freshKill = evaluateKillSwitch({
      apiOk: true, positionMismatch: [...freshKeys].some((k) => !localKeys.has(k)) || [...localKeys].some((k) => !freshKeys.has(k)),
      orderFailuresRecent: consecutiveOrderFailures, clockDriftMs: Date.now() - await getServerTime(client), dbOk: true,
      instrumentMetaOk: Number(meta.ctVal) > 0, unexpectedPosition: freshPoss.length > risk.hard_limits.max_concurrent_positions,
      dailyLossPct: freshBase.dayStartEquity > 0 ? ((freshBase.dayStartEquity - freshEq) / freshBase.dayStartEquity) * 100 : 0,
      drawdownPct: freshBase.peakEquity > 0 ? ((freshBase.peakEquity - freshEq) / freshBase.peakEquity) * 100 : 0,
    }, risk, store);
    const freshRisk = evaluateEntry({
      action: decision.decision, strategy: decision.strategy ?? undefined, confidence: calConf,
      regime: ctx.regime, instrument: instId,
      stopDistancePct: ctx.candidate ? Math.abs(ctx.candidate.entryPrice - ctx.candidate.stopPrice) / ctx.candidate.entryPrice
        : Number.isFinite(f.atr14) && f.price ? (decision.suggested_stop_atr * f.atr14) / f.price : undefined,
    }, { equity: freshEq, dayStartEquity: freshBase.dayStartEquity, peakEquity: freshBase.peakEquity,
      openPositions: freshPoss.length, killSwitchActive: freshKill }, trading, risk);
    if (!freshRisk.approved || entrySettingsFingerprint(trading, risk) !== settingsAtPreparation) {
      if (ctx.candidate && !freshRisk.approved) recordOpportunityMetric(store, "SWING_15M", "RISK_REJECT", String(freshRisk.reason));
      logSystemEvent(store, "RISK_EVENT", { race_guard: "entry skipped after refreshed global risk check", instId,
        reason: entrySettingsFingerprint(trading, risk) !== settingsAtPreparation ? "ENTRY_SETTINGS_CHANGED" : freshRisk.reason });
      return ctx.candidate
        ? { kill, candidateOutcome: entrySettingsFingerprint(trading, risk) !== settingsAtPreparation || isGlobalStopReason(String(freshRisk.reason)) ? "GLOBAL_STOP" : "CANDIDATE_REJECT",
          candidateReason: entrySettingsFingerprint(trading, risk) !== settingsAtPreparation ? "ENTRY_SETTINGS_CHANGED" : String(freshRisk.reason),
          candidateGateResult: "ALLOW", candidateRiskResult: entrySettingsFingerprint(trading, risk) !== settingsAtPreparation ? "ENTRY_SETTINGS_CHANGED" : String(freshRisk.reason) }
        : { kill };
    }
    // Re-size from refreshed equity so a concurrent account loss cannot leave a stale oversized order.
    try {
      sz = sizePosition({ equity: freshEq, entryPrice: f.price, stopPrice: stopPx,
        leverage, instrument: meta }, risk, trading.sizing);
    } catch (szErr) {
      logSystemEvent(store, "RISK_EVENT", { sizing_rejected_after_refresh: szErr instanceof Error ? szErr.message : String(szErr), instId });
      if (ctx.candidate) recordOpportunityMetric(store, "SWING_15M", "RISK_REJECT", "SIZING_REJECTED");
      return ctx.candidate ? { kill, candidateOutcome: "CANDIDATE_REJECT", candidateReason: "SIZING_REJECTED", candidateGateResult: "ALLOW", candidateRiskResult: "SIZING_REJECTED" } : { kill };
    }
    const portfolio = portfolioOpenRisk({ equity: freshEq, positions: freshPoss, trades: freshLocal, instruments: d.instruments });
    const candidateRisk = candidateStopRiskPct(Number(sz.contracts) * Number(meta.ctVal) * Math.abs(f.price - stopPx), freshEq);
    const freshGate = evaluateGlobalEntryGate({
      killSwitchActive: freshKill ?? (isEmergencyHalted(store) ? "EMERGENCY_STOP" : null), botState: getBotState(store), openPositions: freshPoss.length,
      protectionDegraded: protectionDegraded(store),
      instrument: instId, instrumentOccupied: freshPoss.some((p) => p.instId === instId) || [...localKeys].some((k) => k.startsWith(`${instId}:`)),
      portfolioOpenRiskPct: portfolio.riskPct, candidateRiskPct: candidateRisk,
    }, risk);
    if (!freshGate.allowed) {
      if (ctx.candidate) recordOpportunityMetric(store, "SWING_15M", "RISK_REJECT", freshGate.reason);
      logSystemEvent(store, "RISK_REJECT", { engine: "SWING_15M", instId, reason: freshGate.reason, checks: freshGate.checks,
        portfolioOpenRiskPct: portfolio.riskPct, candidateRiskPct: candidateRisk });
      return ctx.candidate
        ? { kill, candidateOutcome: isGlobalStopReason(freshGate.reason) ? "GLOBAL_STOP" : "CANDIDATE_REJECT",
          candidateReason: freshGate.reason, candidateGateResult: "ALLOW", candidateRiskResult: freshGate.reason }
        : { kill };
    }
    if (ctx.candidate) recordOpportunityMetric(store, "SWING_15M", "RISK_PASS");
      const clOpen = clId(side, "OPEN", instId);
      try {
        const placed = await submitReservedEntry(d, {
        instId, tdMode: "isolated", side: side === "LONG" ? "buy" : "sell",
        posSide: side.toLowerCase() as "long" | "short",
        ordType: "market", sz: sz.contracts, clOrdId: clOpen,
      });
      if (ctx.candidate) recordOpportunityMetric(store, "SWING_15M", "ORDER_SUBMITTED");
      const filled = await waitForOrderTerminal(client, instId, placed.ordId, { timeoutMs: 30_000 });
      if (filled.state !== "filled") throw new Error(`entry not filled: ${filled.state}`);
      consecutiveOrderFailures = 0;
      persistOrder(store, { ordId: placed.ordId, clOrdId: clOpen, instId, side: side === "LONG" ? "buy" : "sell",
        posSide: side.toLowerCase(), ordType: "market", sz: sz.contracts, state: filled.state,
        avgPx: filled.avgPx, cTime: filled.cTime, uTime: filled.uTime, tradeId: "", kind: "OPEN" });
        const entryPx = Number(filled.avgPx) || f.price;
        const filledContracts = Number(filled.accFillSz);
        if (!Number.isFinite(filledContracts) || filledContracts <= 0) throw new Error("entry fill quantity unavailable");
        const executedStopPx = ctx.candidate
          ? entryPx + (side === "LONG" ? -1 : 1) * Math.abs(ctx.candidate.entryPrice - ctx.candidate.stopPrice)
          : stopPriceFor(entryPx, f.atr14, decision.suggested_stop_atr, side);
      const tradeId = nextTradeId();
      const exchangePositions = await getPositions(client, instId).catch(() => null);
      const entryPosition = exchangePositions?.find((p) => p.instId === instId && p.posSide === side.toLowerCase() && Number(p.pos) > 0);
      const exchangeContracts = Math.abs(Number(entryPosition?.pos));
      const actualContracts = Number.isFinite(exchangeContracts) && exchangeContracts > 0 ? String(exchangeContracts) : String(filledContracts);
      const positionReadbackVerified = Boolean(entryPosition && Number.isFinite(exchangeContracts) && exchangeContracts > 0
        && Math.abs(exchangeContracts - filledContracts) <= Math.max(1e-9, filledContracts * 1e-8));
      openTrade(store, {
        tradeId, engine: "SWING_15M", instrument: instId, timeframe: trading.timeframe, side,
        strategy: candidateIdentity ? candidateIdentity.family : strat.name,
        strategyVersion: candidateIdentity ? candidateIdentity.strategyVersion : strat.version,
        ...(candidateIdentity ? { identity: candidateIdentity } : {}),
        regime: ctx.regime,
        ...(ctx.candidate ? { regimeAxes: ctx.candidate.regime } : {}),
        ...(ctx.candidate ? { entryConditions: ctx.candidate.conditions } : {}),
        contracts: actualContracts, entryPx, entryTs: new Date().toISOString(),
          stopPx: executedStopPx,
        takeProfitPx: ctx.candidate
          ? entryPx + (side === "LONG" ? 1 : -1) * Math.abs(ctx.candidate.entryPrice - ctx.candidate.stopPrice) * ctx.candidate.targetR
          : takeProfitPriceFor(entryPx, f.atr14, decision.suggested_take_profit_atr, side),
        clOpenId: clOpen, ordOpenId: placed.ordId,
        decisionId,
        rawConfidence: decision.confidence, calibratedConfidence: calConf,
          plannedRiskPct: Number(actualContracts) * Number(meta.ctVal) * Math.abs(entryPx - executedStopPx) / freshEq * 100,
        leverage: confirmedFillLeverage(entryPosition ?? filled, confirmedFillLeverage(filled, leverage)),
        ...(ctx.candidate ? { maxHoldBars: ctx.candidate.maxHoldBars } : {}),
        entryFeatures: f,
      });
      const protectionBaseId = clId(side, "ALGO", instId);
      const protectionClientOrderIds = protectionClientIds(protectionBaseId);
      store.db.prepare(`UPDATE trades SET protection_state='ENTRY_FILLED_PROTECTION_PENDING',
        sl_algo_cl_ord_id=?,tp_algo_cl_ord_id=? WHERE trade_id=?`)
        .run(protectionClientOrderIds.stop, protectionClientOrderIds.takeProfit, tradeId);
      // Establish and verify both independent native protection legs. A failure
      // leaves the already-open trade under Layer B monitoring, but halts new
      // entries until the operator resolves protection state.
      try {
        const algo = await placeConditionalProtection(client, {
          instId,
          posSide: side === "LONG" ? "long" : "short",
          contracts: actualContracts,
          tickSz: meta.tickSz,
            stopPrice: executedStopPx,
          takeProfitPrice: ctx.candidate
            ? entryPx + (side === "LONG" ? 1 : -1) * Math.abs(ctx.candidate.entryPrice - ctx.candidate.stopPrice) * ctx.candidate.targetR
            : takeProfitPriceFor(entryPx, f.atr14, decision.suggested_take_profit_atr, side),
          clAlgoId: protectionBaseId,
        });
        store.db.prepare("UPDATE trades SET algo_id=?,sl_algo_id=?,tp_algo_id=?,protection_state=? WHERE trade_id=?")
          .run(algo.stop.algoId, algo.stop.algoId, algo.takeProfit.algoId, positionReadbackVerified ? "VERIFIED" : "DEGRADED", tradeId);
        if (!positionReadbackVerified) {
          setRiskHaltReason(store, "LIVE_POSITION_PROTECTION_UNVERIFIED");
          setBotState(store, "RISK_HALTED");
          logSystemEvent(store, "RISK_EVENT", { protection_degraded: "EXCHANGE_POSITION_SIZE_UNVERIFIED", tradeId, newEntriesHalted: true });
        }
        log.info({ event: "protection:algos_verified", tradeId, slAlgoId: algo.stop.algoId, tpAlgoId: algo.takeProfit.algoId });
      } catch (algoErr) {
        if (algoErr instanceof ProtectionPlacementError && algoErr.stop) {
          store.db.prepare("UPDATE trades SET algo_id=?,sl_algo_id=?,tp_algo_id=?,protection_state='DEGRADED' WHERE trade_id=?")
            .run(algoErr.stop.algoId, algoErr.stop.algoId, algoErr.takeProfit?.algoId ?? null, tradeId);
        } else {
          store.db.prepare("UPDATE trades SET protection_state='DEGRADED' WHERE trade_id=?").run(tradeId);
        }
        setRiskHaltReason(store, "LIVE_POSITION_PROTECTION_UNVERIFIED");
        setBotState(store, "RISK_HALTED");
        logSystemEvent(store, "RISK_EVENT", { protection_degraded: algoErr instanceof Error ? algoErr.message : "UNKNOWN", tradeId, newEntriesHalted: true });
        log.error({ event: "protection:algo_failed", tradeId, newEntriesHalted: true });
        releaseEntry(store, clOpen);
        throw new Error("STATE_UNCERTAIN: native position protection was not fully verified");
        }
        releaseEntry(store, clOpen);
        try { persistEntryCapital(store, tradeId, entryPosition, meta, freshEq, leverage); }
        catch { log.warn({ event: "entry_capital_persistence_failed", tradeId }); }
      store.db.prepare("UPDATE orders SET trade_id=? WHERE ordId=?").run(tradeId, placed.ordId);
      const entryFills = await getFills(client, instId, placed.ordId).catch(() => []);
      persistFills(store, entryFills.map((f2) => ({ tradeId: f2.tradeId, ordId: f2.ordId, clOrdId: f2.clOrdId,
        instId: f2.instId, fillPx: f2.fillPx, fillSz: f2.fillSz, fee: f2.fee, feeCcy: f2.feeCcy,
        side: f2.side, posSide: f2.posSide, ts: f2.ts })));
      logSystemEvent(store, "TRADE_OPEN", { tradeId, instId, side, contracts: sz.contracts, entryPx });
      if (ctx.candidate) recordOpportunityMetric(store, "SWING_15M", "POSITION_OPENED");
      log.info({ event: "trade:opened", tradeId, instId, entryPx, contracts: sz.contracts });
      } catch (e) {
      consecutiveOrderFailures += 1;
      logSystemEvent(store, "ERROR", { place_entry_fail: e instanceof Error ? e.message : String(e), consecutive: consecutiveOrderFailures });
      log.error({ event: "trade:open_failed", error: e instanceof Error ? e.message : String(e) });
      return ctx.candidate ? { kill, candidateOutcome: "GLOBAL_STOP", candidateReason: "EXCHANGE_ORDER_FAILURE",
        candidateGateResult: "ALLOW", candidateRiskResult: "PASS" } : { kill };
    }
    return ctx.candidate ? { kill, candidateOutcome: "OPENED", candidateGateResult: "ALLOW", candidateRiskResult: "PASS" } : { kill };
  });
}

export function isGlobalStopReason(reason: string): boolean {
  return /^(KILL_SWITCH|BOT_|MAX_CONCURRENT|MAX_DAILY_LOSS|.*DRAWDOWN|PORTFOLIO_OPEN_RISK|OPEN_POSITION_PROTECTION|RECONCILIATION_PENDING|STATE_UNCERTAIN|LLM_BUDGET_EXHAUSTED|EXCHANGE_)/.test(reason);
}

// Deterministic SL/TP price trigger (§25 Layer B core) — pure fn shared by
// the candle tick and the intrabar sweep. Returns the close reason or null.
export function priceTrigger(t: Record<string, unknown>, markPx: number): "SL" | "TP" | null {
  const side = String(t.side) as "LONG" | "SHORT";
  const stopPx = Number(t.stop_px), tpPx = Number(t.take_profit_px);
  if (side === "LONG" && markPx <= stopPx) return "SL";
  if (side === "SHORT" && markPx >= stopPx) return "SL";
  if (side === "LONG" && markPx >= tpPx) return "TP";
  if (side === "SHORT" && markPx <= tpPx) return "TP";
  return null;
}

export function shouldUseAiPositionExit(trade: Record<string, unknown>): boolean {
  return Number(trade.strategy_core_version ?? 1) !== 2;
}

// letters+digits only, ≤32 (§15 + OKX charset gotcha). Ticker derived from instId.
export function clId(side: string, kind: "OPEN" | "CLOSE" | "ALGO", instId: string): string {
  const base = instId.split("-")[0] ?? "X";
  const day = new Date().toISOString().slice(0, 10).replaceAll("-", "");
  const rand = randomBytes(6).toString("hex");
  return `EVQ${base}${side === "LONG" ? "L" : "S"}${kind}${day}${rand}`.slice(0, 32);
}

export async function closeTradeOnExchange(d: ExecutorDeps, t: Record<string, unknown>, pos: Position, reason: string): Promise<void> {
  const tradeId = String(t.trade_id ?? "");
  if (!tradeId) throw new Error("cannot close trade without trade_id");
  await serializeTradeMutation(tradeId, async () => {
    const current = d.store.db.prepare("SELECT * FROM trades WHERE trade_id=? AND status='OPEN'").get(tradeId) as Record<string, unknown> | undefined;
    if (!current) return; // another close already finalized it
    await closeOpenTradeOnExchange(d, current, pos, reason);
  });
}

async function closeOpenTradeOnExchange(d: ExecutorDeps, t: Record<string, unknown>, pos: Position, reason: string): Promise<void> {
  const side = String(t.side) as "LONG" | "SHORT";
  const meta = d.instruments[String(t.instrument)];
  if (!meta || meta.instId !== String(t.instrument) || !Number.isFinite(Number(meta.lotSz)) || !Number.isFinite(Number(meta.minSz))) {
    logSystemEvent(d.store, "STATE", { tradeId: String(t.trade_id), state: "STATE_UNCERTAIN", reason: "INSTRUMENT_METADATA_UNAVAILABLE" });
    throw new Error("STATE_UNCERTAIN: exact instrument metadata unavailable for close");
  }
  const clClose = clId(side, "CLOSE", String(t.instrument));
  const placed = await closePosition(d.client, {
    instId: String(t.instrument), posSide: side === "LONG" ? "long" : "short",
    contracts: pos.pos, clOrdId: clClose,
    lotSz: meta.lotSz, minSz: meta.minSz,
  });
  const filled = await waitForOrderTerminal(d.client, String(t.instrument), placed.ordId, { timeoutMs: 30_000 });
  persistOrder(d.store, { ordId: placed.ordId, clOrdId: clClose, instId: String(t.instrument),
    side: side === "LONG" ? "sell" : "buy", posSide: side.toLowerCase(), ordType: "market",
    sz: pos.pos, state: filled.state, avgPx: filled.avgPx, uTime: filled.uTime,
    tradeId: String(t.trade_id), kind: "CLOSE" });
  try {
    requireFilledOrder(filled);
  } catch (error) {
    logSystemEvent(d.store, "RISK_EVENT", { close_order_not_filled: filled.state, tradeId: String(t.trade_id), ordId: placed.ordId });
    throw error; // keep the trade OPEN and its exchange-side protection intact
  }
  // Fee completeness/signs are finalized from both exact fill legs later.
  // Never publish a partial close-time total as complete accounting.
  let feesPaid: number | null = null;
  for (const id of [String(t.ord_open_id ?? ""), placed.ordId]) {
    if (!id) { feesPaid = null; continue; }
    let fs: Awaited<ReturnType<typeof getFills>>;
    try { fs = await getFills(d.client, String(t.instrument), id); }
    catch { feesPaid = null; continue; }
    if (fs.length === 0) { feesPaid = null; continue; }
    persistFills(d.store, fs.map((fx) => ({ tradeId: fx.tradeId, ordId: fx.ordId, clOrdId: fx.clOrdId,
      instId: fx.instId, fillPx: fx.fillPx, fillSz: fx.fillSz, fee: fx.fee, feeCcy: fx.feeCcy,
      side: fx.side, posSide: fx.posSide, ts: fx.ts })));
  }
  const exitFill = [...(await getFills(d.client, String(t.instrument), placed.ordId).catch(() => []))]
    .find((fill) => fill.side === (side === "LONG" ? "sell" : "buy"));
  const exitPx = Number(exitFill?.fillPx);
  if (!exitFill || !Number.isFinite(exitPx) || exitPx <= 0) {
    d.store.db.prepare("UPDATE trades SET cl_close_id=?, ord_close_id=? WHERE trade_id=?").run(clClose, placed.ordId, String(t.trade_id));
    markReconciliationPending(d.store, String(t.trade_id), "EXIT_FILL_NOT_PROVEN");
    logSystemEvent(d.store, "STATE", { tradeId: String(t.trade_id), reconciliation: "RECONCILIATION_PENDING", reason: "EXIT_FILL_NOT_PROVEN" });
    return;
  }
  const contracts = Number(t.contracts);
  const ctVal = Number(meta.ctVal);
  const m = computeClosedMetrics({
    side, entryPx: Number(t.entry_px), stopPx: Number(t.stop_px),
    initialStopPx: Number(t.initial_stop_px ?? t.stop_px), exitPx,
    contracts, ctVal, exitReason: reason,
    entryTs: String(t.entry_ts), exitTs: new Date(Number(exitFill.ts)).toISOString(),
    candlesWhileOpen: await excursionCandles(d, t, Date.parse(String(t.entry_ts)), Number(exitFill.ts)),
    fees: feesPaid, funding: null,
  });
  const protectionIds = d.store.db.prepare("SELECT sl_algo_id,tp_algo_id,algo_id FROM trades WHERE trade_id=?")
    .get(String(t.trade_id)) as { sl_algo_id?: string | null; tp_algo_id?: string | null; algo_id?: string | null } | undefined;
  try {
    await cancelAndVerifyProtection(d.client, String(t.instrument), [protectionIds?.sl_algo_id, protectionIds?.tp_algo_id, protectionIds?.algo_id]);
  } catch (error) {
    // Persist the already-known strategy exit reason before deferring closure.
    // The reconciliation worker can later confirm the fill without erasing why
    // this close was initiated.
    d.store.db.prepare("UPDATE trades SET cl_close_id=?,ord_close_id=?,exit_reason=? WHERE trade_id=?")
      .run(clClose, placed.ordId, reason, String(t.trade_id));
    markReconciliationPending(d.store, String(t.trade_id), "EXIT_PROTECTION_CLEANUP_PENDING");
    d.store.db.prepare("UPDATE trades SET protection_state='DEGRADED' WHERE trade_id=?").run(String(t.trade_id));
    setRiskHaltReason(d.store, "EXIT_PROTECTION_CLEANUP_UNVERIFIED");
    setBotState(d.store, "RISK_HALTED");
    logSystemEvent(d.store, "RISK_EVENT", { tradeId: String(t.trade_id), reason: "EXIT_PROTECTION_CLEANUP_PENDING",
      detail: error instanceof Error ? error.message : "UNKNOWN", newEntriesHalted: true });
    return;
  }
  closeTrade(d.store, String(t.trade_id), { ...m });
  d.store.db.prepare("UPDATE trades SET cl_close_id=?, ord_close_id=? WHERE trade_id=?").run(clClose, placed.ordId, String(t.trade_id));
  log.info({ event: "trade:closed", tradeId: String(t.trade_id), reason, resultR: m.resultR });
  logSystemEvent(d.store, "TRADE_CLOSED", { tradeId: String(t.trade_id), instId: String(t.instrument), reason, resultR: m.resultR });
}

// emergency stop (§89): halt, cancel pending ENTRIES, preserve protections
export async function emergencyStop(d: ExecutorDeps): Promise<void> {
  setEmergencyHalted(d.store, true);
  setRiskHaltReason(d.store, "MANUAL_EMERGENCY_STOP");
  setBotState(d.store, "RISK_HALTED");
  try {
    const pending = await d.client.get<Array<Record<string, string>>>("/api/v5/trade/orders-pending", { instType: "SWAP" }, true);
    for (const p of pending) {
      // cancel only non-algo entry orders (V1: all plain orders we know are entries)
      await d.client.post("/api/v5/trade/cancel-order", { instId: p.instId, ordId: p.ordId }, true).catch(() => undefined);
    }
  } catch { /* exchange unreachable; state flag still holds */ }
  logSystemEvent(d.store, "STATE", { emergency_stop: true });
  log.warn({ event: "emergency_stop" });
}

export async function clearEmergency(d: ExecutorDeps): Promise<void> {
  inferLegacyProtectionHalt(d.store);
  if (getBotState(d.store) !== "RISK_HALTED") throw new Error("RISK_HALT_NOT_ACTIVE");
  if (getBotState(d.store) === "RISK_HALTED" && !["MANUAL_EMERGENCY_STOP", "LIVE_POSITION_PROTECTION_UNVERIFIED",
    "EXIT_PROTECTION_CLEANUP_UNVERIFIED", "EXCHANGE_STATE_UNKNOWN", "EXCHANGE_POSITION_MISMATCH", "ORPHANED_PROTECTION_ALGO",
    "STARTUP_SAFETY_FAILURE"].includes(getRiskHaltReason(d.store) ?? "")
    && !getRiskHaltReason(d.store)?.startsWith("KILL_SWITCH:")) {
    throw new Error("RISK_HALT_NOT_CLEARABLE_BY_EMERGENCY_ACTION");
  }
  // The explicit operator action does not bypass account-wide recovery checks.
  const emergencyWasActive = isEmergencyHalted(d.store);
  if (emergencyWasActive) setEmergencyHalted(d.store, false);
  if (!(await recoverProtectionHalt(d, true))) {
    if (emergencyWasActive) setEmergencyHalted(d.store, true);
    throw new Error("PROTECTION_RECOVERY_PRECONDITIONS_NOT_MET");
  }
}

export { prepareOrderSize, getOrder, getTicker, latestClosedCandle, buildFeatures, classifyRegime, maybeEvolveWeights, recomputeCalibration };
