// EvoQuant bot entrypoint — §43 startup, §42 candle loop, §45 recovery.
// DEMO ONLY: refuses to run unless OKX_ENV=demo (§44, enforced in config+client).
import { loadRepoEnv, REPO_ROOT } from "./env.ts";
import { assertDemo, loadRiskConfig, loadTradingConfig } from "./config.ts";
import { openStore, logSystemEvent, persistMarketSnapshot } from "../memory/db.ts";
import { createDemoExchange } from "../exchange/okx/index.ts";
import { getCandles, getHistoryCandlesPaged, latestClosedCandle, getTicker } from "../exchange/okx/market.ts";
import type { Candle, InstrumentInfo } from "../exchange/okx/types.ts";
import { buildFeatures, type FeatureSnapshot } from "../market/features.ts";
import { classifyRegime, type Regime } from "../market/regime.ts";
import { loadStrategies, saveStrategy, type StrategyDef } from "../strategy/library.ts";
import { scanInstruments, scanCoreV2, pickEntry, type ScanRow } from "../strategy/scanner.ts";
import { type TradeCandidate, persistV2Definitions, parseStrategyV2Params } from "../strategy/core-v2.ts";
import { startupSafetySequence, runTick, emergencyStop, getLastKillReason, persistCandles, priceTrigger } from "../execution/executor.ts";
import { closeTradeOnExchange } from "../execution/executor.ts";
import { getPositions } from "../exchange/okx/account.ts";
import { getOpenTrades } from "../memory/trades.ts";
import { isTradeOwnedBy } from "../memory/engines.ts";
import { CandleCloseScheduler, msForBar } from "./scheduler.ts";
import { ScalpRunner } from "../scalp/runner.ts";
import type { ScalpCfg } from "../scalp/signals.ts";
import { updateTradeStopPlus } from "../execution/position-management.ts";
import { getBotState, setBotState } from "./state.ts";
import { decide, gateCandidate, holdBecause, type Decision } from "../agents/decision-agent.ts";
import { reviewTrade } from "../agents/reviewer-agent.ts";
import { maybeEvolveStrategies } from "../agents/evolution-agent.ts";
import { getWeights, maybeEvolveWeights } from "../learning/signal-weights.ts";
import { recomputeCalibration } from "../learning/confidence.ts";
import { compareAndMaybePromote } from "../evaluation/champion-challenger.ts";
import { DEFAULT_V2_COSTS } from "../evaluation/backtest.ts";
import { createLogger } from "./logger.ts";
import { startDashboard } from "./dashboard.ts";
import YAML from "yaml";
import { readFileSync } from "node:fs";
import path from "node:path";

const log = createLogger("main");
const env = loadRepoEnv(REPO_ROOT);

