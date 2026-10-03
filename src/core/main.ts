// EvoQuant bot entrypoint — §43 startup, §42 candle loop, §45 recovery.
// DEMO ONLY: refuses to run unless OKX_ENV=demo (§44, enforced in config+client).
import { loadRepoEnv, REPO_ROOT } from "./env.ts";
import { assertDemo, loadRiskConfig, loadTradingConfig } from "./config.ts";
import { openStore, logSystemEvent, persistMarketSnapshot } from "../memory/db.ts";
import { createDemoExchange } from "../exchange/okx/index.ts";
import { getCandles, latestClosedCandle, getTicker } from "../exchange/okx/market.ts";
import type { Candle, InstrumentInfo } from "../exchange/okx/types.ts";
import { buildFeatures, type FeatureSnapshot } from "../market/features.ts";
import { classifyRegime, type Regime } from "../market/regime.ts";
import { loadStrategies, saveStrategy, type StrategyDef } from "../strategy/library.ts";
import { scanInstruments, pickEntry, type ScanRow } from "../strategy/scanner.ts";
import { startupSafetySequence, runTick, emergencyStop, getLastKillReason, persistCandles, priceTrigger } from "../execution/executor.ts";
import { closeTradeOnExchange } from "../execution/executor.ts";
import { getPositions } from "../exchange/okx/account.ts";
import { getOpenTrades } from "../memory/trades.ts";
import { CandleCloseScheduler, msForBar } from "./scheduler.ts";
import { getBotState, setBotState } from "./state.ts";
import { decide, holdBecause, type Decision } from "../agents/decision-agent.ts";
import { reviewTrade } from "../agents/reviewer-agent.ts";
import { maybeEvolveStrategies } from "../agents/evolution-agent.ts";
import { getWeights, maybeEvolveWeights } from "../learning/signal-weights.ts";
import { recomputeCalibration } from "../learning/confidence.ts";
import { compareAndMaybePromote } from "../evaluation/champion-challenger.ts";
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
  const risk = loadRiskConfig();
  const evolution = YAML.parse(readFileSync(path.join(REPO_ROOT, "config/evolution.yaml"), "utf8")) as {
    signal_evolution_interval_trades: number; strategy_evolution_interval_trades: number;
    minimum_validation_sample: number; constraints: { max_weight_change_per_cycle_pct: number; max_param_changes_per_challenger: number };
  };

  const store = openStore(REPO_ROOT);
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

  // per-symbol history for features/backtests
  const histories = new Map<string, Candle[]>();
  for (const sym of watchlist) {
    const cs = (await getCandles(client, sym, trading.timeframe, 300)).filter((c) => c.confirm === "1").sort((a, b) => a.ts - b.ts);
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

  const ctxFor = (instId2: string, features: FeatureSnapshot, regime: Regime, strategies: StrategyDef[]) => ({
    features, regime, strategies,
    decideFn: async (feat: FeatureSnapshot, reg: Regime, hasPos: boolean): Promise<Decision> =>
      decide(REPO_ROOT, llm, instId2, trading.timeframe, feat, reg, strategies, hasPos, store),
    reviewFn: async (id: string) => { await reviewTrade(REPO_ROOT, llmReview, store, id); },
    evolveFns: {
      weights: async () => { await maybeEvolveWeights(store, evolution.signal_evolution_interval_trades, evolution.constraints.max_weight_change_per_cycle_pct); },
      calibration: () => { recomputeCalibration(store); },
      strategies: async () => {
        await maybeEvolveStrategies(REPO_ROOT, llmEvolve, store, evolution.strategy_evolution_interval_trades, evolution.constraints.max_param_changes_per_challenger, evolution.minimum_validation_sample);
      },
      promote: () => { compareAndMaybePromote(store, histories.get(anchor) ?? [], trading.timeframe); },
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
          histories.set(sym, cs);
          persistCandles(store, sym, trading.timeframe, cs);
          const feats = buildFeatures(sym, [...cs].reverse());
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
      const rows = scanInstruments(snaps, strategies, getWeights(store));
      lastScan = rows;

      // 3) monitor every symbol holding an open position (SL/TP/AI-CLOSE)
      const openRows = getOpenTrades(store) as Array<Record<string, unknown>>;
      const openSyms = [...new Set(openRows.map((t) => String(t.instrument)))];
      lastKill = null;
      for (const sym of openSyms) {
        const snap = snaps.find((s) => s.instrument === sym);
        const meta = instruments[sym];
        if (snap && meta) { lastKill = (await runTick(deps, ctxFor(sym, snap.features, snap.regime, strategies), { instId: sym, meta })).kill ?? lastKill; }
      }
      // 4) entry hunt continues while slots remain (§23 max_concurrent, 1/symbol)
      const entryCandidate = pickEntry(rows.filter((rw) => !openSyms.includes(rw.instrument)));
      if (openSyms.length < risk.hard_limits.max_concurrent_positions) {
        const target = entryCandidate ? snaps.find((s) => s.instrument === entryCandidate.instrument) : (openSyms.length === 0 ? anchorSnap : null);
        if (target && instruments[target.instrument]) {
          const ctx = ctxFor(target.instrument, target.features, target.regime, strategies);
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
      const local = getOpenTrades(store) as Array<Record<string, unknown>>;
      if (poss.length === 0 || local.length === 0) return;
      for (const pos of poss) {
        const t = local.find((x) => String(x.instrument) === pos.instId && String(x.side).toLowerCase() === pos.posSide);
        if (!t) continue;
        const trig = priceTrigger(t, Number(pos.markPx));
        if (trig) {
          log.warn({ event: "intrabar_trigger", tradeId: String(t.trade_id), instId: pos.instId, reason: trig });
          await closeTradeOnExchange(deps, t, pos, trig);
        }
      }
    } catch (e) {
      log.warn({ event: "intrabar_error", error: e instanceof Error ? e.message : String(e) });
    }
  }, 60_000);

  const sched = new CandleCloseScheduler(msForBar(trading.timeframe), tick);
  sched.start();
  await tick(); // immediate first evaluation with warm-up data

  process.on("SIGINT", () => {
    log.warn({ event: "sigint_emergency_stop" });
    void emergencyStop(deps).finally(() => { sched.stop(); clearInterval(intrabar); store.close(); process.exit(0); });
  });
}

if (import.meta.url === `file://${process.argv[1] ?? ""}` || process.argv[1]?.endsWith("main.ts")) {
  main().catch((e) => { console.error("FATAL:", e instanceof Error ? e.message : e); process.exit(1); });
}
export { main };
