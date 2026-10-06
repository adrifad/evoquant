// ScalpRunner — 5m hybrid scalp engine (§46).
// Hot path DETERMINISTIC (src/scalp/signals.ts); LLM present in two places
// (§ user requirement), both fail-closed:
//   • supervisor: stance every stance_refresh_s (default 15m)
//   • gate: ALLOW/DENY per candidate, budgeted (≤ llm_max_per_hour)
// Hard limits enforced here, not by the LLM: max daily trades, per-symbol
// cooldown, total position cap (shared with 15m pipeline), one scalp/symbol,
// time-stop (max_hold_s), SL/TP via exchange algo + 15s ticker fallback.
import type { OkxClient } from "../exchange/okx/client.ts";
import type { InstrumentInfo } from "../exchange/okx/types.ts";
import { getCandles } from "../exchange/okx/market.ts";
import { getBalance, getPositions } from "../exchange/okx/account.ts";
import { getServerTime } from "../exchange/okx/market.ts";
import { placeOrder, waitForOrderTerminal, getFills } from "../exchange/okx/orders.ts";
import { placeConditionalProtection } from "../exchange/okx/algo.ts";
import { updateTradeStopPlus } from "../execution/position-management.ts";
import type { RiskConfig, TradingConfig } from "../core/config.ts";
import type { Store } from "../memory/db.ts";
import { kvGet, kvSet, logSystemEvent } from "../memory/db.ts";
import { openTrade, nextDecisionId, recordDecision } from "../memory/trades.ts";
import { getOpenTrades } from "../memory/trades.ts";
import { buildFeatures, type FeatureSnapshot } from "../market/features.ts";
import { classifyRegime } from "../market/regime.ts";
import { clId, closeTradeOnExchange, priceTrigger } from "../execution/executor.ts";
import { CandleCloseScheduler, msForBar } from "../core/scheduler.ts";
import { createLogger } from "../core/logger.ts";
import type { LlmConfig } from "../core/llm.ts";
import { fetchStance, gateSignal } from "../agents/scalp-agent.ts";
import {
  evaluateSignal, stanceAllows, budgetAllows, dailyAllows, hourKey,
  type ScalpCfg, type ScalpSignal, type Stance,
} from "./signals.ts";
import { sizePosition } from "../risk/position-sizing.ts";
import type { Regime } from "../market/regime.ts";
import { baseline, getBotState, isEmergencyHalted } from "../core/state.ts";
import { evaluateKillSwitch } from "../risk/limits.ts";
import { evaluateGlobalEntryGate } from "../risk/global-entry-gate.ts";
import type { Position } from "../exchange/okx/types.ts";
import { isTradeOwnedBy } from "../memory/engines.ts";

const log = createLogger("scalp");
const TF_TAG = "scalp";

export interface ScalpDeps {
  client: OkxClient;
  trading: TradingConfig;
  risk: RiskConfig;
  store: Store;
  instruments: Record<string, InstrumentInfo>;
  llm: () => LlmConfig;          // live provider config (refreshed by main)
  cfg: ScalpCfg;
}

function dayStartIso(): string {
  return new Date().toISOString().slice(0, 10) + "T00:00:00.000Z";
}

export class ScalpRunner {
  private sched: CandleCloseScheduler;
  private monitor: NodeJS.Timeout | undefined;
  private stance: Stance = "NEUTRAL";
  private stanceAt = 0;
  private inFlight = new Set<string>();
  private lastExit: Record<string, number> = {};
  private ticking = false;
  private stopped = false;
  private consecutiveOrderFailures = 0;

  readonly d: ScalpDeps;
  constructor(d: ScalpDeps) {
    this.d = d;
    this.sched = new CandleCloseScheduler(msForBar(d.cfg.signal_tf), () => this.tick());
  }

  start(): void {
    this.sched.start();
    this.monitor = setInterval(() => void this.sweep(), 15_000);
    log.info({ event: "scalp_started", tf: this.d.cfg.signal_tf, gate: this.d.cfg.llm_gate,
      stance_refresh_s: this.d.cfg.stance_refresh_s, max_daily: this.d.cfg.max_daily_trades });
  }

  stop(): void {
    this.stopped = true;
    this.sched.stop();
    if (this.monitor) clearInterval(this.monitor);
  }

  // ---------- supervisor stance (LLM, fail-closed to last known/NEUTRAL) ----------