async function main(): Promise<void> {
  assertDemo(env); // §44
  const trading = loadTradingConfig();
  const baselineMode = trading.validation.baseline_mode;
  const configuredRisk = loadRiskConfig();
  const risk = baselineMode ? { ...configuredRisk, hard_limits: { ...configuredRisk.hard_limits, max_concurrent_positions: 1 } } : configuredRisk;
  const evolution = YAML.parse(readFileSync(path.join(REPO_ROOT, "config/evolution.yaml"), "utf8")) as {
    enabled?: boolean; signal_learning_enabled?: boolean; strategy_evolution_enabled?: boolean; automatic_promotion_enabled?: boolean;
    signal_evolution_interval_trades: number; strategy_evolution_interval_trades: number;
    minimum_validation_sample: number; constraints: {
      max_weight_change_per_cycle_pct: number; max_param_changes_per_challenger: number;
      champion_vs_challenger: { requires_out_of_sample: boolean; requires_walk_forward: boolean; min_sample_each_side: number; min_positive_symbols: number; min_positive_walk_forward_folds: number };
    };
  };
  const v2Params = parseStrategyV2Params(YAML.parse(readFileSync(path.join(REPO_ROOT, "config/strategy-v2.yaml"), "utf8")));
  const evaluationConfig = YAML.parse(readFileSync(path.join(REPO_ROOT, "config/evaluation.yaml"), "utf8")) as {
    history_days: number; history_page_size: number; history_max_pages: number;
    costs: { entry_fee_pct: number; exit_fee_pct: number; slippage_bps_per_side: number; spread_bps_per_side: number };
  };
  const historyConfig = evaluationConfig;
  const backtestCosts = { ...DEFAULT_V2_COSTS,
    entryFeePct: evaluationConfig.costs.entry_fee_pct, exitFeePct: evaluationConfig.costs.exit_fee_pct,
    slippageBps: evaluationConfig.costs.slippage_bps_per_side, spreadBps: evaluationConfig.costs.spread_bps_per_side,
    slPlus: { enabled: trading.position_management.sl_plus.enabled,
      activationR: trading.position_management.sl_plus.activation_r, lockInR: trading.position_management.sl_plus.lock_in_r,
      minProfitBufferPct: trading.position_management.sl_plus.min_profit_buffer_pct },
  };

  const store = openStore(REPO_ROOT);
  if (baselineMode) persistV2Definitions(store, v2Params);
  const { client } = createDemoExchange(env);
  // multi-coin scan (§17): watchlist metadata cached at startup (§7.2/§43)
  const watchlistReq = trading.instruments?.watchlist ?? [trading.instrument.id];
  const allSwaps = await import("../exchange/okx/market.ts").then((m) => m.getInstruments(client, "SWAP"));
  const instruments: Record<string, InstrumentInfo> = {};
  for (const w of watchlistReq) {
    const i = allSwaps.find((x) => x.instId === w);
    if (i) instruments[w] = i;
    else log.warn({ event: "watchlist_symbol_no_metadata", instId: w });
  }
  const watchlist = Object.keys(instruments);
  if (watchlist.length === 0) throw new Error("no watchlist instruments have metadata (§43)");
  const anchor = watchlist.includes(trading.instrument.id) ? trading.instrument.id : watchlist[0]!;
  const deps = { client, trading, risk, store, instruments, watchlist };
  if (baselineMode || evolution.enabled === false) {
    logSystemEvent(store, "EVOLUTION_FROZEN", { reason: baselineMode ? "baseline_validation_mode" : "configuration_disabled",
      scalp: baselineMode ? "disabled" : "unchanged", maxConcurrentPositions: risk.hard_limits.max_concurrent_positions });
    log.info({ event: "evolution_frozen", reason: baselineMode ? "baseline_validation_mode" : "configuration_disabled" });
  } else {
    logSystemEvent(store, "EVOLUTION_RESUMED", { reason: "configuration_enabled", signalLearning: evolution.signal_learning_enabled !== false,
      strategyEvolution: evolution.strategy_evolution_enabled !== false, promotion: evolution.automatic_promotion_enabled !== false });
  }

  // per-symbol history for features/backtests
  const histories = new Map<string, Candle[]>();
  const historySince = Date.now() - historyConfig.history_days * 24 * 60 * 60 * 1000;
  for (const sym of watchlist) {
    const cached = store.db.prepare("SELECT ts,o,h,l,c,vol,volCcy,confirm FROM candles WHERE instId=? AND bar=? AND ts>=? ORDER BY ts ASC")
      .all(sym, trading.timeframe, historySince) as Candle[];
    let historic: Candle[] = [];
    if (!cached.length || cached[0]!.ts > historySince + msForBar(trading.timeframe)) {
      try {
        historic = await getHistoryCandlesPaged(client, sym, trading.timeframe as import("../exchange/okx/market.ts").Bar, historySince, {
          pageSize: historyConfig.history_page_size, maxPages: historyConfig.history_max_pages,
        });
      } catch (e) {
        log.warn({ event: "historical_backfill_failed", instId: sym, error: e instanceof Error ? e.message : String(e) });
      }
    }
    const recent = await getCandles(client, sym, trading.timeframe, 300);
    const merged = new Map<number, Candle>();
    for (const c of [...cached, ...historic, ...recent]) if (c.confirm === "1") merged.set(c.ts, c);
    const cs = [...merged.values()].sort((a, b) => a.ts - b.ts);
    histories.set(sym, cs);
    persistCandles(store, sym, trading.timeframe, cs);
  }

  setBotState(store, "STARTING");
  if (!(await startupSafetySequence(deps))) {
    setBotState(store, "RISK_HALTED");
    log.error({ event: "startup_failed", result: "trading disabled" });
    return;
  }
  loadStrategies(store);
  setBotState(store, "RUNNING");
  log.info({ event: "bot_started", state: getBotState(store) });

  const llm = {
    baseUrl: env.LLM_BASE_URL ?? "", apiKey: env["LLM_API"+"_KEY"] ?? "", model: env.LLM_MODEL ?? "qwen3.8-flash-free",
    timeoutMs: 150_000, temperature: 0.2,
  };
  // §87: different roles may use different models; unset → same as base
  const llmReview = { ...llm };
  const llmEvolve = { ...llm };
  // live re-read each tick so dashboard Settings apply without restart (§87)
  const refreshLlm = (): void => {
    const e2 = loadRepoEnv(REPO_ROOT);
    if (e2.LLM_BASE_URL) { llm.baseUrl = e2.LLM_BASE_URL; llmReview.baseUrl = e2.LLM_BASE_URL; llmEvolve.baseUrl = e2.LLM_BASE_URL; }
    const k = e2["LLM_API" + "_KEY"];
    for (const c of [llm, llmReview, llmEvolve]) if (k) c.apiKey = k;
    if (e2.LLM_MODEL) llm.model = e2.LLM_MODEL;
    llmReview.model = e2.LLM_MODEL_REVIEW ?? llm.model;
    llmEvolve.model = e2.LLM_MODEL_EVOLUTION ?? llm.model;
    if (e2.LLM_TEMPERATURE) { llm.temperature = Number(e2.LLM_TEMPERATURE); llmReview.temperature = Number(e2.LLM_TEMPERATURE); llmEvolve.temperature = Number(e2.LLM_TEMPERATURE); }
  };

  let lastTick: { features: unknown; regime: string; at: string } | null = null;
  let lastKill: string | null = null;
  let lastScan: ScanRow[] = [];
  const dash = startDashboard({
    port: Number(env.DASHBOARD_PORT ?? 8790),
    ...(env.DASHBOARD_BIND ? { bind: env.DASHBOARD_BIND } : {}),
    ...(env.DASHBOARD_USER ? { auth: { user: env.DASHBOARD_USER, password: env[["DASHBOARD","PASSWORD"].join("_")] ?? "" } } : {}),
    trading, risk, deps: () => deps,
    evolution: {
      reviewEvery: true,
      signalInterval: evolution.signal_evolution_interval_trades,
      strategyInterval: evolution.strategy_evolution_interval_trades,
      minSample: evolution.minimum_validation_sample,
      maxWeightChangePct: evolution.constraints.max_weight_change_per_cycle_pct,
      maxParamChanges: evolution.constraints.max_param_changes_per_challenger,
    },
    getLastTick: () => lastTick,
    getKillReason: () => getLastKillReason(),
    getScan: () => lastScan,
  });

  const ctxFor = (instId2: string, features: FeatureSnapshot, regime: Regime, strategies: StrategyDef[], candidate?: TradeCandidate) => ({
    features, regime, strategies,
    ...(candidate ? { candidate, gateCandidateFn: (c: TradeCandidate) => gateCandidate(REPO_ROOT, llm, c) } : {}),
    decideFn: async (feat: FeatureSnapshot, reg: Regime, hasPos: boolean): Promise<Decision> =>
      baselineMode ? holdBecause("baseline mode: deterministic exits only; AI CLOSE disabled")
        : decide(REPO_ROOT, llm, instId2, trading.timeframe, feat, reg, strategies, hasPos, store),
    reviewFn: async (id: string) => { await reviewTrade(REPO_ROOT, llmReview, store, id); },
    evolveFns: {
      weights: async () => { if (!baselineMode && evolution.enabled !== false && evolution.signal_learning_enabled !== false) await maybeEvolveWeights(store, evolution.signal_evolution_interval_trades, evolution.constraints.max_weight_change_per_cycle_pct, "SWING_15M", evolution.minimum_validation_sample); },
      calibration: () => { recomputeCalibration(store, "SWING_15M"); },
      strategies: async () => {
        if (!baselineMode && evolution.enabled !== false && evolution.strategy_evolution_enabled !== false) await maybeEvolveStrategies(REPO_ROOT, llmEvolve, store, evolution.strategy_evolution_interval_trades, evolution.constraints.max_param_changes_per_challenger, evolution.minimum_validation_sample);
      },
      promote: () => { if (!baselineMode && evolution.enabled !== false && evolution.automatic_promotion_enabled !== false) compareAndMaybePromote(store, histories, trading.timeframe, {
        minSampleEachSide: Math.max(evolution.minimum_validation_sample, evolution.constraints.champion_vs_challenger.min_sample_each_side),
        requireOutOfSample: evolution.constraints.champion_vs_challenger.requires_out_of_sample,
        requireWalkForward: evolution.constraints.champion_vs_challenger.requires_walk_forward,
        wfMinPositiveFolds: evolution.constraints.champion_vs_challenger.min_positive_walk_forward_folds,
        minPositiveSymbols: evolution.constraints.champion_vs_challenger.min_positive_symbols,
        requireDrawdownNonWorse: true,
      }, backtestCosts); },
    },
  });

  let ticking = false;
  const tick = async (): Promise<void> => {
    if (ticking) { log.info({ event: "tick_skipped_overlapping" }); return; } // mutex: 15m ticks can overrun while LLM is slow
    ticking = true;
    try {
      refreshLlm();
      const strategies = loadStrategies(store);
      // 1) refresh all watchlist candles + snapshots (§17 pipeline)
      const snaps: Array<{ instrument: string; features: FeatureSnapshot; regime: Regime }> = [];
      for (const sym of watchlist) {
        try {
          const cs = (await getCandles(client, sym, trading.timeframe, 300)).filter((c) => c.confirm === "1").sort((a, b) => a.ts - b.ts);
          // Keep the paginated startup history intact; the live endpoint only
          // returns the latest window and must not shrink the evaluation set.
          const merged = new Map<number, Candle>();
          for (const candle of [...(histories.get(sym) ?? []), ...cs]) merged.set(candle.ts, candle);
          const retained = [...merged.values()]
            .filter((candle) => candle.ts >= historySince && candle.confirm === "1")
            .sort((a, b) => a.ts - b.ts);
          histories.set(sym, retained);
          persistCandles(store, sym, trading.timeframe, retained);
          const feats = buildFeatures(sym, [...retained].reverse());
          snaps.push({ instrument: sym, features: feats, regime: classifyRegime(feats) });
        } catch (e) {
          log.warn({ event: "symbol_fetch_failed", instId: sym, error: e instanceof Error ? e.message : String(e) });
        }
      }
      const anchorSnap = snaps.find((s) => s.instrument === anchor) ?? snaps[0];
      const snapshotTs = new Date().toISOString();
      for (const snap of snaps) persistMarketSnapshot(store, snapshotTs, snap.instrument, snap.features);
      if (anchorSnap) lastTick = { features: anchorSnap.features, regime: anchorSnap.regime, at: snapshotTs };
      // 2) deterministic pre-rank (§37 opportunity agent as scanner)
      const rows = baselineMode
        ? scanCoreV2(snaps, histories, v2Params)
        : scanInstruments(snaps, strategies, getWeights(store, "SWING_15M"));
      lastScan = rows;
      for (const row of rows) {
        if (row.candidate) logSystemEvent(store, "STRATEGY_CANDIDATE", {
          engine: "SWING_15M", instrument: row.instrument, strategy: row.candidate.strategy,
          side: row.candidate.side, setupScore: row.candidate.setupScore, conditions: row.candidate.conditions,
        });
        else if (row.conditions?.length) logSystemEvent(store, "STRATEGY_REJECTED", {
          engine: "SWING_15M", instrument: row.instrument,
          evaluations: row.conditions.map((e) => ({ strategy: e.strategy, failed: e.conditions.filter((c) => !c.passed).map((c) => c.name) })),
        });
      }

      // 3) monitor every symbol holding an open position (SL/TP/AI-CLOSE)
      const openRows = getOpenTrades(store) as Array<Record<string, unknown>>;
      const openSyms = [...new Set(openRows.map((t) => String(t.instrument)))];
      const swingOpenRows = openRows.filter((t) => isTradeOwnedBy(t, "SWING_15M"));
      lastKill = null;
      for (const sym of [...new Set(swingOpenRows.map((t) => String(t.instrument)))]) {
        const snap = snaps.find((s) => s.instrument === sym);
        const meta = instruments[sym];
        if (snap && meta) { lastKill = (await runTick(deps, ctxFor(sym, snap.features, snap.regime, strategies), { instId: sym, meta })).kill ?? lastKill; }
      }
      // 4) entry hunt continues while slots remain (§23 max_concurrent, 1/symbol)
      const entryCandidate = pickEntry(rows.filter((rw) => !openSyms.includes(rw.instrument)));
      if (entryCandidate) logSystemEvent(store, "CANDIDATE_SELECTED", {
        engine: "SWING_15M", instrument: entryCandidate.instrument, strategy: entryCandidate.strategy,
        score: entryCandidate.candidate?.setupScore ?? Math.abs(entryCandidate.score),
      });
      if (openSyms.length < risk.hard_limits.max_concurrent_positions) {
        const target = entryCandidate ? snaps.find((s) => s.instrument === entryCandidate.instrument) : (openSyms.length === 0 ? anchorSnap : null);
        if (target && instruments[target.instrument]) {
          const ctx = ctxFor(target.instrument, target.features, target.regime, strategies, entryCandidate?.candidate ?? undefined);
          if (!entryCandidate && openSyms.length === 0) ctx.decideFn = async (): Promise<Decision> => holdBecause("scanner: no tradable setup on watchlist (LLM skipped to save budget)");
          lastKill = (await runTick(deps, ctx, { instId: target.instrument, meta: instruments[target.instrument]! })).kill ?? lastKill;
        }
      }
      // after tick: any newly-closed trades get reviewed (M4)
      const closed = store.db.prepare("SELECT trade_id FROM trades WHERE status='CLOSED' AND trade_id NOT IN (SELECT trade_id FROM trade_reviews) ORDER BY exit_ts DESC LIMIT 3").all() as Array<{ trade_id: string }>;
      for (const c of closed) await reviewTrade(REPO_ROOT, llmReview, store, c.trade_id).catch(() => undefined);
    } catch (e) {
      log.error({ event: "tick_error", error: e instanceof Error ? e.message : String(e) });
      logSystemEvent(store, "ERROR", { tick: e instanceof Error ? e.message : String(e) });
    } finally { ticking = false; }
  };

  // §99 intrabar protection sweep — deterministic ticker check every 60s
  // (exchange-native algo = Layer A is primary; this is a fast Layer B).
  const intrabar = setInterval(async () => {
    try {
      const poss = (await getPositions(deps.client)).filter((p) => p.pos !== "0");
      const local = (getOpenTrades(store) as Array<Record<string, unknown>>)
        .filter((t) => isTradeOwnedBy(t, "SWING_15M"));
      if (poss.length === 0 || local.length === 0) return;
      for (const pos of poss) {
        const t = local.find((x) => String(x.instrument) === pos.instId && String(x.side).toLowerCase() === pos.posSide);
        if (!t) continue;
        const meta = instruments[pos.instId];
        if (!meta) continue;
        const slPlus = await updateTradeStopPlus(client, store, t, pos, meta, trading.position_management.sl_plus);
        const freshTrade = store.db.prepare("SELECT * FROM trades WHERE trade_id=? AND status='OPEN'").get(String(t.trade_id)) as Record<string, unknown> | undefined;
        if (!freshTrade) continue;
        const activeTrade = { ...freshTrade, stop_px: slPlus.stopPx };
        const trig = priceTrigger(activeTrade, Number(pos.markPx));
        if (trig) {
          log.warn({ event: "intrabar_trigger", tradeId: String(t.trade_id), instId: pos.instId, reason: trig });
          await closeTradeOnExchange(deps, activeTrade, pos, trig);
        }
      }
    } catch (e) {
      log.warn({ event: "intrabar_error", error: e instanceof Error ? e.message : String(e) });
    }
  }, 60_000);

  const sched = new CandleCloseScheduler(msForBar(trading.timeframe), tick);
  sched.start();
  await tick(); // immediate first evaluation with warm-up data

  // 5m hybrid scalp engine (user mode choice 2026-10-05): deterministic signals
  // on 1m closes, LLM supervisor (stance) + LLM gate (per-setup veto), fail-closed.
  let scalpRunner: ScalpRunner | undefined;
  if (trading.scalp?.enabled && !baselineMode) {
    const sc = trading.scalp;
    const scalpCfg: ScalpCfg = { ...sc, watchlist };
    scalpRunner = new ScalpRunner({
      client, trading, risk, store, instruments, cfg: scalpCfg,
      llm: () => { refreshLlm(); return { ...llm, timeoutMs: 60_000 }; },
    });
    scalpRunner.start();
  }

  process.on("SIGINT", () => {
    log.warn({ event: "sigint_emergency_stop" });
    void emergencyStop(deps).finally(() => { sched.stop(); clearInterval(intrabar); scalpRunner?.stop(); store.close(); process.exit(0); });
  });
}

if (import.meta.url === `file://${process.argv[1] ?? ""}` || process.argv[1]?.endsWith("main.ts")) {
  main().catch((e) => { console.error("FATAL:", e instanceof Error ? e.message : e); process.exit(1); });
}
export { main };
