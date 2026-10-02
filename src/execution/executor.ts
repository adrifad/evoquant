// M2+ (§42/§43/§45) — trading executor: startup safety sequence, candle tick,
// approved-decision execution with exchange-native SL/TP (§16), reconciliation,
// closed-trade finalization, and review/evolution triggers.
// Multi-symbol (V1.1): runTick targets one symbol per call; deps carry
// instrument metadata for the whole watchlist (§17 "later" realized here).
//
// V1 note: OKX demo algo orders (order-algo) are used when available; if the
// endpoint rejects, we fall back to the bot-side SL/TP monitor (Layer B is
// always active) and log a RISK_EVENT — protection is never left off.

import type { OkxClient } from "../exchange/okx/client.ts";
import type { InstrumentInfo, Position } from "../exchange/okx/types.ts";
import { getCandles, getTicker, latestClosedCandle } from "../exchange/okx/market.ts";
import { getBalance, getPositions, setLeverage } from "../exchange/okx/account.ts";
import { closePosition, getOrder, getFills, placeOrder, prepareOrderSize, waitForOrderTerminal } from "../exchange/okx/orders.ts";
import { placeConditionalProtection, cancelAlgo } from "../exchange/okx/algo.ts";
import { getServerTime } from "../exchange/okx/market.ts";
import type { RiskConfig, TradingConfig } from "../core/config.ts";
import { createLogger } from "../core/logger.ts";
import type { Store } from "../memory/db.ts";
import { logSystemEvent } from "../memory/db.ts";
import { nextDecisionId, openTrade, recordDecision, computeClosedMetrics, closeTrade, getOpenTrades } from "../memory/trades.ts";
import { evaluateEntry } from "../risk/engine.ts";
import { evaluateKillSwitch } from "../risk/limits.ts";
import { sizePosition, stopPriceFor, takeProfitPriceFor } from "../risk/position-sizing.ts";
import { baseline, getBotState, setBotState, setEmergencyHalted } from "../core/state.ts";
import type { FeatureSnapshot } from "../market/features.ts";
import type { Regime } from "../market/regime.ts";
import { buildFeatures } from "../market/features.ts";
import { classifyRegime } from "../market/regime.ts";
import { calibrate } from "../learning/confidence.ts";
import { maybeEvolveWeights } from "../learning/signal-weights.ts";
import { recomputeCalibration } from "../learning/confidence.ts";
import type { Decision } from "../agents/decision-agent.ts";
import type { StrategyDef } from "../strategy/library.ts";

const log = createLogger("executor");

