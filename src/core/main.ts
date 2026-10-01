// EvoQuant bot entrypoint — §43 startup, §42 candle loop, §45 recovery.
// DEMO ONLY: refuses to run unless OKX_ENV=demo (§44, enforced in config+client).
import { loadRepoEnv, REPO_ROOT } from "./env.ts";
import { assertDemo, loadRiskConfig, loadTradingConfig } from "./config.ts";
import { openStore, logSystemEvent } from "../memory/db.ts";
import { createDemoExchange } from "../exchange/okx/index.ts";
import { getCandles, latestClosedCandle } from "../exchange/okx/market.ts";
import { buildFeatures } from "../market/features.ts";
import { classifyRegime } from "../market/regime.ts";
import { loadStrategies, saveStrategy } from "../strategy/library.ts";
import { startupSafetySequence, runTick, emergencyStop, getLastKillReason, persistCandles, priceTrigger } from "../execution/executor.ts";
import { closeTradeOnExchange } from "../execution/executor.ts";
import { getPositions } from "../exchange/okx/account.ts";
import { getOpenTrades } from "../memory/trades.ts";
import { CandleCloseScheduler, msForBar } from "./scheduler.ts";
import { getBotState, setBotState } from "./state.ts";
import { decide, type Decision } from "../agents/decision-agent.ts";
import { reviewTrade } from "../agents/reviewer-agent.ts";
import { maybeEvolveStrategies } from "../agents/evolution-agent.ts";
import { maybeEvolveWeights } from "../learning/signal-weights.ts";
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
  const meta = await import("../exchange/okx/market.ts").then((m) => m.getInstruments(client, "SWAP", trading.instrument.id));
  const inst = meta[0];
  if (!inst) throw new Error("instrument metadata missing (§43)");
  const deps = { client, trading, risk, store, instrument: inst };

  // history backfill for features/backtests (persisted in memory/candles table? kept in-memory + re-fetch on start)
  let history = (await getCandles(client, trading.instrument.id, trading.timeframe, 300)).filter((c) => c.confirm === "1").sort((a, b) => a.ts - b.ts);

  if (!(await startupSafetySequence(deps))) {
    setBotState(store, "ERROR");
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
  const dash = startDashboard({
    port: Number(env.DASHBOARD_PORT ?? 8790),
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
  });

  const tick = async (): Promise<void> => {
    try {
      refreshLlm();
      const fresh = await getCandles(client, trading.instrument.id, trading.timeframe, 300);
      history = fresh.filter((c) => c.confirm === "1").sort((a, b) => a.ts - b.ts);
      const f = buildFeatures(trading.instrument.id, [...history].reverse());
      const regime = classifyRegime(f);
      lastTick = { features: f, regime, at: new Date().toISOString() };
      persistCandles(store, trading.instrument.id, trading.timeframe, history);
      const strategies = loadStrategies(store);
      const decideFn = async (feat: typeof f, reg: typeof regime, hasPos: boolean): Promise<Decision> => {
        const d = await decide(REPO_ROOT, llm, trading.instrument.id, trading.timeframe, feat, reg, strategies, hasPos, store);
        return d;
      };
      const kt = await runTick(deps, {
        features: f, regime, strategies, decideFn,
        reviewFn: async (id) => { await reviewTrade(REPO_ROOT, llmReview, store, id); },
        evolveFns: {
          weights: async () => { await maybeEvolveWeights(store, evolution.signal_evolution_interval_trades, evolution.constraints.max_weight_change_per_cycle_pct); },
          calibration: () => { recomputeCalibration(store); },
          strategies: async () => {
            await maybeEvolveStrategies(REPO_ROOT, llmEvolve, store, evolution.strategy_evolution_interval_trades, evolution.constraints.max_param_changes_per_challenger, evolution.minimum_validation_sample);
          },
          promote: () => { compareAndMaybePromote(store, history, trading.timeframe); },
        },
      });
      lastKill = kt.kill;
      // after tick: any newly-closed trades get reviewed (M4)
      const closed = store.db.prepare("SELECT trade_id FROM trades WHERE status='CLOSED' AND trade_id NOT IN (SELECT trade_id FROM trade_reviews) ORDER BY exit_ts DESC LIMIT 3").all() as Array<{ trade_id: string }>;
      for (const c of closed) await reviewTrade(REPO_ROOT, llmReview, store, c.trade_id).catch(() => undefined);
    } catch (e) {
      log.error({ event: "tick_error", error: e instanceof Error ? e.message : String(e) });
      logSystemEvent(store, "ERROR", { tick: e instanceof Error ? e.message : String(e) });
    }
  };

  // §99 intrabar protection sweep — deterministic ticker check every 60s
  // (exchange-native algo = Layer A is primary; this is a fast Layer B).
  const intrabar = setInterval(async () => {
    try {
      const { getTicker } = await import("../exchange/okx/market.ts");
      const poss = (await getPositions(deps.client, trading.instrument.id)).filter((p) => p.pos !== "0");
      const local = getOpenTrades(store) as Array<Record<string, unknown>>;
      if (poss.length === 0 || local.length === 0) return;
      const t = local[0]!;
      const trig = priceTrigger(t, Number(poss[0]!.markPx));
      if (trig) {
        const px = (await getTicker(deps.client, trading.instrument.id)).last;
        const trig2 = priceTrigger(t, px) ?? "SL";
        log.warn({ event: "intrabar_trigger", tradeId: String(t.trade_id), reason: trig2 });
        await closeTradeOnExchange(deps, t, poss[0]!, trig2);
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