  private async ensureStance(nowS: number): Promise<void> {
    if (nowS - this.stanceAt < this.d.cfg.stance_refresh_s) return;
    this.stanceAt = nowS;
    const snaps = await this.symbolContexts().catch(() => []);
    const regimes: Record<string, Regime> = {};
    const atrs: Record<string, number> = {};
    for (const s of snaps) { regimes[s.instrument] = s.regime; atrs[s.instrument] = Math.round(s.features.atrPct * 100) / 100; }
    const dayStart = dayStartIso();
    const session = this.d.store.db.prepare(
      "SELECT COALESCE(SUM(result_r),0) s, COUNT(*) n FROM trades WHERE timeframe=? AND entry_ts>=?",
    ).get(TF_TAG, dayStart) as { s: number; n: number };
    const st = await fetchStance(this.d.llm(), {
      regimes, atrPcts: atrs, sessionPnlR: Math.round(session.s * 100) / 100, tradesToday: session.n,
    });
    this.stance = st.stance;
    kvSet(this.d.store, "scalp_stance", JSON.stringify({ ...st, at: new Date().toISOString() }));
    logSystemEvent(this.d.store, "SCALP", { stance: st.stance, conf: st.confidence, reason: st.reason.slice(0, 140) });
    log.info({ event: "scalp_stance", stance: st.stance, reason: st.reason.slice(0, 100) });
  }

  // ---------- shared context fetch ----------

  private async symbolContexts(): Promise<Array<{ instrument: string; features: FeatureSnapshot; regime: Regime; closes1m: import("../exchange/okx/types.ts").Candle[]; last5m: { close: number } | null }>> {
    const out = [];
    for (const sym of this.d.trading.instruments?.watchlist ?? []) {
      if (!this.d.instruments[sym]) continue;
      const c15 = (await getCandles(this.d.client, sym, "15m", 80)).filter((c) => c.confirm === "1").sort((a, b) => a.ts - b.ts);
      const c5 = (await getCandles(this.d.client, sym, this.d.cfg.signal_tf, 8)).filter((c) => c.confirm === "1").sort((a, b) => a.ts - b.ts);
      const c1 = (await getCandles(this.d.client, sym, this.d.cfg.base_tf, 140)).filter((c) => c.confirm === "1").sort((a, b) => a.ts - b.ts);
      if (c15.length < 60 || c1.length < 60) continue;
      const features = buildFeatures(sym, [...c15].reverse());
      out.push({ instrument: sym, features, regime: classifyRegime(features),
        closes1m: c1, last5m: c5.length >= 2 ? { close: c5[c5.length - 2]!.c } : null });
    }
    return out;
  }

  // ---------- main 5m tick ----------

  async tick(): Promise<void> {
    if (this.ticking || this.stopped) return;
    if (isEmergencyHalted(this.d.store)) return;
    this.ticking = true;
    try {
      const nowS = Math.floor(Date.now() / 1000);
      await this.ensureStance(nowS);
      if (this.stance === "DEFENSIVE") { log.info({ event: "scalp_skip_defensive" }); return; }

      const dayStart = dayStartIso();
      const today = (this.d.store.db.prepare(
        "SELECT COUNT(*) n FROM trades WHERE timeframe=? AND entry_ts>=?").get(TF_TAG, dayStart) as { n: number }).n;
      if (!dailyAllows(today, this.d.cfg.max_daily_trades)) {
        log.info({ event: "scalp_daily_cap", today }); return;
      }
      const openAll = getOpenTrades(this.d.store) as Array<Record<string, unknown>>;
      if (openAll.length >= this.d.risk.hard_limits.max_concurrent_positions) return;

      const snaps = await this.symbolContexts();
      const signals: ScalpSignal[] = [];
      for (const s of snaps) {
        const r = evaluateSignal(
          { instrument: s.instrument, closes1m: s.closes1m, last5m: s.last5m, regime: s.regime, features: s.features },
          this.d.cfg, nowS, this.lastExit);
        if (r.signal) signals.push(r.signal);
      }
      signals.sort((a, b) => b.score - a.score);

      // policy filter first (deterministic), LLM gate only for survivors — budgeted
      const hk = hourKey(new Date().toISOString());
      const budgetUsed = Number(JSON.parse(kvGet(this.d.store, `scalp_gate_${hk}`) ?? "0"));
      for (const sig of signals) {
        if (openAll.length + this.inFlight.size >= this.d.risk.hard_limits.max_concurrent_positions) break;
        if (openAll.some((t) => String(t.instrument) === sig.instrument)) continue; // one/symbol (shared)
        if (this.inFlight.has(sig.instrument)) continue;
        const pol = stanceAllows(this.stance, sig);
        if (!pol.allow) { log.info({ event: "scalp_policy_deny", inst: sig.instrument, reason: pol.reason }); continue; }
        if (this.d.cfg.llm_gate) {
          if (!budgetAllows(budgetUsed, this.d.cfg.llm_max_per_hour)) { log.info({ event: "scalp_gate_budget" }); break; }
          const snap = snaps.find((s) => s.instrument === sig.instrument)!;
          const g = await gateSignal(this.d.llm(), sig, this.d.cfg, {
            stance: this.stance, regime: snap.regime, atrPct15m: snap.features.atrPct, spreadOk: true,
          });
          const used = budgetUsed + 1;
          kvSet(this.d.store, `scalp_gate_${hk}`, String(used));
          if (!g.allow) { log.info({ event: "scalp_llm_deny", inst: sig.instrument, reason: g.reason.slice(0, 120) }); continue; }
          log.info({ event: "scalp_llm_allow", inst: sig.instrument, conf: g.confidence });
        }
        await this.openScalp(sig, snaps.find((s) => s.instrument === sig.instrument)!.features);
        if (signals.length > 0) break; // ≤1 new scalp per candle
      }
    } catch (e) {
      log.error({ event: "scalp_tick_error", error: e instanceof Error ? e.message : String(e) });
    } finally { this.ticking = false; }
  }