export function getLastKillReason(): string | null {
  return lastKillReason;
}
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
    ["server-time", async () => {
      const t = await getServerTime(client);
      const drift = Date.now() - t;
      if (Math.abs(drift) > risk.clock_drift_max_ms) throw new Error(`clock drift ${drift}ms (§23)`);
    }],
    ["balance", async () => { await getBalance(client); }],
    ["positions", async () => {
      const poss = await getPositions(client);
      const open = poss.filter((p) => p.pos !== "0");
      await reconcileOpen(d, open);
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
    ["leverage", async () => {
      // §7.10/§43: both posSides per symbol — paced + retried for OKX rate limits
      for (const sym of watchlist) {
        let attempt = 0;
        for (;;) {
          try {
            await setLeverage(client, sym, trading.leverage.default, risk.hard_limits.max_leverage);
            break;
          } catch (e) {
            attempt += 1;
            if (attempt >= 4 || !String((e as Error).message).includes("50011")) throw e;
            await new Promise((res) => setTimeout(res, 1_500 * attempt)); // backoff
          }
        }
        await new Promise((res) => setTimeout(res, 350)); // ~20 req/2s safety
      }
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

// §45 — reconcile local open trades against exchange positions (all symbols).
async function reconcileOpen(d: ExecutorDeps, exPositions: Position[]): Promise<void> {
  const local = getOpenTrades(d.store) as Array<Record<string, unknown>>;
  const exByKey = new Map(exPositions.map((p) => [`${p.instId}:${p.posSide}`, p]));
  for (const t of local) {
    const key = `${String(t.instrument)}:${String(t.side).toLowerCase()}`;
    const ex = exByKey.get(key);
    if (!ex || ex.pos === "0") {
      // local says open, exchange says gone → trade closed outside; finalize via fills
      log.warn({ event: "reconcile:exit_detected", tradeId: String(t.trade_id) });
      await finalizeFromExchange(d, t, ex);
    }
    exByKey.delete(key);
  }
  // exchange positions not known locally = unexpected (§23 unexpected_position)
  for (const [key, p] of exByKey) {
    if (p.pos !== "0") {
      logSystemEvent(d.store, "STATE", { unexpected_position: key });
      log.warn({ event: "reconcile:unexpected_position", instId: p.instId, posSide: p.posSide });
    }
  }
}

async function finalizeFromExchange(d: ExecutorDeps, t: Record<string, unknown>, ex?: Position): Promise<void> {
  const fills = await getFills(d.client, String(t.instrument), String(t.ord_close_id ?? "")).catch(() => []);
  const exitPx = ex?.markPx ? Number(ex.markPx) : (fills[0] ? Number(fills[0].fillPx) : Number(t.entry_px));
  const contracts = Number(t.contracts);
  const meta = d.instruments[String(t.instrument)] ?? Object.values(d.instruments)[0];
  const ctVal = Number(meta?.ctVal ?? 0);
  const side = t.side === "LONG" ? "LONG" : "SHORT";
  const m = computeClosedMetrics({
    side, entryPx: Number(t.entry_px), stopPx: Number(t.stop_px), exitPx,
    contracts, ctVal, exitReason: fills.length ? "FILL_CONFIRM" : "RECONCILE",
    entryTs: String(t.entry_ts), exitTs: new Date().toISOString(),
    candlesWhileOpen: await getCandles(d.client, String(t.instrument), d.trading.timeframe, 200).then((cs) => cs.filter((c) => c.confirm === "1" && c.ts > Date.parse(String(t.entry_ts)))),
    fees: Number(fills.reduce((a, f) => a + Number(f.fee || 0), 0)) || 0, funding: 0,
  });
  closeTrade(d.store, String(t.trade_id), m);
  log.info({ event: "trade:finalized_reconcile", tradeId: String(t.trade_id), resultR: m.resultR });
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
    VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(tradeId) DO NOTHING`);
  for (const f of fills) ins.run(f.tradeId, f.ordId, f.clOrdId ?? null, f.instId, f.fillPx, f.fillSz, f.fee ?? null, f.feeCcy ?? null, f.side, f.posSide, f.ts);
}

export interface TickContext {
  features: FeatureSnapshot;
  regime: Regime;
  strategies: StrategyDef[];
  decideFn: (f: FeatureSnapshot, regime: Regime, hasPosition: boolean) => Promise<Decision>;
  reviewFn: (tradeId: string) => Promise<void>;
  evolveFns: { weights: () => Promise<void> | void; calibration: () => void; strategies: () => Promise<void> | void; promote: () => void };
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

export async function runTick(d: ExecutorDeps, ctx: TickContext, symbol: TickSymbol): Promise<{ kill: string | null }> {
  const { trading, risk, store, client } = d;
  const instId = symbol.instId;
  const meta = symbol.meta;
  // §40 persistence: instrument metadata each tick (candles persisted in main)
  store.db.prepare(`INSERT INTO instruments(instId,instType,tickSz,lotSz,minSz,ctVal,ctValCcy,cached_ts)
    VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(instId) DO UPDATE SET cached_ts=excluded.cached_ts`)
    .run(meta.instId, "SWAP", meta.tickSz, meta.lotSz, meta.minSz, meta.ctVal, meta.ctValCcy, new Date().toISOString());
  const bal = await getBalance(client);
  const eq = usdtEquity(bal);
  const base = baseline(store, eq);
  const possAll = (await getPositions(client)).filter((p) => p.pos !== "0");
  const possSym = possAll.filter((p) => p.instId === instId);
  const localOpenSym = (getOpenTrades(store) as Array<Record<string, unknown>>).filter((t) => String(t.instrument) === instId);
  const kill = evaluateKillSwitch(
    {
      apiOk: true, positionMismatch: localOpenSym.length > 0 && possSym.length === 0, orderFailuresRecent: consecutiveOrderFailures,
      clockDriftMs: Date.now() - (await getServerTime(client)),
      dbOk: true, instrumentMetaOk: Number(meta.ctVal) > 0,
      unexpectedPosition: possAll.length > risk.hard_limits.max_concurrent_positions,
      dailyLossPct: base.dayStartEquity > 0 ? ((base.dayStartEquity - eq) / base.dayStartEquity) * 100 : 0,
      drawdownPct: base.peakEquity > 0 ? ((base.peakEquity - eq) / base.peakEquity) * 100 : 0,
    },
    risk, store,
  );
  if (kill) { setBotState(store, "RISK_HALTED"); log.warn({ event: "kill_switch", reason: kill }); }
  else if (getBotState(store) === "RISK_HALTED") { setBotState(store, "RUNNING"); log.info({ event: "kill_switch_cleared" }); }
  lastKillReason = kill;

  // monitor open positions on THIS symbol (deterministic SL/TP + AI CLOSE)
  if (possSym.length > 0 && localOpenSym.length > 0) {
    const t = localOpenSym[0]!;
    const pos = possSym[0]!;
    const mark = Number(pos.markPx);
    let reason: "SL" | "TP" | "AI_CLOSE" | null = priceTrigger(t, mark);
    if (!reason) {
      const dec = await ctx.decideFn(ctx.features, ctx.regime, true);
      if (dec.decision === "CLOSE") reason = "AI_CLOSE";
    }
    if (reason) await closeTradeOnExchange(d, t, pos, reason);
    else log.info({ event: "monitor:hold", tradeId: String(t.trade_id), instId, markPx: mark });
  }

  // evolution intervals on closed trades (§42 bottom half)
  await ctx.evolveFns.weights();
  ctx.evolveFns.calibration();
  await ctx.evolveFns.strategies();
  ctx.evolveFns.promote();

  if (kill || getOpenTrades(store).length > 0) return { kill }; // NO NEW ENTRIES (§23) — global limit
  if (getBotState(store) !== "RUNNING") { log.info({ event: "tick:skipped", state: getBotState(store) }); return { kill }; }

  const f = ctx.features;
  const hasPosition = false;
  const decision = await ctx.decideFn(f, ctx.regime, hasPosition);
  const calConf = calibrate(store, decision.confidence, 30);
  const sid = decision.strategy ?? "";
  const verdict = evaluateEntry(
    {
      action: decision.decision, strategy: decision.strategy ?? undefined, confidence: calConf,
      regime: ctx.regime, instrument: instId,
      stopDistancePct: Number.isFinite(f.atr14) && f.price ? (decision.suggested_stop_atr * f.atr14) / f.price : undefined,
    },
    {
      equity: eq, dayStartEquity: base.dayStartEquity, peakEquity: base.peakEquity,
      openPositions: possAll.length, killSwitchActive: kill,
    },
    trading, risk,
  );
  recordDecision(store, {
    decisionId: nextDecisionId(), ts: new Date().toISOString(), instrument: instId,
    decision: decision.decision, strategy: decision.strategy ?? undefined, regime: ctx.regime,
    rawConfidence: decision.confidence, calibratedConfidence: calConf,
    thesis: decision.thesis, riskVerdict: verdict,
  });
  log.info({ event: "decision", instId, action: decision.decision, strategy: decision.strategy, raw: decision.confidence, calibrated: calConf, approved: verdict.approved, reason: verdict.reason });

  if (!verdict.approved || decision.decision === "HOLD") return { kill };

  // §24 sizing from strategy params
  const strat = ctx.strategies.find((s) => `${s.name}_V${s.version}` === sid) ?? ctx.strategies[0]!;
  const side = decision.decision as "LONG" | "SHORT";
  const stopPx = stopPriceFor(f.price, f.atr14, decision.suggested_stop_atr, side);
  let sz;
  try {
    sz = sizePosition(
      { equity: eq, entryPrice: f.price, stopPrice: stopPx, leverage: trading.leverage.default, instrument: meta },
      risk,
      trading.sizing,
    );
  } catch (szErr) {
    logSystemEvent(store, "RISK_EVENT", { sizing_rejected: szErr instanceof Error ? szErr.message : String(szErr), instId, mode: trading.sizing.mode });
    return { kill };
  }
  const clOpen = clId(side, "OPEN", instId);
  try {
    const placed = await placeOrder(client, {
      instId, tdMode: "isolated", side: side === "LONG" ? "buy" : "sell",
      posSide: side.toLowerCase() as "long" | "short",
      ordType: "market", sz: sz.contracts, clOrdId: clOpen,
    });
    const filled = await waitForOrderTerminal(client, instId, placed.ordId, { timeoutMs: 30_000 });
    if (filled.state !== "filled") throw new Error(`entry not filled: ${filled.state}`);
    consecutiveOrderFailures = 0;
    persistOrder(store, { ordId: placed.ordId, clOrdId: clOpen, instId, side: side === "LONG" ? "buy" : "sell",
      posSide: side.toLowerCase(), ordType: "market", sz: sz.contracts, state: filled.state,
      avgPx: filled.avgPx, cTime: filled.cTime, uTime: filled.uTime, tradeId: "", kind: "OPEN" });
    const entryPx = Number(filled.avgPx) || f.price;
    const tradeId = nextTradeId();
    openTrade(store, {
      tradeId, instrument: instId, timeframe: trading.timeframe, side,
      strategy: strat.name, strategyVersion: strat.version, regime: ctx.regime,
      contracts: sz.contracts, entryPx, entryTs: new Date().toISOString(),
      stopPx: stopPriceFor(entryPx, f.atr14, decision.suggested_stop_atr, side),
      takeProfitPx: takeProfitPriceFor(entryPx, f.atr14, decision.suggested_take_profit_atr, side),
      clOpenId: clOpen, ordOpenId: placed.ordId,
      rawConfidence: decision.confidence, calibratedConfidence: calConf,
      plannedRiskPct: trading.sizing.mode === "percent_of_equity" ? trading.sizing.position_pct : risk.hard_limits.risk_per_trade_pct,
      leverage: trading.leverage.default,
      entryFeatures: f,
    });
    // §16 Layer A — exchange-native conditional (SL+TP) algo orders.
    // Best-effort: on failure Layer B (monitor) still holds; flag it.
    try {
      const algo = await placeConditionalProtection(client, {
        instId,
        posSide: side === "LONG" ? "long" : "short",
        contracts: sz.contracts,
        stopPrice: stopPriceFor(entryPx, f.atr14, decision.suggested_stop_atr, side),
        takeProfitPrice: takeProfitPriceFor(entryPx, f.atr14, decision.suggested_take_profit_atr, side),
        clAlgoId: clId(side, "ALGO", instId),
      });
      store.db.prepare("UPDATE trades SET algo_id=? WHERE trade_id=?").run(algo.algoId, tradeId);
      log.info({ event: "protection:algo_placed", tradeId, algoId: algo.algoId });
    } catch (algoErr) {
      logSystemEvent(store, "RISK_EVENT", { protection_degraded: algoErr instanceof Error ? algoErr.message : String(algoErr) });
      log.warn({ event: "protection:algo_failed", fallback: "Layer B bot monitor" });
    }
    store.db.prepare("UPDATE orders SET trade_id=? WHERE ordId=?").run(tradeId, placed.ordId);
    const entryFills = await getFills(client, instId, placed.ordId).catch(() => []);
    persistFills(store, entryFills.map((f2) => ({ tradeId: f2.tradeId, ordId: f2.ordId, clOrdId: f2.clOrdId,
      instId: f2.instId, fillPx: f2.fillPx, fillSz: f2.fillSz, fee: f2.fee, feeCcy: f2.feeCcy,
      side: f2.side, posSide: f2.posSide, ts: f2.ts })));
    logSystemEvent(store, "TRADE_OPEN", { tradeId, instId, side, contracts: sz.contracts, entryPx });
    log.info({ event: "trade:opened", tradeId, instId, entryPx, contracts: sz.contracts });
    void ctx.reviewFn;
  } catch (e) {
    consecutiveOrderFailures += 1;
    logSystemEvent(store, "ERROR", { place_entry_fail: e instanceof Error ? e.message : String(e), consecutive: consecutiveOrderFailures });
    log.error({ event: "trade:open_failed", error: e instanceof Error ? e.message : String(e) });
  }
  return { kill };
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

// letters+digits only, ≤32 (§15 + OKX charset gotcha). Ticker derived from instId.
export function clId(side: string, kind: "OPEN" | "CLOSE" | "ALGO", instId: string): string {
  const base = instId.split("-")[0] ?? "X";
  const day = new Date().toISOString().slice(0, 10).replaceAll("-", "");
  const rand = String(Date.now() % 1000000).padStart(6, "0");
  return `EVQ${base}${side === "LONG" ? "L" : "S"}${kind}${day}${rand}`.slice(0, 32);
}

export async function closeTradeOnExchange(d: ExecutorDeps, t: Record<string, unknown>, pos: Position, reason: string): Promise<void> {
  const side = String(t.side) as "LONG" | "SHORT";
  const meta = d.instruments[String(t.instrument)] ?? Object.values(d.instruments)[0]!;
  const clClose = clId(side, "CLOSE", String(t.instrument));
  const placed = await closePosition(d.client, {
    instId: String(t.instrument), posSide: side === "LONG" ? "long" : "short",
    contracts: pos.pos, clOrdId: clClose,
    lotSz: meta.lotSz, minSz: meta.minSz,
  });
  const filled = await waitForOrderTerminal(d.client, String(t.instrument), placed.ordId, { timeoutMs: 30_000 });
  const exitPx = Number(filled.avgPx) || Number(pos.markPx);
  // §27 fees: sum |fee| across this trade's fills (entry + close orders)
  let feesPaid = 0;
  for (const id of [String(t.ord_open_id ?? ""), placed.ordId]) {
    if (!id) continue;
    const fs = await getFills(d.client, String(t.instrument), id).catch(() => []);
    persistFills(d.store, fs.map((fx) => ({ tradeId: fx.tradeId, ordId: fx.ordId, clOrdId: fx.clOrdId,
      instId: fx.instId, fillPx: fx.fillPx, fillSz: fx.fillSz, fee: fx.fee, feeCcy: fx.feeCcy,
      side: fx.side, posSide: fx.posSide, ts: fx.ts })));
    for (const fx of fs) feesPaid += Math.abs(Number(fx.fee) || 0);
  }
  persistOrder(d.store, { ordId: placed.ordId, clOrdId: clClose, instId: String(t.instrument),
    side: side === "LONG" ? "sell" : "buy", posSide: side.toLowerCase(), ordType: "market",
    sz: pos.pos, state: filled.state, avgPx: filled.avgPx, uTime: filled.uTime,
    tradeId: String(t.trade_id), kind: "CLOSE" });
  const contracts = Number(t.contracts);
  const ctVal = Number(meta.ctVal);
  const candles = await getCandles(d.client, String(t.instrument), d.trading.timeframe, 200);
  const m = computeClosedMetrics({
    side, entryPx: Number(t.entry_px), stopPx: Number(t.stop_px), exitPx,
    contracts, ctVal, exitReason: reason,
    entryTs: String(t.entry_ts), exitTs: new Date().toISOString(),
    candlesWhileOpen: candles.filter((c) => c.confirm === "1" && c.ts > Date.parse(String(t.entry_ts))),
    fees: feesPaid, funding: 0,
  });
  closeTrade(d.store, String(t.trade_id), { ...m });
  d.store.db.prepare("UPDATE trades SET cl_close_id=?, ord_close_id=? WHERE trade_id=?").run(clClose, placed.ordId, String(t.trade_id));
  // §16 — remove stale protective algo once we closed by other means
  const algoRow = d.store.db.prepare("SELECT algo_id FROM trades WHERE trade_id=?").get(String(t.trade_id)) as { algo_id?: string | null } | undefined;
  if (algoRow?.algo_id) {
    await cancelAlgo(d.client, String(t.instrument), algoRow.algo_id).catch((err) =>
      log.warn({ event: "algo_cancel_failed", error: err instanceof Error ? err.message : String(err) }));
  }
  log.info({ event: "trade:closed", tradeId: String(t.trade_id), reason, resultR: m.resultR });
  logSystemEvent(d.store, "TRADE_CLOSED", { tradeId: String(t.trade_id), instId: String(t.instrument), reason, resultR: m.resultR });
}

// emergency stop (§89): halt, cancel pending ENTRIES, preserve protections
export async function emergencyStop(d: ExecutorDeps): Promise<void> {
  setEmergencyHalted(d.store, true);
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
  setEmergencyHalted(d.store, false);
  setBotState(d.store, "RUNNING");
  logSystemEvent(d.store, "STATE", { emergency_stop_cleared: true });
}

export { prepareOrderSize, getOrder, getTicker, latestClosedCandle, buildFeatures, classifyRegime, maybeEvolveWeights, recomputeCalibration };
