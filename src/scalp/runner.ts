// ScalpRunner — 5m hybrid scalp engine (§46).
// Hot path DETERMINISTIC (src/scalp/signals.ts); LLM present in two places
// (§ user requirement), both fail-closed:
//   • supervisor: stance every stance_refresh_s (default 15m)
//   • gate: ALLOW/DENY per candidate, using the authoritative Scalp role budget
// Hard limits enforced here, not by the LLM: max daily trades, per-symbol
// cooldown, total position cap (shared with 15m pipeline), one scalp/symbol,
// time-stop (max_hold_s), SL/TP via exchange algo + 15s ticker fallback.
import type { OkxClient } from "../exchange/okx/client.ts";
import type { InstrumentInfo } from "../exchange/okx/types.ts";
import { getCandles } from "../exchange/okx/market.ts";
import { getBalance, getPositions } from "../exchange/okx/account.ts";
import { getServerTime } from "../exchange/okx/market.ts";
import { waitForOrderTerminal, getFills } from "../exchange/okx/orders.ts";
import { placeConditionalProtection } from "../exchange/okx/algo.ts";
import { updateTradeStopPlus } from "../execution/position-management.ts";
import type { RiskConfig, TradingConfig } from "../core/config.ts";
import type { Store } from "../memory/db.ts";
import { kvSet, logSystemEvent } from "../memory/db.ts";
import { openTrade, nextDecisionId, recordDecision } from "../memory/trades.ts";
import { getOpenTrades } from "../memory/trades.ts";
import { buildFeatures, type FeatureSnapshot } from "../market/features.ts";
import { classifyRegime } from "../market/regime.ts";
import { clId, closeTradeOnExchange, priceTrigger, synchronizeEntryLeverage, confirmedFillLeverage, submitReservedEntry } from "../execution/executor.ts";
import { selectedEntryLeverage, serializeRiskEntry, releaseEntry } from "../core/runtime-risk.ts";
import { entrySettingsFingerprint } from "../core/runtime-trading.ts";
import { persistEntryCapital } from "../core/capital.ts";
import { CandleCloseScheduler, msForBar } from "../core/scheduler.ts";
import { createLogger } from "../core/logger.ts";
import type { RoleLlmService } from "../core/llm-role-service.ts";
import { fetchStance, gateSignal } from "../agents/scalp-agent.ts";
import {
  evaluateSignal, stanceAllows, dailyAllows,
  type ScalpCfg, type ScalpSignal, type Stance,
} from "./signals.ts";
import { sizePosition } from "../risk/position-sizing.ts";
import type { Regime } from "../market/regime.ts";
import { baseline, getBotState, isEmergencyHalted } from "../core/state.ts";
import { evaluateKillSwitch } from "../risk/limits.ts";
import { evaluateGlobalEntryGate } from "../risk/global-entry-gate.ts";
import type { Position } from "../exchange/okx/types.ts";
import { isTradeOwnedBy } from "../memory/engines.ts";
import { candidateStopRiskPct, portfolioOpenRisk } from "../risk/portfolio-open-risk.ts";
import { recordScanState, recordScalpScanResult } from "../market/scan-state.ts";
import { recordCandidateAttempt, recordOpportunityMetric } from "../market/opportunity-funnel.ts";
import { scanSymbolsIsolated } from "../market/isolated-scan.ts";
import { runScalpCandidateQueue, type ScalpEntryOutcome } from "./candidate-queue.ts";
import { latestConfirmedCandleClose } from "./candles.ts";

const log = createLogger("scalp");
const TF_TAG = "scalp";