  // ---------- deterministic entry with LLM-approved context ----------

  private async openScalp(sig: ScalpSignal, features: FeatureSnapshot): Promise<void> {
    const { client, store, cfg, risk, instruments } = this.d;
    const meta = instruments[sig.instrument]!;
    try {
      const usdt = (await getPositions(client)).filter((p) => p.pos !== "0");
      const bal = await getBalance(client);
      const u = bal.details.find((x) => x.ccy === "USDT");
      const equity = u ? Number(u.eq) || Number(u.availEq) || 0 : 0;
      const localOpen = getOpenTrades(store) as Array<Record<string, unknown>>;
      const base = baseline(store, equity);
      const localKeys = new Set(localOpen.map((t) => `${String(t.instrument)}:${String(t.side).toLowerCase()}`));
      const exchangeKeys = new Set(usdt.map((p) => `${p.instId}:${p.posSide}`));
      const positionMismatch = [...localKeys].some((key) => !exchangeKeys.has(key)) ||
        [...exchangeKeys].some((key) => !localKeys.has(key));
      const kill = evaluateKillSwitch({
        apiOk: true,
        positionMismatch,
        orderFailuresRecent: this.consecutiveOrderFailures,
        clockDriftMs: Date.now() - await getServerTime(client),
        dbOk: true,
        instrumentMetaOk: Number(meta.ctVal) > 0,
        unexpectedPosition: usdt.length > risk.hard_limits.max_concurrent_positions,
        dailyLossPct: base.dayStartEquity > 0 ? ((base.dayStartEquity - equity) / base.dayStartEquity) * 100 : 0,
        drawdownPct: base.peakEquity > 0 ? ((base.peakEquity - equity) / base.peakEquity) * 100 : 0,
      }, risk, store);
      const gate = evaluateGlobalEntryGate({
        killSwitchActive: kill,
        botState: getBotState(store),
        openPositions: usdt.length,
        instrument: sig.instrument,
        instrumentOccupied: usdt.some((p) => p.instId === sig.instrument) ||
          localOpen.some((t) => String(t.instrument) === sig.instrument),
      }, risk);
      if (!gate.allowed) {
        log.info({ event: "scalp_global_risk_reject", inst: sig.instrument, reason: gate.reason });
        return;
      }
      this.inFlight.add(sig.instrument);
      const side = sig.direction === 1 ? "LONG" : "SHORT";
      let sz;
      try {
        sz = sizePosition({ equity, entryPrice: sig.price, stopPrice: sig.stopPx,
          leverage: this.d.trading.leverage.default, instrument: meta }, risk,
        { mode: "percent_of_equity", position_pct: cfg.position_pct });
      } catch (e) {
        log.info({ event: "scalp_sizing_reject", inst: sig.instrument, error: e instanceof Error ? e.message.slice(0, 80) : "" }); return;
      }
      // Re-read global risk immediately before the exchange write; bot pause,
      // emergency stop, loss limits, or an external position may have changed.
      const finalPositions = (await getPositions(client)).filter((p) => p.pos !== "0");
      const finalBal = await getBalance(client);
      const finalEquityRow = finalBal.details.find((x) => x.ccy === "USDT");
      const finalEquity = finalEquityRow ? Number(finalEquityRow.eq) || Number(finalEquityRow.availEq) || 0 : 0;
      const finalBase = baseline(store, finalEquity);
      const finalLocal = getOpenTrades(store) as Array<Record<string, unknown>>;
      const finalLocalKeys = new Set(finalLocal.map((t) => `${String(t.instrument)}:${String(t.side).toLowerCase()}`));
      const finalExchangeKeys = new Set(finalPositions.map((p) => `${p.instId}:${p.posSide}`));
      const finalKill = evaluateKillSwitch({
        apiOk: true,
        positionMismatch: [...finalLocalKeys].some((k) => !finalExchangeKeys.has(k)) || [...finalExchangeKeys].some((k) => !finalLocalKeys.has(k)),
        orderFailuresRecent: this.consecutiveOrderFailures,
        clockDriftMs: Date.now() - await getServerTime(client), dbOk: true, instrumentMetaOk: Number(meta.ctVal) > 0,
        unexpectedPosition: finalPositions.length > risk.hard_limits.max_concurrent_positions,
        dailyLossPct: finalBase.dayStartEquity > 0 ? ((finalBase.dayStartEquity - finalEquity) / finalBase.dayStartEquity) * 100 : 0,
        drawdownPct: finalBase.peakEquity > 0 ? ((finalBase.peakEquity - finalEquity) / finalBase.peakEquity) * 100 : 0,
      }, risk, store);
      const finalGate = evaluateGlobalEntryGate({
        killSwitchActive: finalKill, botState: getBotState(store), openPositions: finalPositions.length,
        instrument: sig.instrument, instrumentOccupied: finalPositions.some((p) => p.instId === sig.instrument) ||
          finalLocal.some((t) => String(t.instrument) === sig.instrument),
      }, risk);
      if (!finalGate.allowed) {
        log.info({ event: "scalp_global_risk_reject", inst: sig.instrument, reason: finalGate.reason, stage: "pre_order" });
        return;
      }
      try {
        sz = sizePosition({ equity: finalEquity, entryPrice: sig.price, stopPrice: sig.stopPx,
          leverage: this.d.trading.leverage.default, instrument: meta }, risk,
        { mode: "percent_of_equity", position_pct: cfg.position_pct });
      } catch (e) {
        log.info({ event: "scalp_sizing_reject", inst: sig.instrument, stage: "pre_order", error: e instanceof Error ? e.message.slice(0, 80) : "" }); return;
      }
      const clOpen = clId(side, "OPEN", sig.instrument);
      const placed = await placeOrder(client, {
        instId: sig.instrument, tdMode: "isolated", side: side === "LONG" ? "buy" : "sell",
        posSide: side.toLowerCase() as "long" | "short", ordType: "market", sz: sz.contracts, clOrdId: clOpen,
      });
      this.consecutiveOrderFailures = 0;
      const filled = await waitForOrderTerminal(client, sig.instrument, placed.ordId, { timeoutMs: 20_000 });
      if (filled.state !== "filled") throw new Error(`scalp entry not filled: ${filled.state}`);
      const entryPx = Number(filled.avgPx) || sig.price;
      const stopPx = side === "LONG" ? entryPx - (sig.price - sig.stopPx) : entryPx + (sig.stopPx - sig.price);
      const tpPx = side === "LONG" ? entryPx + (sig.tpPx - sig.price) : entryPx - (sig.tpPx - sig.price);
      const tradeId = `SCP-${String(Date.now()).slice(-8)}`;
      const decisionId = nextDecisionId();
      recordDecision(store, { decisionId, ts: new Date().toISOString(),
        instrument: sig.instrument, decision: side, strategy: "SCALP_V1", regime: sig.regime,
        rawConfidence: sig.score, calibratedConfidence: sig.score,
        thesis: [sig.reason.slice(0, 280)], riskVerdict: { approved: true, reason: `scalp ${this.stance}` } });
      const algo = await placeConditionalProtection(client, {
        instId: sig.instrument, posSide: side === "LONG" ? "long" : "short",
        contracts: sz.contracts, stopPrice: stopPx, takeProfitPrice: tpPx,
        clAlgoId: clId(side, "ALGO", sig.instrument),
      });
      openTrade(store, {
        tradeId, engine: "SCALP_5M", instrument: sig.instrument, timeframe: TF_TAG, side,
        strategy: "SCALP", strategyVersion: 1, regime: sig.regime, contracts: sz.contracts,
        entryPx, entryTs: new Date().toISOString(), stopPx, takeProfitPx: tpPx,
        clOpenId: clOpen, ordOpenId: placed.ordId,
        decisionId,
        rawConfidence: sig.score, calibratedConfidence: sig.score,
        plannedRiskPct: cfg.position_pct, leverage: this.d.trading.leverage.default, entryFeatures: features,
      });
      store.db.prepare("UPDATE trades SET algo_id=? WHERE trade_id=?").run(algo.algoId, tradeId);
      const fills = await getFills(client, sig.instrument, placed.ordId).catch(() => []);
      logSystemEvent(store, "TRADE_OPEN", { tradeId, instId: sig.instrument, side, scalpr: true,
        notional: Math.round(sz.notionalUsdt * 100) / 100 });
      log.info({ event: "scalp_open", tradeId, inst: sig.instrument, side, ct: sz.contracts,
        notional: Math.round(sz.notionalUsdt * 100) / 100, fills: fills.length });
    } catch (e) {
      this.consecutiveOrderFailures++;
      log.error({ event: "scalp_open_failed", inst: sig.instrument, error: e instanceof Error ? e.message.slice(0, 140) : String(e) });
    } finally { this.inFlight.delete(sig.instrument); }
  }

