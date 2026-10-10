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
import { loadStrategies, type StrategyDef } from "../strategy/library.ts";
import { scanInstruments, scanCoreV2, pickEntry, type ScanRow } from "../strategy/scanner.ts";
import { type TradeCandidate, parseStrategyV2Params, type StrategyV2Id, type StrategyV2Params } from "../strategy/core-v2.ts";
import { ensureV2Registry, getV2ChampionParams, getV2ChampionVersions, getV2Champions } from "../strategy/v2-registry.ts";
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
import { finalizePendingEvidence, reviewerEligibleTradeIds } from "../evidence/finalizer.ts";
import { maybeEvolveStrategies } from "../agents/evolution-agent.ts";
import { maybeEvolveV2Strategies } from "../agents/v2-evolution.ts";
import { getWeights, maybeEvolveWeights, type SignalWeights } from "../learning/signal-weights.ts";
import { recomputeCalibration } from "../learning/confidence.ts";
import { compareAndMaybePromote } from "../evaluation/champion-challenger.ts";
import { DEFAULT_V2_COSTS } from "../evaluation/backtest.ts";
import { processShadowCycle } from "../evaluation/shadow-challenger.ts";
import { evaluateV2Lifecycle } from "../evaluation/v2-promotion.ts";
import { familyForV2 } from "../strategy/identity.ts";
import { parseEvolutionConfig } from "./evolution-config.ts";
import { resolveRuntimePolicy } from "./runtime-policy.ts";
import { RuntimeRiskService } from "./runtime-risk.ts";
import { RuntimeTradingService } from "./runtime-trading.ts";
import { runOncePerGlobalCycle } from "./global-cycle.ts";
import { RoleLlmService } from "./llm-role-service.ts";
import { createLogger } from "./logger.ts";
import { startDashboard } from "./dashboard.ts";
import { CORE_WATCHLIST, DynamicWatchlistService } from "../market/dynamic-watchlist.ts";
import { recordScanState, recordSwingScanResults } from "../market/scan-state.ts";
import YAML from "yaml";
import { readFileSync } from "node:fs";
import path from "node:path";

const log = createLogger("main");
const env = loadRepoEnv(REPO_ROOT);

/** Stable Core-only input for historical/OOS/rolling V2 validation. */
export function validationHistoriesFromTrading(histories: ReadonlyMap<string, Candle[]>): Map<string, Candle[]> {
  return new Map([...histories].filter(([symbol]) => CORE_WATCHLIST.includes(symbol as typeof CORE_WATCHLIST[number])));
}