export interface ScalpDeps {
  client: OkxClient;
  trading: TradingConfig;
  risk: RiskConfig;
  store: Store;
  instruments: Record<string, InstrumentInfo>;
  llm: RoleLlmService;
  cfg: ScalpCfg;
  entryUniverse?: () => readonly string[];
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
    const st = await fetchStance(this.d.llm, {
      regimes, atrPcts: atrs, sessionPnlR: Math.round(session.s * 100) / 100, tradesToday: session.n,
    });
    this.stance = st.stance;
    kvSet(this.d.store, "scalp_stance", JSON.stringify({ ...st, at: new Date().toISOString() }));
    logSystemEvent(this.d.store, "SCALP", { stance: st.stance, conf: st.confidence, reason: st.reason.slice(0, 140) });
    log.info({ event: "scalp_stance", stance: st.stance, reason: st.reason.slice(0, 100) });
  }

  // ---------- shared context fetch ----------

  private async symbolContexts(recordScanFailures = false): Promise<Array<{ instrument: string; features: FeatureSnapshot; regime: Regime; closes1m: import("../exchange/okx/types.ts").Candle[]; last5m: { close: number } | null }>> {
    const symbols = this.d.entryUniverse?.() ?? this.d.trading.instruments?.watchlist ?? [];
    const fetchableSymbols = symbols.filter(sym => Boolean(this.d.instruments[sym]));
    const scan = await scanSymbolsIsolated(symbols, async sym => {
      if (!this.d.instruments[sym]) {
        if (recordScanFailures) recordScanState(this.d.store, { engine: "SCALP_5M", instrument: sym,
          scannedAt: new Date().toISOString(), result: "SKIPPED", reason: "instrument_metadata_unavailable" });
        return null;
      }
      const c15 = (await getCandles(this.d.client, sym, "15m", 80)).filter((c) => c.confirm === "1").sort((a, b) => a.ts - b.ts);
      const c5 = await getCandles(this.d.client, sym, this.d.cfg.signal_tf, 8);
      const c1 = (await getCandles(this.d.client, sym, this.d.cfg.base_tf, 140)).filter((c) => c.confirm === "1").sort((a, b) => a.ts - b.ts);
      if (c15.length < 60 || c1.length < 60) {
        if (recordScanFailures) recordOpportunityMetric(this.d.store, "SCALP_5M", "INSUFFICIENT_DATA");
        if (recordScanFailures) recordScanState(this.d.store, { engine: "SCALP_5M", instrument: sym,
          scannedAt: new Date().toISOString(), result: "SKIPPED", reason: "insufficient_confirmed_candles" });
        return null;
      }
      const features = buildFeatures(sym, [...c15].reverse());
      return { instrument: sym, features, regime: classifyRegime(features),
        closes1m: c1, last5m: latestConfirmedCandleClose(c5) };
    }, (sym, error) => {
      if (recordScanFailures) recordScanState(this.d.store, { engine: "SCALP_5M", instrument: sym,
        scannedAt: new Date().toISOString(), result: "FETCH_FAILED", reason: "market_data_fetch_failed" });
      if (recordScanFailures) {
        recordOpportunityMetric(this.d.store, "SCALP_5M", "MARKET_DATA_FAILED");
        log.warn({ event: "scalp_symbol_fetch_failed", instrument: sym,
          error: error instanceof Error ? error.message : String(error) });
      }
    });
    // A failure for every fetchable symbol is the only available strong signal
    // of a shared feed outage. Isolated failures do not cancel the cycle.
    if (recordScanFailures && fetchableSymbols.length > 0 && scan.failures.length === fetchableSymbols.length) {
      throw new Error("SCALP_MARKET_DATA_GLOBAL_FAILURE");
    }
    return scan.values;
  }

  // ---------- main 5m tick ----------

  async tick(): Promise<void> {
    if (this.ticking || this.stopped) return;
    if (isEmergencyHalted(this.d.store)) return;
    this.ticking = true;
    try {
      const nowS = Math.floor(Date.now() / 1000);
      await this.ensureStance(nowS);
      if (this.stance === "DEFENSIVE") {
        recordOpportunityMetric(this.d.store, "SCALP_5M", "STANCE_REJECT", "DEFENSIVE");
        log.info({ event: "scalp_skip_defensive" });
      }

      const dayStart = dayStartIso();
      const today = (this.d.store.db.prepare(
        "SELECT COUNT(*) n FROM trades WHERE timeframe=? AND entry_ts>=?").get(TF_TAG, dayStart) as { n: number }).n;
      if (!dailyAllows(today, this.d.cfg.max_daily_trades)) {
        recordOpportunityMetric(this.d.store, "SCALP_5M", "RISK_REJECT", "DAILY_TRADE_CAP");
        log.info({ event: "scalp_daily_cap", today }); return;
      }
      const openAll = getOpenTrades(this.d.store) as Array<Record<string, unknown>>;
      if (openAll.length >= this.d.risk.hard_limits.max_concurrent_positions) {
        recordOpportunityMetric(this.d.store, "SCALP_5M", "RISK_REJECT", "POSITION_LIMIT");
        return;
      }

      const snaps = await this.symbolContexts(true);
      const signals: ScalpSignal[] = [];
      for (const s of snaps) {
        recordOpportunityMetric(this.d.store, "SCALP_5M", "SYMBOLS_EVALUATED");
        const r = evaluateSignal(
          { instrument: s.instrument, closes1m: s.closes1m, last5m: s.last5m, regime: s.regime, features: s.features },
          this.d.cfg, nowS, this.lastExit);
        const signal = r.signal;
        recordScalpScanResult(this.d.store, {
          instrument: s.instrument, scannedAt: new Date().toISOString(),
          // evaluateSignal's price, indicators and setup checks consume confirmed 1m candles.
          candleTs: s.closes1m.at(-1)?.ts ?? null,
          candleTimeframe: this.d.cfg.base_tf,
          ...(signal ? { signal: { direction: signal.direction, score: signal.score } } : { veto: r.veto ?? "no_setup" }),
        });
        if (r.signal) {
          recordOpportunityMetric(this.d.store, "SCALP_5M", "CANDIDATE_GENERATED");
          signals.push(r.signal);
        } else {
          recordOpportunityMetric(this.d.store, "SCALP_5M", "NO_SETUP");
          recordOpportunityMetric(this.d.store, "SCALP_5M", "HARD_CONDITION_FAILED", scalpBlocker(r.veto));
        }
      }
      signals.sort((a, b) => b.score - a.score);

      const cycleId = `SCALP-${Date.now()}`;
      await runScalpCandidateQueue(signals, this.d.cfg.max_candidate_attempts_per_cycle, async (sig, rank): Promise<ScalpEntryOutcome> => {
        const trace = (gateResult: string | null, riskResult: string | null, finalResult: string, reason?: string) => {
          recordCandidateAttempt(this.d.store, { cycleId, engine: "SCALP_5M", rank,
            instrument: sig.instrument, strategy: "SCALP_V1", setupScore: sig.score,
            gateResult, riskResult, finalResult, ...(reason ? { reason } : {}) });
        };
        if (openAll.length + this.inFlight.size >= this.d.risk.hard_limits.max_concurrent_positions) {
          trace(null, "MAX_CONCURRENT_POSITIONS", "GLOBAL_STOP", "MAX_CONCURRENT_POSITIONS");
          return { kind: "GLOBAL_STOP", reason: "MAX_CONCURRENT_POSITIONS", riskResult: "MAX_CONCURRENT_POSITIONS" };
        }
        if (openAll.some((t) => String(t.instrument) === sig.instrument) || this.inFlight.has(sig.instrument)) {
          trace(null, "INSTRUMENT_ALREADY_OCCUPIED", "CANDIDATE_REJECT", "SYMBOL_OCCUPIED");
          return { kind: "CANDIDATE_REJECT", reason: "SYMBOL_OCCUPIED", riskResult: "INSTRUMENT_ALREADY_OCCUPIED" };
        }
        const pol = stanceAllows(this.stance, sig);
        if (!pol.allow) {
          const dimension = this.stance === "DEFENSIVE" ? "DEFENSIVE" : "NEUTRAL_SCORE";
          recordOpportunityMetric(this.d.store, "SCALP_5M", "STANCE_REJECT", dimension);
          trace(null, null, "STANCE_REJECT", dimension);
          log.info({ event: "scalp_policy_deny", inst: sig.instrument, reason: pol.reason });
          return { kind: "CANDIDATE_REJECT", reason: dimension };
        }
        if (!this.d.cfg.llm_gate) {
          trace(null, null, "GLOBAL_STOP", "LLM_GATE_DISABLED");
          log.info({ event: "scalp_skip_gate_disabled" });
          return { kind: "GLOBAL_STOP", reason: "LLM_GATE_DISABLED" };
        }
        const snap = snaps.find((s) => s.instrument === sig.instrument)!;
        const g = await gateSignal(this.d.llm, sig, this.d.cfg, {
          stance: this.stance, regime: snap.regime, atrPct15m: snap.features.atrPct, spreadOk: true,
        });
        if (!g.allow) {
          if (g.unavailable) {
            const latestRun = this.d.store.db.prepare(`SELECT status FROM llm_runs WHERE role='scalp' AND context_ref='scalp_candidate_gate'
              ORDER BY id DESC LIMIT 1`).get() as { status?: string } | undefined;
            const failure = safeLlmFailureDimension(latestRun?.status);
            recordOpportunityMetric(this.d.store, "SCALP_5M", "GATE_ERROR", failure);
            if (latestRun?.status === "BUDGET_EXHAUSTED") recordOpportunityMetric(this.d.store, "SCALP_5M", "BUDGET_EXHAUSTED");
            trace("ERROR", null, "GLOBAL_STOP", failure);
            log.info({ event: "scalp_llm_unavailable_stop", inst: sig.instrument, status: failure });
            return { kind: "GLOBAL_STOP", reason: failure };
          }
          recordOpportunityMetric(this.d.store, "SCALP_5M", "GATE_DENY", "DENY");
          trace("DENY", null, "GATE_DENY", "DENY");
          log.info({ event: "scalp_llm_deny", inst: sig.instrument, reason: g.reason.slice(0, 120) });
          return { kind: "CANDIDATE_REJECT", reason: "GATE_DENY" };
        }
        recordOpportunityMetric(this.d.store, "SCALP_5M", "GATE_ALLOW");
        log.info({ event: "scalp_llm_allow", inst: sig.instrument, conf: g.confidence });
        const outcome = await this.openScalp(sig, snap.features);
        trace("ALLOW", outcome.riskResult ?? null, outcome.kind, outcome.reason);
        return outcome;
      });
    } catch (e) {
      log.error({ event: "scalp_tick_error", error: e instanceof Error ? e.message : String(e) });
    } finally { this.ticking = false; }
  }

  // ---------- deterministic entry with LLM-approved context ----------

  private async openScalp(sig: ScalpSignal, features: FeatureSnapshot): Promise<ScalpEntryOutcome> {
    return serializeRiskEntry(this.d.store, () => this.openScalpSerialized(sig, features));
  }

  private async openScalpSerialized(sig: ScalpSignal, features: FeatureSnapshot): Promise<ScalpEntryOutcome> {
    const { client, store, cfg, risk, instruments } = this.d;
    const meta = instruments[sig.instrument];
    if (!meta || !(Number(meta.ctVal) > 0)) {
      recordOpportunityMetric(store, "SCALP_5M", "RISK_REJECT", "INSTRUMENT_METADATA");
      return { kind: "GLOBAL_STOP", reason: "INSTRUMENT_METADATA_UNAVAILABLE", riskResult: "STATE_UNCERTAIN" };
    }
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
        const dimension = scalpRiskBlocker(gate.reason);
        recordOpportunityMetric(store, "SCALP_5M", "RISK_REJECT", dimension);
        log.info({ event: "scalp_global_risk_reject", inst: sig.instrument, reason: gate.reason });
        return gate.reason === "INSTRUMENT_ALREADY_OCCUPIED" || gate.reason === "INSTRUMENT_NOT_ALLOWED"
          ? { kind: "CANDIDATE_REJECT", reason: dimension, riskResult: gate.reason }
          : { kind: "GLOBAL_STOP", reason: dimension, riskResult: gate.reason };
      }
      this.inFlight.add(sig.instrument);
      const side = sig.direction === 1 ? "LONG" : "SHORT";
      let sz;
      try {
        sz = sizePosition({ equity, entryPrice: sig.price, stopPrice: sig.stopPx,
          leverage: selectedEntryLeverage(this.d.trading, risk), instrument: meta }, risk,
        { mode: "percent_of_equity", position_pct: cfg.position_pct });
      } catch (e) {
        recordOpportunityMetric(store, "SCALP_5M", "RISK_REJECT", "SIZING_REJECTED");
        log.info({ event: "scalp_sizing_reject", inst: sig.instrument, error: e instanceof Error ? e.message.slice(0, 80) : "" });
        return { kind: "CANDIDATE_REJECT", reason: "SIZING_REJECTED", riskResult: "SIZING_REJECTED" };
      }
      const settingsAtPreparation = entrySettingsFingerprint(this.d.trading, risk);
      const leverage = await synchronizeEntryLeverage(this.d, sig.instrument);
      // Re-read global risk immediately before the exchange write; bot pause,
      // emergency stop, loss limits, or an external position may have changed.
      const finalPositions = (await getPositions(client)).filter((p) => p.pos !== "0");
      const finalBal = await getBalance(client);
      const finalEquityRow = finalBal.details.find((x) => x.ccy === "USDT");
      const finalEquity = finalEquityRow ? Number(finalEquityRow.eq) || Number(finalEquityRow.availEq) || 0 : 0;
      const finalBase = baseline(store, finalEquity);
      const finalLocal = getOpenTrades(store) as Array<Record<string, unknown>>;
      if (finalLocal.some((trade) => String(trade.status) === "RECONCILIATION_PENDING")) {
        recordOpportunityMetric(store, "SCALP_5M", "RISK_REJECT", "RECONCILIATION_PENDING");
        log.info({ event: "scalp_global_risk_reject", inst: sig.instrument, reason: "RECONCILIATION_PENDING", stage: "pre_order" });
        logSystemEvent(store, "RISK_REJECT", { engine: "SCALP_5M", instId: sig.instrument, reason: "RECONCILIATION_PENDING" });
        return { kind: "GLOBAL_STOP", reason: "RECONCILIATION_PENDING", riskResult: "RECONCILIATION_PENDING" };
      }
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
      if (entrySettingsFingerprint(this.d.trading, risk) !== settingsAtPreparation) {
        recordOpportunityMetric(store, "SCALP_5M", "RISK_REJECT", "SETTINGS_CHANGED");
        log.info({ event: "scalp_global_risk_reject", inst: sig.instrument,
          reason: "ENTRY_SETTINGS_CHANGED", stage: "pre_order" });
        return { kind: "GLOBAL_STOP", reason: "SETTINGS_CHANGED", riskResult: "ENTRY_SETTINGS_CHANGED" };
      }
      try {
        sz = sizePosition({ equity: finalEquity, entryPrice: sig.price, stopPrice: sig.stopPx,
          leverage, instrument: meta }, risk,
        { mode: "percent_of_equity", position_pct: cfg.position_pct });
      } catch (e) {
        recordOpportunityMetric(store, "SCALP_5M", "RISK_REJECT", "SIZING_REJECTED");
        log.info({ event: "scalp_sizing_reject", inst: sig.instrument, stage: "pre_order", error: e instanceof Error ? e.message.slice(0, 80) : "" });
        return { kind: "CANDIDATE_REJECT", reason: "SIZING_REJECTED", riskResult: "SIZING_REJECTED" };
      }
      const portfolio = portfolioOpenRisk({ equity: finalEquity, positions: finalPositions, trades: finalLocal, instruments: this.d.instruments });
      const candidateRisk = candidateStopRiskPct(Number(sz.contracts) * Number(meta.ctVal) * Math.abs(sig.price - sig.stopPx), finalEquity);
      const finalGate = evaluateGlobalEntryGate({
        killSwitchActive: finalKill, botState: getBotState(store), openPositions: finalPositions.length,
        instrument: sig.instrument, instrumentOccupied: finalPositions.some((p) => p.instId === sig.instrument) ||
          finalLocal.some((t) => String(t.instrument) === sig.instrument),
        portfolioOpenRiskPct: portfolio.riskPct, candidateRiskPct: candidateRisk,
      }, risk);
      if (!finalGate.allowed) {
        const dimension = scalpRiskBlocker(finalGate.reason);
        recordOpportunityMetric(store, "SCALP_5M", "RISK_REJECT", dimension);
        log.info({ event: "scalp_global_risk_reject", inst: sig.instrument, reason: finalGate.reason, stage: "pre_order" });
        logSystemEvent(store, "RISK_REJECT", { engine: "SCALP_5M", instId: sig.instrument, reason: finalGate.reason,
          checks: finalGate.checks, portfolioOpenRiskPct: portfolio.riskPct, candidateRiskPct: candidateRisk });
        return finalGate.reason === "INSTRUMENT_ALREADY_OCCUPIED" || finalGate.reason === "INSTRUMENT_NOT_ALLOWED"
          ? { kind: "CANDIDATE_REJECT", reason: dimension, riskResult: finalGate.reason }
          : { kind: "GLOBAL_STOP", reason: dimension, riskResult: finalGate.reason };
      }
      recordOpportunityMetric(store, "SCALP_5M", "RISK_PASS");
      const clOpen = clId(side, "OPEN", sig.instrument);
      const placed = await submitReservedEntry(this.d, {
        instId: sig.instrument, tdMode: "isolated", side: side === "LONG" ? "buy" : "sell",
        posSide: side.toLowerCase() as "long" | "short", ordType: "market", sz: sz.contracts, clOrdId: clOpen,
      });
      recordOpportunityMetric(store, "SCALP_5M", "ORDER_SUBMITTED");
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
      const entryPosition = (await getPositions(client, sig.instrument).catch(() => []))
        .find((p) => p.instId === sig.instrument && p.posSide === side.toLowerCase() && Number(p.pos) !== 0);
      openTrade(store, {
        tradeId, engine: "SCALP_5M", instrument: sig.instrument, timeframe: TF_TAG, side,
        strategy: "SCALP", strategyVersion: 1, regime: sig.regime, contracts: sz.contracts,
        entryPx, entryTs: new Date().toISOString(), stopPx, takeProfitPx: tpPx,
        clOpenId: clOpen, ordOpenId: placed.ordId,
        decisionId,
        rawConfidence: sig.score, calibratedConfidence: sig.score,
        plannedRiskPct: Number(sz.contracts) * Number(meta.ctVal) * Math.abs(entryPx - stopPx) / finalEquity * 100,
        leverage: confirmedFillLeverage(entryPosition ?? filled, confirmedFillLeverage(filled, leverage)), entryFeatures: features,
      });
      try {
        const algo = await placeConditionalProtection(client, {
          instId: sig.instrument, posSide: side === "LONG" ? "long" : "short",
          contracts: sz.contracts, stopPrice: stopPx, takeProfitPrice: tpPx,
          clAlgoId: clId(side, "ALGO", sig.instrument),
        });
        store.db.prepare("UPDATE trades SET algo_id=? WHERE trade_id=?").run(algo.algoId, tradeId);
      } catch (error) {
        logSystemEvent(store, "RISK_EVENT", { protection_degraded: String(error), tradeId, fallback: "Layer B bot monitor" });
      }
      releaseEntry(store, clOpen);
      try { persistEntryCapital(store, tradeId, entryPosition, meta, finalEquity, leverage); }
      catch { log.warn({ event: "entry_capital_persistence_failed", tradeId }); }
      const fills = await getFills(client, sig.instrument, placed.ordId).catch(() => []);
      logSystemEvent(store, "TRADE_OPEN", { tradeId, instId: sig.instrument, side, scalpr: true,
        notional: Math.round(sz.notionalUsdt * 100) / 100 });
      recordOpportunityMetric(store, "SCALP_5M", "POSITION_OPENED");
      log.info({ event: "scalp_open", tradeId, inst: sig.instrument, side, ct: sz.contracts,
        notional: Math.round(sz.notionalUsdt * 100) / 100, fills: fills.length });
      return { kind: "OPENED", reason: "POSITION_OPENED", riskResult: "RISK_PASS" };
    } catch (e) {
      log.error({ event: "scalp_open_failed", inst: sig.instrument, error: e instanceof Error ? e.message.slice(0, 140) : String(e) });
      if (e instanceof Error && e.message === "entry leverage: instrument already occupied") {
        recordOpportunityMetric(store, "SCALP_5M", "RISK_REJECT", "SYMBOL_OCCUPIED");
        return { kind: "CANDIDATE_REJECT", reason: "SYMBOL_OCCUPIED", riskResult: "INSTRUMENT_ALREADY_OCCUPIED" };
      }
      this.consecutiveOrderFailures++;
      return { kind: "GLOBAL_STOP", reason: "EXCHANGE_OR_EXECUTION_FAILURE", riskResult: "GLOBAL_STOP" };
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

export function scalpBlocker(reason: string | undefined): string {
  if (!reason) return "no_setup";
  if (reason.startsWith("regime:")) return "regime";
  if (reason.startsWith("atr15")) return "atr15";
  if (reason.startsWith("ema")) return "ema";
  if (reason.startsWith("rsi")) return "rsi";
  if (reason.startsWith("volume")) return "volume";
  if (reason.startsWith("score")) return "score";
  if (reason.startsWith("sideways-score")) return "sideways-score";
  if (reason.startsWith("sideways-volume")) return "sideways-volume";
  if (reason.startsWith("sideways-confirmation")) return "sideways-confirmation";
  if (reason.startsWith("fee-guard")) return "fee-guard";
  if (reason.startsWith("cooldown")) return "cooldown";
  if (reason.startsWith("warmup")) return "warmup";
  if (reason.startsWith("bad-data")) return "bad-data";
  if (reason.startsWith("stop-degenerate")) return "stop-geometry";
  return "other";
}

function scalpRiskBlocker(reason: string): string {
  if (reason.startsWith("KILL_SWITCH_ACTIVE")) return "KILL_SWITCH";
  if (reason.startsWith("BOT_")) return "BOT_STATE";
  if (reason === "MAX_CONCURRENT_POSITIONS") return "POSITION_LIMIT";
  if (reason === "INSTRUMENT_ALREADY_OCCUPIED") return "SYMBOL_OCCUPIED";
  if (reason === "INSTRUMENT_NOT_ALLOWED") return "SYMBOL_NOT_ALLOWED";
  if (reason.startsWith("PORTFOLIO_OPEN_RISK")) return "PORTFOLIO_RISK";
  if (reason === "RECONCILIATION_PENDING") return "RECONCILIATION";
  if (reason.startsWith("STATE_UNCERTAIN")) return "STATE_UNCERTAIN";
  return "GLOBAL_RISK";
}

function safeLlmFailureDimension(status?: string): string {
  if (status === "BUDGET_EXHAUSTED") return "BUDGET_EXHAUSTED";
  if (status === "RATE_LIMIT") return "RATE_LIMIT";
  if (status === "TIMEOUT") return "TIMEOUT";
  if (status === "AUTHENTICATION_FAILED") return "AUTHENTICATION_FAILED";
  if (status === "INVALID_RESPONSE") return "INVALID_RESPONSE";
  if (status === "NETWORK_ERROR") return "NETWORK_ERROR";
  if (status === "HTTP_ERROR") return "HTTP_ERROR";
  if (status === "PROVIDER_ERROR") return "PROVIDER_ERROR";
  return "LLM_UNAVAILABLE";
}