  // ---------- 15s sweep: SL/TP confirm + time-stop ----------

  private async sweep(): Promise<void> {
    try {
      if (isEmergencyHalted(this.d.store)) return;
      const scalps = (getOpenTrades(this.d.store) as Array<Record<string, unknown>>)
        .filter((t) => isTradeOwnedBy(t, "SCALP_5M"));
      if (scalps.length === 0) return;
      const poss = (await getPositions(this.d.client)).filter((p) => p.pos !== "0");
      const nowS = Math.floor(Date.now() / 1000);
      for (const t of scalps) {
        const pos = poss.find((p) => p.instId === String(t.instrument) && p.posSide === String(t.side).toLowerCase());
        if (!pos) continue;
        const meta = this.d.instruments[String(t.instrument)];
        if (!meta) continue;
        const slPlus = await updateTradeStopPlus(this.d.client, this.d.store, t, pos, meta, this.d.trading.position_management.sl_plus);
        const freshTrade = this.d.store.db.prepare("SELECT * FROM trades WHERE trade_id=? AND status='OPEN'").get(String(t.trade_id)) as Record<string, unknown> | undefined;
        if (!freshTrade) continue;
        const activeTrade = { ...freshTrade, stop_px: slPlus.stopPx };
        let reason: "SL" | "TP" | "TIME_STOP" | null = priceTrigger(activeTrade, Number(pos.markPx));
        if (!reason && (pos as Position)) {
          const ageS = nowS - Math.floor(Date.parse(String(t.entry_ts)) / 1000);
          if (ageS > this.d.cfg.max_hold_s) reason = "TIME_STOP";
        }
        if (reason) {
          this.lastExit[String(t.instrument)] = nowS;
          log.warn({ event: "scalp_exit", tradeId: String(t.trade_id), inst: String(t.instrument), reason });
          await closeTradeOnExchange(this.depsFor(), t as never, pos as Position, reason)
            .catch((e) => log.warn({ event: "scalp_close_fail", err: e instanceof Error ? e.message.slice(0, 120) : "" }));
        }
      }
    } catch (e) {
      log.warn({ event: "scalp_sweep_error", error: e instanceof Error ? e.message.slice(0, 100) : "" });
    }
  }

  // small helper so sweep can call executor with the same deps shape
  depsFor(): import("../execution/executor.ts").ExecutorDeps {
    return { client: this.d.client, trading: this.d.trading, risk: this.d.risk, store: this.d.store,
      instruments: this.d.instruments, watchlist: Object.keys(this.d.instruments) };
  }
}