async function main(): Promise<void> {
  assertDemo(env); // §44
  const trading = loadTradingConfig();
  const baselineMode = trading.validation.baseline_mode;
  const configuredRisk = loadRiskConfig();
  const evolution = parseEvolutionConfig(YAML.parse(readFileSync(path.join(REPO_ROOT, "config/evolution.yaml"), "utf8")));
  const runtimePolicy = resolveRuntimePolicy({ strategyCoreVersion: trading.strategy_core.version, baselineMode,
    evolutionConfiguredEnabled: evolution.enabled, scalpConfiguredEnabled: trading.scalp?.enabled ?? false,
    configuredMaxPositions: configuredRisk.hard_limits.max_concurrent_positions });
  const strategyCoreVersion = runtimePolicy.strategyCoreVersion;
  const risk = { ...configuredRisk, hard_limits: { ...configuredRisk.hard_limits,
    max_concurrent_positions: runtimePolicy.maxConcurrentPositions } };
  const configuredV2Params = parseStrategyV2Params(YAML.parse(readFileSync(path.join(REPO_ROOT, "config/strategy-v2.yaml"), "utf8")));
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
  const runtimeRisk = new RuntimeRiskService({ store, risk, baselineMode });
  const llmRoles = new RoleLlmService({ root: REPO_ROOT, store });
  if (strategyCoreVersion === 2) ensureV2Registry(store, configuredV2Params);
  const { client } = createDemoExchange(env);
  const dynamicWatchlist = new DynamicWatchlistService({ store, client, config: trading.dynamic_watchlist,
    core: trading.instruments?.watchlist ?? [trading.instrument.id] });
  await dynamicWatchlist.initialize();
  const workflowSymbols = () => (store.db.prepare(`SELECT DISTINCT instrument FROM trades
    WHERE status IN ('OPEN','RECONCILIATION_PENDING') OR (status='CLOSED' AND evidence_state='EVIDENCE_PENDING')`).all() as Array<{ instrument: string }>).map((row) => row.instrument);
  dynamicWatchlist.setManagementSymbols(workflowSymbols());
  await dynamicWatchlist.hydrateManagementMetadata(workflowSymbols());
  const instruments: Record<string, InstrumentInfo> = {};
  dynamicWatchlist.syncCatalog(instruments);
  const watchlist = dynamicWatchlist.currentActiveUniverse((getOpenTrades(store) as Array<Record<string, unknown>>).map((t) => String(t.instrument)));
  dynamicWatchlist.applyRiskAllowlist(risk.hard_limits.allowed_symbols);
  if (watchlist.length === 0) throw new Error("no watchlist instruments have metadata (§43)");
  const runtimeTrading = new RuntimeTradingService({ store, trading, risk, instruments: dynamicWatchlist.currentEntryUniverse() });
  const deps = { client, trading, risk, store, instruments, watchlist };
  const syncDynamicUniverse = () => {
    dynamicWatchlist.setManagementSymbols(workflowSymbols());
    dynamicWatchlist.syncCatalog(instruments);
    dynamicWatchlist.applyRiskAllowlist(risk.hard_limits.allowed_symbols);
    runtimeTrading.setInstruments(dynamicWatchlist.currentEntryUniverse());
    watchlist.splice(0, watchlist.length, ...dynamicWatchlist.currentManagementUniverse());
  };
  if (!runtimePolicy.evolutionEnabled) {
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
  // An exchange position can outlive the daily entry selection. Restore exact
  // metadata before any monitoring, reconciliation, or accounting path runs.
  const exchangeManagement = (await getPositions(client)).filter((position) => position.pos !== "0").map((position) => position.instId);
  dynamicWatchlist.setManagementSymbols([...workflowSymbols(), ...exchangeManagement]);
  await dynamicWatchlist.hydrateManagementMetadata(dynamicWatchlist.currentManagementUniverse());
  syncDynamicUniverse();
  loadStrategies(store);
  setBotState(store, "RUNNING");
  log.info({ event: "bot_started", state: getBotState(store) });

  let lastTick: { features: unknown; regime: string; at: string } | null = null;
  let lastKill: string | null = null;
  let lastScan: ScanRow[] = [];
  const dash = startDashboard({
    port: Number(env.DASHBOARD_PORT ?? 8790),
    ...(env.DASHBOARD_BIND ? { bind: env.DASHBOARD_BIND } : {}),
    ...(env.DASHBOARD_USER ? { auth: { user: env.DASHBOARD_USER, password: env[["DASHBOARD","PASSWORD"].join("_")] ?? "" } } : {}),
    trading, risk, runtimeRisk, runtimeTrading, strategyCoreVersion, baselineMode, deps: () => deps,
    evolution: {
      enabled: runtimePolicy.evolutionEnabled,
      automaticPromotion: evolution.automatic_promotion_enabled,
      shadowMinimum: evolution.promotion.shadow_forward_min_trades,
      championShadowMinimum: evolution.promotion.champion_shadow_min_trades,
      reviewEvery: evolution.review_every_closed_trade,
      signalInterval: evolution.signal_evolution_interval_trades,
      strategyInterval: evolution.strategy_evolution_interval_trades,
      minSample: evolution.minimum_validation_sample,
      maxWeightChangePct: evolution.constraints.max_weight_change_per_cycle_pct,
      maxParamChanges: evolution.constraints.max_param_changes_per_challenger,
    },
    getLastTick: () => lastTick,
    getKillReason: () => getLastKillReason(),
    getScan: () => lastScan,
    llmRoles,
    dynamicWatchlist: { projection: () => dynamicWatchlist.projection(), refreshManual: async () => {
      const result = await dynamicWatchlist.refreshManual(); syncDynamicUniverse(); return result;
    } },
  });

  const ctxFor = (instId2: string, features: FeatureSnapshot, regime: Regime, strategies: StrategyDef[], candidate?: TradeCandidate) => ({
    features, regime, strategies,
    ...(candidate ? { candidate, gateCandidateFn: (c: TradeCandidate) => gateCandidate(REPO_ROOT, llmRoles, c) } : {}),
    decideFn: async (feat: FeatureSnapshot, reg: Regime, hasPos: boolean): Promise<Decision> =>
      strategyCoreVersion === 2 ? holdBecause("Strategy Core V2: deterministic exit policy; AI CLOSE disabled")
        : decide(REPO_ROOT, llmRoles, instId2, trading.timeframe, feat, reg, strategies, hasPos, store),
  });

  const reviewsInFlight = new Set<string>();
  let ticking = false;
  const tick = async (): Promise<void> => {
    if (ticking) { log.info({ event: "tick_skipped_overlapping" }); return; } // mutex: 15m ticks can overrun while LLM is slow
    ticking = true;
    try {
      const strategies = loadStrategies(store);
      const activeV2Params = strategyCoreVersion === 2 ? getV2ChampionParams(store) : configuredV2Params;
      const activeV2Versions = strategyCoreVersion === 2 ? getV2ChampionVersions(store) : {
        TREND_FOLLOWING_V2: 2, BREAKOUT_V2: 2, MEAN_REVERSION_V2: 2,
      };
      // 1) refresh all watchlist candles + snapshots (§17 pipeline)
      const snaps: Array<{ instrument: string; features: FeatureSnapshot; regime: Regime }> = [];
      const entrySymbols = new Set(dynamicWatchlist.currentEntryUniverse());
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
          if (entrySymbols.has(sym)) recordScanState(store, {
            engine: "SWING_15M", instrument: sym, scannedAt: new Date().toISOString(),
            result: "FETCH_FAILED", reason: "market_data_fetch_failed",
          });
        }
      }
      const anchorSnap = snaps.find((s) => s.instrument === trading.instrument.id) ?? snaps[0];
      const snapshotTs = new Date().toISOString();
      for (const snap of snaps) persistMarketSnapshot(store, snapshotTs, snap.instrument, snap.features);
      if (anchorSnap) lastTick = { features: anchorSnap.features, regime: anchorSnap.regime, at: snapshotTs };
      // 2) deterministic pre-rank (§37 opportunity agent as scanner)
      const entrySnaps = snaps.filter((snap) => entrySymbols.has(snap.instrument));
      const rows = strategyCoreVersion === 2
        ? scanCoreV2(entrySnaps, histories, activeV2Params, activeV2Versions, v2Weights(store, activeV2Versions), trading.strategy_core.enabled_families)
        : scanInstruments(entrySnaps, trading.strategies_enabled
          ? strategies.filter((strategy) => trading.strategies_enabled!.includes(`${strategy.name}_V${strategy.version}`))
          : strategies, getWeights(store, "SWING_15M", { strategyCoreVersion: 1 }));
      recordSwingScanResults(store, rows, new Map(entrySnaps.map((snap) => [snap.instrument, snap.features.ts])), undefined, trading.timeframe);
      lastScan = rows;
      for (const row of rows) {
        if (row.candidate) logSystemEvent(store, "STRATEGY_CANDIDATE", {
          engine: "SWING_15M", instrument: row.instrument, strategy: row.candidate.strategy,
          side: row.candidate.side, setupScore: row.candidate.setupScore, conditions: row.candidate.conditions,
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
      // Resolve delayed exchange accounting and confirmed-candle coverage before
      // an LLM ever sees the trade as learning evidence.
      await finalizePendingEvidence({ client, store, instruments, trading });
      // after tick: only deterministically final evidence gets reviewed (M4)
      const closed = reviewerEligibleTradeIds(store);
      if (evolution.review_every_closed_trade) {
        for (const tradeId of closed) {
          if (reviewsInFlight.has(tradeId)) continue;
          reviewsInFlight.add(tradeId);
          void reviewTrade(REPO_ROOT, llmRoles, store, tradeId).catch(() => {
            log.warn({ event: "review_deferred", tradeId });
          }).finally(() => reviewsInFlight.delete(tradeId));
        }
      }

      // One system-wide learning/evolution lifecycle per completed global market cycle.
      if (runtimePolicy.evolutionEnabled && snaps.length > 0) {
        const globalCycleTs = Math.min(...snaps.map((snap) => snap.features.ts));
        await runOncePerGlobalCycle(store, trading.timeframe, globalCycleTs, async () => {
        if (evolution.signal_learning_enabled) {
          if (strategyCoreVersion === 2) {
            const book = getV2Champions(store);
            for (const id of Object.keys(book) as StrategyV2Id[]) {
              maybeEvolveWeights(store, evolution.signal_evolution_interval_trades,
                evolution.constraints.max_weight_change_per_cycle_pct, "SWING_15M", evolution.minimum_validation_sample,
                { strategy: familyForV2(id), strategyCoreVersion: 2, strategyVersion: book[id].version });
            }
          } else {
            maybeEvolveWeights(store, evolution.signal_evolution_interval_trades,
              evolution.constraints.max_weight_change_per_cycle_pct, "SWING_15M", evolution.minimum_validation_sample,
              { strategyCoreVersion: 1 });
          }
        }
        if (strategyCoreVersion === 2) {
          recomputeCalibration(store, "SWING_15M", { strategyCoreVersion: 2 });
          for (const family of trading.strategy_core.enabled_families) recomputeCalibration(store, "SWING_15M",
            { strategyCoreVersion: 2, strategy: family });
        } else recomputeCalibration(store, "SWING_15M", { strategyCoreVersion: 1 });
        if (evolution.strategy_evolution_enabled) {
          if (strategyCoreVersion === 2) {
            await maybeEvolveV2Strategies(REPO_ROOT, llmRoles, store, {
              intervalTrades: evolution.strategy_evolution_interval_trades,
              minimumSample: evolution.minimum_validation_sample,
              maxParamChanges: evolution.constraints.max_param_changes_per_challenger,
              maxParamDeltaPct: evolution.constraints.max_param_delta_pct_per_challenger,
            });
          } else {
            await maybeEvolveStrategies(REPO_ROOT, llmRoles, store,
              evolution.strategy_evolution_interval_trades, evolution.constraints.max_param_changes_per_challenger,
              evolution.minimum_validation_sample, "SWING_15M");
          }
        }
        if (strategyCoreVersion === 2) {
          // Historical, OOS, and rolling comparisons use only the stable Core
          // universe. Dynamic instruments remain part of live scan/shadow and
          // valid forward Demo evidence, but cannot shorten this window.
          const validationHistories = validationHistoriesFromTrading(histories);
          const tickSizes = new Map([...validationHistories.keys()].map((symbol) => [symbol, Number(instruments[symbol]?.tickSz)]));
          processShadowCycle(store, snaps.map((snapshot) => ({ ...snapshot, tickSize: Number(instruments[snapshot.instrument]?.tickSz) })),
            histories, trading.timeframe, backtestCosts);
          evaluateV2Lifecycle(store, validationHistories, trading.timeframe, backtestCosts, {
            historicalMinTrades: evolution.promotion.historical_min_trades,
            outOfSampleMinTrades: evolution.promotion.out_of_sample_min_trades,
            shadowForwardMinTrades: evolution.promotion.shadow_forward_min_trades,
            championShadowMinTrades: evolution.promotion.champion_shadow_min_trades,
            outOfSampleFraction: evolution.promotion.out_of_sample_fraction,
            minimumSymbols: evolution.promotion.minimum_symbols,
            minPositiveSymbolFraction: evolution.promotion.min_positive_symbol_fraction,
            minPositiveWalkForwardFraction: evolution.promotion.min_positive_walk_forward_fraction,
            minimumWalkForwardFolds: evolution.promotion.minimum_walk_forward_folds,
            maxDrawdownDegradationPct: evolution.promotion.max_drawdown_degradation_pct,
            requireOutOfSample: evolution.promotion.require_out_of_sample,
            requireWalkForward: evolution.promotion.require_walk_forward,
            requireMultiSymbol: evolution.promotion.require_multi_symbol,
            automaticPromotionEnabled: evolution.automatic_promotion_enabled,
          }, tickSizes);
        } else if (evolution.automatic_promotion_enabled) {
          compareAndMaybePromote(store, validationHistoriesFromTrading(histories), trading.timeframe, {
            minSampleEachSide: Math.max(evolution.minimum_validation_sample, evolution.constraints.champion_vs_challenger.min_sample_each_side),
            requireOutOfSample: evolution.constraints.champion_vs_challenger.requires_out_of_sample,
            requireWalkForward: evolution.constraints.champion_vs_challenger.requires_walk_forward,
            wfMinPositiveFolds: evolution.constraints.champion_vs_challenger.min_positive_walk_forward_folds,
            minPositiveSymbols: evolution.constraints.champion_vs_challenger.min_positive_symbols,
            requireDrawdownNonWorse: true,
          }, backtestCosts);
        }
        });
      }
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

  let finalizerRunning = false;
  const evidenceFinalizer = setInterval(() => {
    if (finalizerRunning) return;
    finalizerRunning = true;
    void finalizePendingEvidence({ client, store, instruments, trading }).catch((error) => {
      log.warn({ event: "evidence_finalizer_error", error: error instanceof Error ? error.message : String(error) });
    }).finally(() => { finalizerRunning = false; });
  }, 60_000);

  const sched = new CandleCloseScheduler(msForBar(trading.timeframe), tick);
  sched.start();
  await tick(); // immediate first evaluation with warm-up data

  let dynamicRefreshTimer: NodeJS.Timeout | undefined;
  const scheduleDynamicRefresh = () => {
    const next = Date.parse(dynamicWatchlist.projection().next_refresh);
    dynamicRefreshTimer = setTimeout(() => {
      void dynamicWatchlist.refreshIfDue().then(syncDynamicUniverse).finally(scheduleDynamicRefresh);
    }, Math.max(1_000, next - Date.now()));
  };
  scheduleDynamicRefresh();

  // 5m hybrid scalp engine (user mode choice 2026-10-05): deterministic signals
  // on 1m closes, LLM supervisor (stance) + LLM gate (per-setup veto), fail-closed.
  let scalpRunner: ScalpRunner | undefined;
  if (runtimePolicy.scalpEnabled && trading.scalp?.enabled) {
    const sc = trading.scalp;
    const scalpCfg: ScalpCfg = { ...sc, watchlist };
    scalpRunner = new ScalpRunner({
      client, trading, risk, store, instruments, cfg: scalpCfg,
      llm: llmRoles,
      entryUniverse: () => dynamicWatchlist.currentEntryUniverse(),
    });
    scalpRunner.start();
  }

  process.on("SIGINT", () => {
    log.warn({ event: "sigint_emergency_stop" });
    void emergencyStop(deps).finally(() => { sched.stop(); clearInterval(intrabar); clearInterval(evidenceFinalizer); if (dynamicRefreshTimer) clearTimeout(dynamicRefreshTimer); scalpRunner?.stop(); store.close(); process.exit(0); });
  });
}

function v2Weights(store: import("../memory/db.ts").Store, versions: Record<StrategyV2Id, number>): Partial<Record<StrategyV2Id, SignalWeights>> {
  return {
    TREND_FOLLOWING_V2: getWeights(store, "SWING_15M", { strategy: familyForV2("TREND_FOLLOWING_V2"), strategyCoreVersion: 2, strategyVersion: versions.TREND_FOLLOWING_V2 }),
    BREAKOUT_V2: getWeights(store, "SWING_15M", { strategy: familyForV2("BREAKOUT_V2"), strategyCoreVersion: 2, strategyVersion: versions.BREAKOUT_V2 }),
    MEAN_REVERSION_V2: getWeights(store, "SWING_15M", { strategy: familyForV2("MEAN_REVERSION_V2"), strategyCoreVersion: 2, strategyVersion: versions.MEAN_REVERSION_V2 }),
  };
}

if (import.meta.url === `file://${process.argv[1] ?? ""}` || process.argv[1]?.endsWith("main.ts")) {
  main().catch((e) => { console.error("FATAL:", e instanceof Error ? e.message : e); process.exit(1); });
}
export { main };
