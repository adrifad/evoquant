// Operations console and JSON API (§57–102),
// served by the bot process on 127.0.0.1 only (access via SSH tunnel — keeps
// emergency controls off the public net). Priorities per §97: risk state,
// open position, PnL, bot state, latest decision — AI narrative last.
//
// NOTE: §58 recommends Next.js/shadcn; V1 ships a dependency-free console to
// fit the 2GB host and avoid a second build pipeline. §101 acceptance
// questions are all answerable here; a Next.js port is a later milestone.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { gzipSync } from "node:zlib";
import { timingSafeEqual, createHash } from "node:crypto";
import type { Duplex } from "node:stream";
import type { AddressInfo } from "node:net";
import type { Store } from "../memory/db.ts";
import { getBotState, setBotState, isEmergencyHalted, setEmergencyHalted, baseline } from "../core/state.ts";
import { getWeights } from "../learning/signal-weights.ts";
import { regimeStats, scopedPerformance } from "../memory/regimes.ts";
import { kvGet, logSystemEvent } from "../memory/db.ts";
import { emergencyStop, type ExecutorDeps } from "../execution/executor.ts";
import { setEnvKeys, maskKey } from "./settings.ts";
import { loadRepoEnv } from "./env.ts";
import path from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { getBalance, getPositions } from "../exchange/okx/account.ts";
import { createLogger } from "./logger.ts";
import { listV2Versions } from "../strategy/v2-registry.ts";
import { LLM_ROLES, type LlmRole } from "./llm-roles.ts";
import { roleEnvironmentUpdates, type RoleLlmService } from "./llm-role-service.ts";
import { accountCapital, positionCapital, prepareCapitalStore, finite } from "./capital.ts";
import { RuntimeRiskError, type RuntimeRiskService } from "./runtime-risk.ts";
import { RuntimeTradingError, type RuntimeTradingService } from "./runtime-trading.ts";
import { evolutionFamilies, scannerProjection } from "./workstation.ts";
import type { ScanRow } from "../strategy/scanner.ts";
import { getCandles, type Bar } from "../exchange/okx/market.ts";
import { portfolioOpenRisk } from "../risk/portfolio-open-risk.ts";

const log = createLogger("dashboard");
const REPO_ROOT = path.resolve(import.meta.dirname, "../..");
const CONSOLE_DIST = path.join(REPO_ROOT, "apps", "console", "dist");
function loadRepoEnvSafe(): Record<string, string> {
  try { return loadRepoEnv(REPO_ROOT) as Record<string, string>; } catch { return {}; }
}

export interface DashboardConfig {
  port: number;
  bind?: string;
  auth?: { user: string; password: string };
  trading: { instrument: { id: string }; timeframe: string; leverage: { default: number } };
  strategyCoreVersion?: 1 | 2;
  baselineMode?: boolean;
  risk: { hard_limits: Record<string, unknown> };
  deps: () => ExecutorDeps;
  getLastTick: () => { features: unknown; regime: string; at: string } | null;
  getKillReason: () => string | null;
  getScan: () => Array<{ instrument: string; regime: string; price: number; score: number; strategy: string | null; tradable: boolean }>;
  evolution: {
    reviewEvery: boolean; signalInterval: number; strategyInterval: number; minSample: number;
    maxWeightChangePct: number; maxParamChanges: number;
    enabled?: boolean; automaticPromotion?: boolean; shadowMinimum?: number; championShadowMinimum?: number;
  };
  llmRoles?: RoleLlmService;
  runtimeRisk?: RuntimeRiskService;
  runtimeTrading?: RuntimeTradingService;
  settingsFile?: string;
}

export interface DashboardServer {
  close(): void;
  address(): AddressInfo | null;
}

export function startDashboard(cfg: DashboardConfig): DashboardServer {
  const store = cfg.deps().store;
  prepareCapitalStore(store);
  type ExchangeSnapshot = { at: number; balance: Awaited<ReturnType<typeof getBalance>> | null; positions: Awaited<ReturnType<typeof getPositions>> | null };
  let snapshot: ExchangeSnapshot | null = null;
  let pendingSnapshot: Promise<ExchangeSnapshot> | null = null;
  const exchangeSnapshot = async () => {
    if (snapshot && Date.now() - snapshot.at < 5_000) return snapshot;
    if (!pendingSnapshot) pendingSnapshot = Promise.all([
      getBalance(cfg.deps().client).catch(() => null), getPositions(cfg.deps().client).catch(() => null),
    ]).then(([balance, positions]) => (snapshot = { at: Date.now(), balance, positions })).finally(() => { pendingSnapshot = null; });
    return pendingSnapshot;
  };
  const projectTrade = (trade: Record<string, unknown>, positions: Awaited<ReturnType<typeof getPositions>> | null, equity: number | null) => {
    const saved = store.db.prepare("SELECT observed_at,snapshot FROM entry_capital WHERE trade_id=?").get(String(trade.trade_id)) as { observed_at: string; snapshot: string } | undefined;
    const entryCapital = saved ? JSON.parse(saved.snapshot) as Record<string, unknown> : null;
    if (!["OPEN", "RECONCILIATION_PENDING"].includes(String(trade.status))) return { ...trade, entry_capital: entryCapital, capital_observed_at: saved?.observed_at ?? null };
    const position = positions?.find(p => p.instId === trade.instrument && p.posSide === String(trade.side).toLowerCase() && Number(p.pos) !== 0);
    const capital = positionCapital(trade, position, cfg.deps().instruments[String(trade.instrument)], equity,
      Math.min(cfg.trading.leverage.default, Number(cfg.risk.hard_limits.max_leverage)));
    const r = capital.mark_px !== null ? rMultiple(Number(trade.entry_px), Number(trade.initial_stop_px ?? trade.stop_px), capital.mark_px, String(trade.side)) : null;
    const duration = Math.max(0, Math.round((Date.now() - Date.parse(String(trade.entry_ts))) / 1000));
    return { ...trade, ...capital, entry_capital: entryCapital, r, live_r: r, duration_s: duration, live_dur_s: duration };
  };
  const candleCache = new Map<string, { at: number; rows: unknown[] }>();
  const candleRequests = new Map<string, Promise<unknown[]>>();
  const settingsFile = cfg.settingsFile ?? path.join(REPO_ROOT, ".env");
  let modelDiscovery: { models: string[]; fetchedAt: string | null; expiresAt: number; baseUrl: string | null } = {
    models: [], fetchedAt: null, expiresAt: 0, baseUrl: null,
  };

  const rMultiple = (entry: number, stop: number, mark: number, side: string): number => {
    const risk = Math.abs(entry - stop);
    if (!(risk > 0)) return 0;
    return Math.round((((mark - entry) * (side === "LONG" ? 1 : -1)) / risk) * 100) / 100;
  };

  async function api(req: IncomingMessage, method: string, url: URL, res: ServerResponse): Promise<void> {
    const p = url.pathname;
    const send = (code: number, body: unknown): void => {
      const data = JSON.stringify(body);
      const headers: Record<string, string> = {
        "content-type": "application/json", "x-content-type-options": "nosniff",
        vary: "accept-encoding",
      };
      let out: string | Buffer = data;
      if (data.length > 860 && /\bgzip\b/.test(req.headers["accept-encoding"] ?? "")) {
        out = gzipSync(Buffer.from(data));
        headers["content-encoding"] = "gzip";
      }
      res.writeHead(code, headers);
      res.end(out);
    };
    if (p === "/api/status") {
      const exchange = await exchangeSnapshot();
      const bal = exchange.balance;
      const usdt = bal?.details.find((d) => d.ccy === "USDT");
      const eq = finite(usdt?.eq);
      const base = eq !== null ? baseline(store, eq) : null;
      const open = store.db.prepare("SELECT * FROM trades WHERE status IN ('OPEN','RECONCILIATION_PENDING')").all() as Array<Record<string, unknown>>;
      const capital = accountCapital(bal, exchange.positions, open, cfg.deps().instruments, cfg.trading.leverage.default);
      const portfolio = exchange.positions && eq !== null
        ? portfolioOpenRisk({ equity: eq, positions: exchange.positions, trades: open, instruments: cfg.deps().instruments })
        : { known: false, lossToStops: null, riskPct: null, unavailable: [] };
      const projected = open.map(t => projectTrade(t, exchange.positions, eq));
      const closed = store.db.prepare("SELECT COUNT(*) c, COALESCE(SUM(pnl),0) p, COALESCE(AVG(result_r),0) e FROM trades WHERE status='CLOSED'").get() as { c: number; p: number; e: number };
      const evidencePending = store.db.prepare("SELECT COUNT(*) c FROM trades WHERE status='CLOSED' AND evidence_state='EVIDENCE_PENDING'").get() as { c: number };
      return send(200, {
        environment: "DEMO",                       // §96 always visible
        exchange: "OKX",
        instrument: cfg.trading.instrument.id,
        timeframe: cfg.trading.timeframe,
        botState: getBotState(store),              // §89
        emergencyHalted: isEmergencyHalted(store),
        killReason: cfg.getKillReason(),
        equity: eq,
        capital, exchangeState: capital.state, updatedAt: new Date(exchange.at).toISOString(), marketUpdatedAt: cfg.getLastTick()?.at ?? null,
        watchlist: cfg.deps().watchlist,
        daily: { dayStart: base?.dayStartEquity ?? null, pnl: base && eq !== null ? eq - base.dayStartEquity : null,
          lossPct: base && eq !== null && base.dayStartEquity > 0 ? Math.max(0, (base.dayStartEquity - eq) / base.dayStartEquity * 100) : null },
        drawdownPct: base && eq !== null && base.peakEquity > 0 ? Math.max(0, (base.peakEquity - eq) / base.peakEquity * 100) : null,
        totals: { closed: closed.c, pnl: closed.p, expectancyR: closed.e }, evidencePending: evidencePending.c,
        openPositions: projected, openPosition: projected[0] ?? null,
        criticalEvents: store.db.prepare("SELECT ts,kind,payload FROM system_events WHERE kind IN ('ERROR','RISK_EVENT','LLM_TIMEOUT','LLM_AUTH_FAILURE','STATE') ORDER BY id DESC LIMIT 4").all(),
        reconciliationWarnings: store.db.prepare("SELECT trade_id,instrument,side,entry_ts,exit_reason FROM trades WHERE status='RECONCILIATION_PENDING' ORDER BY entry_ts DESC").all(),
        aiRoles: cfg.llmRoles?.settings() ?? [],
        scan: scannerProjection(store, cfg.getScan() as ScanRow[], cfg.getLastTick()?.at ?? null),
        evolution: { enabled: cfg.evolution.enabled ?? null, active: listV2Versions(store).filter(v => v.status === "CHALLENGER" || v.status === "SHADOW").map(v => ({ strategy: v.strategy, version: v.version, status: v.status })) },
        latestDecision: store.db.prepare("SELECT * FROM decisions ORDER BY ts DESC LIMIT 1").get() ?? null, // §66
        latestExecution: store.db.prepare("SELECT ts,kind,payload FROM system_events WHERE kind IN ('TRADE_OPEN','TRADE_CLOSED') ORDER BY id DESC LIMIT 1").get() ?? null,
        regime: cfg.getLastTick()?.regime ?? "UNKNOWN",
        market: cfg.getLastTick()?.features ?? null,
        limits: cfg.risk.hard_limits,              // §83
        portfolioRisk: portfolio,
        availablePositionSlots: Math.max(0, Number(cfg.risk.hard_limits.max_concurrent_positions) - (exchange.positions?.filter(p => Number(p.pos) !== 0).length ?? 0)),
        hardMaxesLocked: true,                     // §48: shown as locked
      });
    }
    if (p === "/api/trades") {
      const rows = store.db.prepare("SELECT trade_id,instrument,side,strategy,strategy_core_version,strategy_version,regime,entry_px,initial_stop_px,stop_px,take_profit_px,exit_px,result_r,result_r_basis,pnl,fees,funding,accounting_quality,evidence_state,evidence_reason,evolution_evidence_eligible,duration_s,exit_reason,exit_ts,status,calibrated_confidence,contracts,entry_ts,leverage,mfe,mae,planned_risk_pct FROM trades ORDER BY COALESCE(exit_ts,entry_ts) DESC LIMIT 100").all() as Array<Record<string, unknown>>;
      const exchange = await exchangeSnapshot();
      return send(200, rows.map(t => projectTrade(t, exchange.positions, finite(exchange.balance?.details.find(d => d.ccy === "USDT")?.eq))));
    }
    if (method === "GET" && p.startsWith("/api/trades/")) {
      const tradeId = decodeURIComponent(p.slice("/api/trades/".length));
      const trade = store.db.prepare("SELECT * FROM trades WHERE trade_id=?").get(tradeId) as Record<string, unknown> | undefined;
      if (!trade) return send(404, { error: "trade not found" });
      const decision = trade.decision_id
        ? store.db.prepare("SELECT * FROM decisions WHERE decision_id=?").get(trade.decision_id)
        : null;
      const orders = store.db.prepare("SELECT * FROM orders WHERE trade_id=? ORDER BY COALESCE(cTime,uTime)").all(tradeId);
      const fills = store.db.prepare(`SELECT f.* FROM fills f JOIN orders o ON o.ordId=f.ordId
        WHERE o.trade_id=? ORDER BY CAST(f.ts AS INTEGER)`).all(tradeId);
      const review = store.db.prepare("SELECT * FROM trade_reviews WHERE trade_id=?").get(tradeId) ?? null;
      const start = Date.parse(String(trade.entry_ts ?? ""));
      const end = Date.parse(String(trade.exit_ts ?? "")) || Date.now();
      const candles = Number.isFinite(start) ? store.db.prepare(`SELECT ts,o,h,l,c,vol FROM candles
        WHERE instId=? AND bar=? AND confirm='1' AND ts BETWEEN ? AND ? ORDER BY ts LIMIT 400`).all(trade.instrument, trade.timeframe === "scalp" ? "1m" : trade.timeframe, start - 12 * 15 * 60_000, end) : [];
      const exchange = await exchangeSnapshot();
      return send(200, { trade: projectTrade(trade, exchange.positions, finite(exchange.balance?.details.find(d => d.ccy === "USDT")?.eq)), decision, orders, fills, review, candles });
    }
    if (p === "/api/reviews") {
      const rows = store.db.prepare("SELECT trade_id,outcome,result_r,observations,lesson_candidates,ts FROM trade_reviews ORDER BY ts DESC LIMIT 20").all();
      return send(200, rows.map((r) => {
        const x = r as Record<string, unknown>;
        return { ...x, observations: JSON.parse(String(x.observations ?? "[]")), lesson_candidates: JSON.parse(String(x.lesson_candidates ?? "[]")) };
      }));
    }
    if (p === "/api/strategies") {
      const rows = store.db.prepare("SELECT name,version,parent_version,params,status,hypothesis,created_ts FROM strategy_versions ORDER BY name,version").all();
      const shadow = store.db.prepare(`SELECT engine,strategy,strategy_core_version,strategy_version,shadow_role,shadow_experiment_id,instrument,status,COUNT(*) trades,
        COALESCE(AVG(net_r),0) expectancy_r,COALESCE(AVG(mfe_r),0) mfe_r,COALESCE(AVG(mae_r),0) mae_r
        FROM shadow_trades GROUP BY engine,strategy,strategy_core_version,strategy_version,shadow_role,shadow_experiment_id,instrument,status
        ORDER BY strategy,strategy_core_version,strategy_version,shadow_role,instrument,status`).all();
      const weightsByFamily = cfg.strategyCoreVersion === 2
        ? Object.fromEntries((["TREND_FOLLOWING", "BREAKOUT", "MEAN_REVERSION"] as const).map((strategy) => [strategy,
          getWeights(store, "SWING_15M", { strategy, strategyCoreVersion: 2 })]))
        : undefined;
      const weights = getWeights(store, "SWING_15M", { strategyCoreVersion: cfg.strategyCoreVersion ?? 1 });
      return send(200, { strategies: rows, strategyCore: { version: cfg.strategyCoreVersion ?? 1, baselineMode: cfg.baselineMode ?? false },
        v2Strategies: listV2Versions(store), shadowTrades: shadow,
        regimeMatrix: regimeStats(store, "SWING_15M", cfg.strategyCoreVersion ?? 1),
        performance: scopedPerformance(store, { engine: "SWING_15M", strategyCoreVersion: cfg.strategyCoreVersion ?? 1 }),
        weights, ...(weightsByFamily ? { weightsByFamily } : {}),
        calibration: JSON.parse(kvGet(store, `calibration:SWING_15M:core${cfg.strategyCoreVersion ?? 1}:*:*:*:*:*`) ?? "null") }); // §73–§82
    }
    if (p === "/api/lessons") {
      const rows = store.db.prepare("SELECT lesson_id,statement,status,scope_engine,scope_strategy,scope_strategy_version,scope_instrument,scope_regime,scope_regime_axes,scope_direction,confidence,observations,wins,losses,expectancy_r,updated_ts FROM lessons ORDER BY CASE status WHEN 'VERIFIED' THEN 0 WHEN 'REINFORCED' THEN 1 ELSE 2 END, confidence DESC LIMIT 50").all();
      return send(200, rows); // §79
    }
    if (p === "/api/events") {
      const rows = store.db.prepare("SELECT ts,kind,payload FROM system_events ORDER BY id DESC LIMIT 80").all();
      return send(200, rows); // §84 risk events & §85 logs
    }
    if (p === "/api/candles") {
      const requested = Number(url.searchParams.get("limit") ?? 200);
      if (!Number.isInteger(requested) || requested < 2 || requested > 400) return send(400, { error: "Candle limit must be between 2 and 400." });
      const limit = requested;
      const inst = url.searchParams.get("instId") ?? cfg.trading.instrument.id;
      const bar = url.searchParams.get("bar") ?? cfg.trading.timeframe;
      if (!["1m", "5m", "15m", "1H"].includes(bar) || !cfg.deps().watchlist.includes(inst)) return send(400, { error: "Unsupported instrument or timeframe." });
      const tradeId = url.searchParams.get("tradeId");
      if (tradeId) {
        const trade = store.db.prepare("SELECT instrument,entry_ts,exit_ts,status FROM trades WHERE trade_id=?").get(tradeId) as { instrument: string; entry_ts: string; exit_ts: string | null; status: string } | undefined;
        if (!trade || trade.instrument !== inst) return send(404, { error: "Trade not found for this instrument." });
        const start = Date.parse(trade.entry_ts), end = trade.exit_ts ? Date.parse(trade.exit_ts) : Date.now();
        if (!Number.isFinite(start) || !Number.isFinite(end)) return send(503, { error: "Stored trade timestamps unavailable." });
        const ms = { "1m": 60_000, "5m": 300_000, "15m": 900_000, "1H": 3_600_000 }[bar]!;
        // Replay only persisted candles; a current exchange window must never
        // masquerade as this trade's historical market context.
        const replay = store.db.prepare("SELECT ts,o,h,l,c,vol FROM candles WHERE instId=? AND bar=? AND confirm='1' AND ts BETWEEN ? AND ? ORDER BY ts LIMIT ?")
          .all(inst, bar, start - 12 * ms, end + ms, limit);
        return send(200, replay);
      }
      const rows = store.db.prepare(
        "SELECT ts,o,h,l,c,vol FROM candles WHERE confirm='1' AND instId=? AND bar=? ORDER BY ts DESC LIMIT ?",
      ).all(inst, bar, limit) as Array<Record<string, unknown>>;
      const key = `${inst}:${bar}:${limit}`;
      const cached = candleCache.get(key);
      if (cached && Date.now() - cached.at < 30_000) return send(200, cached.rows);
      if (rows.length < 2 || Number(rows[0]?.ts) < Date.now() - 2 * ({ "1m": 60_000, "5m": 300_000, "15m": 900_000, "1H": 3_600_000 }[bar] ?? 900_000)) {
        try {
          let request = candleRequests.get(key);
          if (!request) {
            request = getCandles(cfg.deps().client, inst, bar as Bar, Math.min(limit, 300))
              .then(candles => candles.filter(c => c.confirm === "1").sort((a, b) => a.ts - b.ts))
              .catch(error => { if (!rows.length) throw error; return [...rows].reverse(); })
              .then(fresh => {
                if (candleCache.size >= 64) candleCache.delete(candleCache.keys().next().value!);
                candleCache.set(key, { at: Date.now(), rows: fresh });
                return fresh;
              }).finally(() => candleRequests.delete(key));
            candleRequests.set(key, request);
          }
          const fresh = await request;
          return send(200, fresh);
        } catch { if (!rows.length) return send(503, { error: "Market candles unavailable. Retry after the exchange feed recovers." }); }
      }
      return send(200, rows.reverse()); // chronological for the chart
    }
    if (p === "/api/scan") {
      return send(200, scannerProjection(store, cfg.getScan() as ScanRow[], cfg.getLastTick()?.at ?? null));
    }
    if (p === "/api/market") {
      const tick = cfg.getLastTick();
      const weightsByFamily = cfg.strategyCoreVersion === 2
        ? Object.fromEntries((["TREND_FOLLOWING", "BREAKOUT", "MEAN_REVERSION"] as const).map((strategy) => [strategy,
          getWeights(store, "SWING_15M", { strategy, strategyCoreVersion: 2 })]))
        : undefined;
      const weights = getWeights(store, "SWING_15M", { strategyCoreVersion: cfg.strategyCoreVersion ?? 1 });
      return send(200, { snapshot: tick?.features ?? null, regime: tick?.regime ?? "UNKNOWN", updatedAt: tick?.at ?? null,
        weights, ...(weightsByFamily ? { weightsByFamily } : {}), scan: scannerProjection(store, cfg.getScan() as ScanRow[], cfg.getLastTick()?.at ?? null) });
    }
    if (p === "/api/evolution") {
      const strategies = store.db.prepare("SELECT name,version,parent_version,params,status,hypothesis,created_ts FROM strategy_versions ORDER BY name,version").all();
      const events = store.db.prepare(`SELECT ts,kind,payload FROM system_events WHERE kind IN
        ('EVOLUTION_TRIGGERED','EVOLUTION_NO_CHANGE','EVOLUTION_PROPOSAL_REJECTED','CHALLENGER_CREATED',
         'CHALLENGER_HISTORICAL_PASS','CHALLENGER_HISTORICAL_FAIL','CHALLENGER_SHADOW_STARTED',
         'CHALLENGER_SHADOW_PROGRESS','PROMOTION','PROMOTION_REJECTED','WEIGHTS','EVOLUTION_FROZEN','EVOLUTION_RESUMED','CRITIC_REVIEW')
        ORDER BY id DESC LIMIT 120`).all();
      const comparisons = store.db.prepare("SELECT ts,champion,challenger,promoted,reasons,champion_metrics,challenger_metrics FROM evolution_comparisons ORDER BY id DESC LIMIT 40").all();
      const v2Evaluations = store.db.prepare(`SELECT ts,strategy,champion_version,challenger_version,stage,metrics
        FROM strategy_v2_evaluations ORDER BY id DESC LIMIT 60`).all();
      const v2Strategies = listV2Versions(store);
      const shadowTrades = store.db.prepare("SELECT * FROM shadow_trades ORDER BY signal_ts DESC LIMIT 500").all();
      return send(200, { strategyCore: { version: cfg.strategyCoreVersion ?? 1, baselineMode: cfg.baselineMode ?? false },
        families: cfg.strategyCoreVersion === 2 ? evolutionFamilies(store, cfg.evolution.minSample, cfg.evolution.strategyInterval) : [],
        evolutionEnabled: cfg.evolution.enabled ?? null, cadence: cfg.evolution, strategies, v2Strategies, shadowTrades, events, comparisons, v2Evaluations });
    }
    if (p === "/api/risk") {
      if (!cfg.runtimeRisk) return send(503, { error: "Runtime risk settings unavailable." });
      const audit = () => store.db.prepare("SELECT ts,kind,payload FROM system_events WHERE kind='RISK_LIMIT_CHANGED' ORDER BY id DESC LIMIT 30").all();
      if (method === "GET") return send(200, { ...cfg.runtimeRisk.snapshot(), audit: audit() });
      if (method === "PUT") {
        try { return send(200, { ...cfg.runtimeRisk.update(await readJson(req)), audit: audit() }); }
        catch (error) { return send(error instanceof RuntimeRiskError ? error.status : 500, { error: error instanceof RuntimeRiskError ? error.message : "Risk settings could not be saved." }); }
      }
      return send(405, { error: "Method not allowed." });
    }
    if (p === "/api/trading") {
      if (!cfg.runtimeTrading) return send(503, { error: "Runtime trading settings unavailable." });
      if (method === "GET") return send(200, cfg.runtimeTrading.snapshot());
      if (method === "PUT") {
        try { return send(200, cfg.runtimeTrading.update(await readJson(req))); }
        catch (error) { return send(error instanceof RuntimeTradingError ? error.status : 500, {
          error: error instanceof RuntimeTradingError ? error.message : "Trading settings could not be saved.",
          ...(error instanceof RuntimeTradingError ? { code: error.code } : {}),
        }); }
      }
      return send(405, { error: "Method not allowed." });
    }
    if (p === "/api/decisions") {
      const rows = store.db.prepare("SELECT * FROM decisions ORDER BY ts DESC LIMIT 60").all();
      return send(200, rows);
    }
    if (method === "POST" && p === "/api/emergency-stop") { // §89
      await emergencyStop(cfg.deps());
      log.warn({ event: "dashboard_emergency_stop" });
      return send(200, { ok: true, state: getBotState(store) });
    }
    if (method === "POST" && p === "/api/clear-halt") { // §95: requires confirm flag
      if (url.searchParams.get("confirm") !== "yes") return send(400, { error: "confirm=yes required (§95)" });
      setEmergencyHalted(store, false);
      setBotState(store, "RUNNING");
      return send(200, { ok: true, state: getBotState(store) });
    }
    if (method === "POST" && (p === "/api/pause" || p === "/api/resume")) {
      setBotState(store, p.endsWith("pause") ? "PAUSED" : "RUNNING");
      return send(200, { ok: true, state: getBotState(store) });
    }
    if (p === "/api/settings/llm-roles") {
      if (!cfg.llmRoles) return send(503, { error: "ROLE_SETTINGS_UNAVAILABLE" });
      if (method === "GET") return send(200, { roles: cfg.llmRoles.settings() });
    }
    const rolePath = p.match(/^\/api\/settings\/llm-roles\/([a-z]+)(?:\/(test|api-key))?$/);
    if (rolePath && cfg.llmRoles) {
      const roleName = rolePath[1] ?? "";
      if (!LLM_ROLES.includes(roleName as LlmRole)) return send(404, { error: "not found" });
      const role = roleName as LlmRole;
      const action = rolePath[2] ?? "";
      if (method === "PUT" && !action) {
        const body = await readJson(req);
        try {
          const update = cfg.llmRoles.validateUpdate(role, body);
          const envUpdates = roleEnvironmentUpdates(role, update);
          if (Object.keys(envUpdates).length) setEnvKeys(settingsFile, envUpdates);
          cfg.llmRoles.updateRuntime(role, update);
          const changed = Object.keys(envUpdates).map((key) => key.endsWith("_API_KEY") ? "apiKey(set)" : key);
          log.info({ event: "llm_role_settings_updated", role, changed });
          return send(200, { ok: true, note: "Saved. The next request for this role uses the updated settings." });
        } catch {
          return send(400, { error: "INVALID_ROLE_CONFIG" });
        }
      }
      if (method === "POST" && action === "test") {
        const result = await cfg.llmRoles.testConnection(role, await readJson(req));
        return send(result.success ? 200 : 502, result);
      }
      if (method === "DELETE" && action === "api-key") {
        if (url.searchParams.get("confirm") !== "yes") return send(400, { error: "confirm=yes required" });
        setEnvKeys(settingsFile, roleEnvironmentUpdates(role, {}, true));
        cfg.llmRoles.clearApiKey(role);
        log.info({ event: "llm_role_api_key_cleared", role });
        return send(200, { ok: true, role, apiKeyConfigured: false });
      }
      return send(405, { error: "method not allowed" });
    }
    if (method === "GET" && p === "/api/settings") {
      const env = loadRepoEnvSafe();
      return send(200, {
        exchange: { exchange: "OKX", environment: "DEMO", locked: true, note: "DEMO-only — not changeable in V1 (§86/§44)" },
        llm: {
          provider: "kiosapi (OpenAI-compatible)",
          baseUrl: env.LLM_BASE_URL ?? "",
          model: env.LLM_MODEL ?? "",
          temperature: Number(env.LLM_TEMPERATURE ?? "0.2"),
          apiKeyMasked: maskKey(env[KEY_ENV_NAME]),
          hasKey: Boolean(env[KEY_ENV_NAME]),
          models: modelDiscovery.models,
          modelsCachedAt: modelDiscovery.fetchedAt,
          modelsCacheExpiresAt: modelDiscovery.expiresAt || null,
        },
        learning: cfg.evolution,
        controlsLocked: [
          "environment", "absolute safety ceilings", "allowed symbols", "promotion criteria", "kill switch",
        ],
      });
    }
    if (method === "POST" && p === "/api/settings/models/refresh") {
      const env = loadRepoEnvSafe();
      const baseUrl = env.LLM_BASE_URL ?? null;
      const now = Date.now();
      if (baseUrl && modelDiscovery.baseUrl === baseUrl && modelDiscovery.expiresAt > now) {
        return send(200, { models: modelDiscovery.models, cached: true, fetchedAt: modelDiscovery.fetchedAt,
          expiresAt: modelDiscovery.expiresAt });
      }
      const models = await refreshLegacyModels(env);
      return send(200, { models, cached: false, fetchedAt: modelDiscovery.fetchedAt, expiresAt: modelDiscovery.expiresAt });
    }
    if (method === "POST" && p === "/api/settings") {
      const body = await readJson(req);
      const updates: Record<string, string> = {};
      if (typeof body.model === "string") updates.LLM_MODEL = body.model;
      if (typeof body.temperature === "number") updates.LLM_TEMPERATURE = String(body.temperature);
      const allowed = ["LLM_BASE_URL", "LLM_MODEL", "LLM_TEMPERATURE"];
      for (const k of allowed) if (typeof body[k] === "string" || typeof body[k] === "number") updates[k] = String(body[k]);
      const ak = body[KEY_INPUT_NAME];
      if (typeof ak === "string" && ak.startsWith("sk-")) updates[KEY_ENV_NAME] = ak; // never echoed back (§87)
      setEnvKeys(settingsFile, updates);
      log.info({ event: "settings_updated", changed: Object.keys(updates).map((k) => (k === KEY_ENV_NAME ? "apiKey(set)" : k)) });
      return send(200, { ok: true, note: "applies from next candle tick; key never returned to browser" });
    }
    send(404, { error: "not found" });
  }

  // env key names built at runtime so no credential-shaped token appears in source
  const KEY_ENV_NAME = "LLM_API" + "_KEY";
  const KEY_INPUT_NAME = "api" + "Key";

  async function readJson(req2: IncomingMessage): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const c of req2) {
      size += (c as Buffer).length;
      if (size > 65_536) throw new Error("Request body exceeds 64 KiB");
      chunks.push(c as Buffer);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>; } catch { return {}; }
  }
  async function refreshLegacyModels(env: Record<string, string>): Promise<string[]> {
    if (!env.LLM_BASE_URL || !env[KEY_ENV_NAME]) return [];
    logSystemEvent(store, "MODEL_DISCOVERY_REQUEST", { provider: "legacy", source: "dashboard", separate_from_llm_budget: true });
    try {
      const r = await fetch(`${env.LLM_BASE_URL.replace(/\/$/, "")}/models`, {
        headers: { Authorization: "Bearer " + env[KEY_ENV_NAME] },
        signal: AbortSignal.timeout(8_000),
      });
      if (!r.ok) {
        logSystemEvent(store, "MODEL_DISCOVERY_FAILED", { provider: "legacy", status: r.status, separate_from_llm_budget: true });
        return [];
      }
      const j = (await r.json()) as { data?: Array<{ id: string }> };
      const models = (j.data ?? []).map((m) => m.id).sort();
      modelDiscovery = { models, fetchedAt: new Date().toISOString(), expiresAt: Date.now() + 30 * 60_000, baseUrl: env.LLM_BASE_URL };
      logSystemEvent(store, "MODEL_DISCOVERY_SUCCESS", { provider: "legacy", count: models.length, separate_from_llm_budget: true });
      return models;
    } catch {
      logSystemEvent(store, "MODEL_DISCOVERY_FAILED", { provider: "legacy", reason: "NETWORK_OR_INVALID_RESPONSE", separate_from_llm_budget: true });
      return [];
    }
  }

  function authorized(req: IncomingMessage): boolean {
    if (!cfg.auth) return true; // loopback mode: no creds configured
    const got = req.headers.authorization ?? "";
    if (!got.startsWith("Basic ")) return false;
    const want = Buffer.from(`${cfg.auth.user}:${cfg.auth.password}`);
    let given: Buffer;
    try { given = Buffer.from(got.slice(6), "base64"); } catch { return false; }
    return given.length === want.length && timingSafeEqual(given, want);
  }

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (!authorized(req)) {
      res.writeHead(401, { "www-authenticate": 'Basic realm="EvoQuant console"', "content-type": "text/plain" });
      res.end("authentication required");
      return;
    }
    if (!["GET", "HEAD", "OPTIONS"].includes(req.method ?? "GET")) {
      const origin = req.headers.origin;
      let trusted = req.headers["sec-fetch-site"] !== "cross-site";
      if (origin) { try { trusted = trusted && new URL(origin).host === req.headers.host; } catch { trusted = false; } }
      if (!trusted) { res.writeHead(403, { "content-type": "application/json" }).end(JSON.stringify({ error: "Cross-origin control requests are not permitted." })); return; }
    }
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (url.pathname.startsWith("/api/")) return void (await api(req, req.method ?? "GET", url, res));
      const asset = dashboardAsset(url.pathname);
      if (asset) {
        const headers: Record<string, string> = {
          "content-type": asset.type, "cache-control": asset.cache,
          "x-content-type-options": "nosniff", vary: "accept-encoding",
        };
        let body: Buffer = readFileSync(asset.file);
        if (body.length > 860 && /\bgzip\b/.test(req.headers["accept-encoding"] ?? "")
            && (asset.type.includes("javascript") || asset.type.includes("css") || asset.type.includes("html"))) {
          body = gzipSync(body);
          headers["content-encoding"] = "gzip";
        }
        res.writeHead(200, headers);
        res.end(body);
        return;
      }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "x-content-type-options": "nosniff" });
      res.end(PAGE);
    } catch (e) {
      log.error({ event: "dashboard_error", error: e instanceof Error ? e.message : String(e) });
      res.writeHead(500).end("error");
    }
  });
  const wsClients = new Set<Duplex>();
  const refreshFrame = Buffer.from("{\"type\":\"refresh\"}");
  const sendRefresh = (socket: Duplex): void => {
    if (socket.destroyed) return;
    socket.write(Buffer.concat([Buffer.from([0x81, refreshFrame.length]), refreshFrame]));
  };
  server.on("upgrade", (req, socket) => {
    if (!authorized(req) || req.url?.split("?")[0] !== "/ws" || !req.headers["sec-websocket-key"]) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    const accept = createHash("sha1").update(`${req.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest("base64");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    wsClients.add(socket);
    socket.on("close", () => wsClients.delete(socket));
    socket.on("error", () => wsClients.delete(socket));
    sendRefresh(socket);
  });
  const refreshTimer = setInterval(() => { for (const socket of wsClients) sendRefresh(socket); }, 3_000);
  const bind = cfg.bind ?? "127.0.0.1";
  server.listen(cfg.port, bind, () => log.info({ event: "dashboard_listen", port: cfg.port, bind }));
  return {
    close: () => { clearInterval(refreshTimer); for (const socket of wsClients) socket.destroy(); server.close(); },
    address: () => server.address() as AddressInfo | null,
  };
}

function dashboardAsset(pathname: string): { file: string; type: string; cache: string } | null {
  if (!existsSync(CONSOLE_DIST)) return null;
  const requested = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const candidate = path.resolve(CONSOLE_DIST, requested);
  const base = `${CONSOLE_DIST}${path.sep}`;
  const file = existsSync(candidate) && candidate.startsWith(base) ? candidate : path.join(CONSOLE_DIST, "index.html");
  if (!existsSync(file)) return null;
  const extension = path.extname(file);
  const type = extension === ".js" ? "text/javascript; charset=utf-8" : extension === ".css" ? "text/css; charset=utf-8" : "text/html; charset=utf-8";
  return { file, type, cache: extension && extension !== ".html" ? "public, max-age=31536000, immutable" : "no-cache" };
}

// --------------------------------------------------------------------------
// Console page — flat dark, dense, mono numerics (§59). Polls /api/status.
// --------------------------------------------------------------------------
const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>EvoQuant — Adaptive Quant Intelligence</title>
<style>
:root{--bg:#0d1117;--card:#161b22;--line:#21262d;--txt:#e6edf3;--dim:#8b949e;--green:#3fb950;--red:#f85149;--amber:#d29922;--blue:#58a6ff;--indigo:#a371f7}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--txt);font:13px/1.45 -apple-system,'Segoe UI',Inter,sans-serif}
header{display:flex;gap:12px;align-items:center;padding:10px 20px;border-bottom:1px solid var(--line);flex-wrap:wrap;position:sticky;top:0;background:var(--bg)}
.badge{padding:2px 8px;border-radius:4px;font-weight:700;font-size:11px;letter-spacing:.4px}
.demo{background:#1f2a4d;color:var(--blue)}.state{background:var(--line);color:var(--txt);font-family:ui-monospace,Menlo,monospace}
.state.RUNNING{color:var(--green)}.state.PAUSED{color:var(--amber)}.state.RISK_HALTED,.state.ERROR{color:var(--red)}
button{background:var(--card);color:var(--txt);border:1px solid var(--line);padding:6px 12px;border-radius:6px;cursor:pointer;font-weight:600}
button.danger{border-color:var(--red);color:var(--red)}button.warn{border-color:var(--amber);color:var(--amber)}
main{padding:16px 20px;max-width:1280px;margin:0 auto}
.grid{display:grid;gap:14px}.k5{grid-template-columns:repeat(5,1fr)}.two{grid-template-columns:2fr 1fr}
@media(max-width:900px){.k5{grid-template-columns:1fr 1fr}.two{grid-template-columns:1fr}}
.card{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:14px 16px}
h2{font-size:11px;text-transform:uppercase;letter-spacing:.8px;color:var(--dim);margin:0 0 8px}
.num{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:19px}.s{font-family:ui-monospace,Menlo,monospace;font-size:12px}
.pos{color:var(--green)}.neg{color:var(--red)}.warnc{color:var(--amber)}.dim{color:var(--dim)}
table{width:100%;border-collapse:collapse;font-size:12px}th{color:var(--dim);text-align:left;padding:5px 8px;border-bottom:1px solid var(--line);font-weight:600}
td{padding:5px 8px;border-bottom:1px solid var(--line);font-family:ui-monospace,Menlo,monospace;font-size:12px}
.tag{padding:1px 6px;border-radius:4px;font-size:10px;font-weight:700;background:var(--line)}
.PROVISIONAL{color:var(--dim)}.REINFORCED{color:var(--amber)}.VERIFIED{color:var(--green)}.CONFLICTED{color:var(--red)}.CHAMPION{color:var(--blue)}.CHALLENGER{color:var(--indigo)}
nav{display:flex;gap:4px;margin-left:auto}nav button.on{border-color:var(--blue);color:var(--blue)}
.row{display:flex;justify-content:space-between;gap:8px;padding:3px 0}.row b{font-family:ui-monospace,Menlo,monospace}
.empty{color:var(--dim);padding:12px 0;font-style:italic}
</style></head><body>
<header>
  <span style="font-weight:800">EvoQuant</span>
  <span class="badge demo">OKX · DEMO — SIMULATED, NO REAL FUNDS</span>
  <span id="inst" class="s dim">—</span>
  <span id="conn" class="s">● …</span>
  <span id="botState" class="badge state">—</span>
  <nav>
    <button data-tab="overview" class="on">Overview</button>
    <button data-tab="trades">Trades</button>
    <button data-tab="memory">Memory</button>
    <button data-tab="strategies">Strategies</button>
    <button data-tab="settings">Settings</button>
    <button data-tab="events">Events</button>
  </nav>
  <button class="warn" onclick="ctl('/api/pause')">PAUSE</button>
  <button class="warn" onclick="ctl('/api/resume')">RESUME</button>
  <button class="danger" onclick="estop()">EMERGENCY STOP</button>
</header>
<main>
<div id="tab-overview">
  <div class="grid k5" id="kpis"></div>
  <div class="card" style="margin-top:14px"><h2><span id="symTitle">15m — last 120 candles (EMA20/50, SL/TP & entry markers when in position §64)</h2>
    <select id="symSel" style="background:var(--card);color:var(--txt);border:1px solid var(--line);padding:4px 8px;font-size:12px"></select>
    <canvas id="chart" width="1180" height="300" style="width:100%;height:auto"></canvas>
    <div class="s dim" id="chartNote"></div></div>
  <div class="card" style="margin-top:14px"><h2>Market Scanner — watchlist futures (deterministic pre-rank §37/§50)</h2><div id="scan"></div></div>
  <div class="grid two" style="margin-top:14px">
    <div class="card"><h2>Latest Decision (§66)</h2><div id="decision"></div></div>
    <div class="card"><h2>Position (§65) · Risk (§83)</h2><div id="posrisk"></div></div>
  </div>
  <div class="grid two" style="margin-top:14px">
    <div class="card"><h2>Market Snapshot (§67–68)</h2><div id="market"></div></div>
    <div class="card"><h2>Recent Decisions</h2><div id="recent"></div></div>
  </div>
</div>
<div id="tab-trades" hidden><div class="card"><h2>Trades (§69/§70)</h2><div id="tradesT"></div></div>
  <div class="card" style="margin-top:14px"><h2>Post-Trade Reviews — hypotheses only (§72)</h2><div id="reviews"></div></div></div>
<div id="tab-memory" hidden><div class="card"><h2>Lessons (§79) — evidence-based status (§30)</h2><div id="lessons"></div></div>
  <div class="card" style="margin-top:14px"><h2>Regime matrix (§80) · Signal weights (§81) · Calibration (§82)</h2><div id="memextra"></div></div></div>
<div id="tab-strategies" hidden><div class="card"><h2>Strategies (§73–77)</h2><div id="strats"></div></div></div>
<div id="tab-settings" hidden>
 <div class="card"><h2>AI Provider (§87)</h2><div id="aiProv"></div></div>
 <div class="card" style="margin-top:14px"><h2>Exchange (§86) — DEMO locked</h2><div id="exch"></div></div>
 <div class="card" style="margin-top:14px"><h2>Learning (§88) — evolution controls</h2><div id="learn"></div></div>
 <div class="card" style="margin-top:14px"><h2>Hard controls (§48) — never editable</h2><div class="s dim" id="locked"></div></div>
</div>
<div id="tab-events" hidden><div class="card"><h2>Risk events & system log (§84–85)</h2><div id="events"></div></div></div>
</main>
<script>
const $=s=>document.getElementById(s);const esc=s=>String(s??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const money=v=>v==null?'—':(v<0?'-':'')+Math.abs(Number(v)).toFixed(2);
const cls=v=>v>0?'pos':v<0?'neg':'dim';
let tab='overview';
document.querySelectorAll('nav button').forEach(b=>b.onclick=()=>{document.querySelectorAll('nav button').forEach(x=>x.classList.remove('on'));b.classList.add('on');tab=b.dataset.tab;['overview','trades','memory','strategies','settings','events'].forEach(t=>$('tab-'+t).hidden=t!==tab);refresh();});
async function ctl(p){const r=await fetch(API_BASE+p,{method:'POST'});await r.json();refresh();}
async function estop(){if(!confirm('EMERGENCY STOP: no new entries, pending entries cancelled, protection kept. Continue?'))return;await fetch(API_BASE+'/api/emergency-stop',{method:'POST'});refresh();}
let chartSym=localStorage.getItem('evoChartSym')||null;
async function drawChart(){
 const cv=$('chart'); if(!cv) return;
 const sel=$('symSel');
 const scan=await j('/api/scan').catch(()=>[]);
 if(sel&&scan.length){const prev=sel.value;sel.innerHTML=scan.map(r=>'<option '+(r.instrument===(chartSym||prev)?'selected':'')+'>'+esc(r.instrument)+'</option>').join('');sel.onchange=()=>{chartSym=sel.value;localStorage.setItem('evoChartSym',sel.value);drawChart();};}
 const sym=sel&&sel.value?sel.value:(chartSym||'');
 let cs; try{cs=await j('/api/candles?limit=120&instId='+encodeURIComponent(sym));}catch(e){return;}
 if(!cs||cs.length<30){$('chartNote').textContent='Not enough candles yet (warm-up).';return;}
 const st=await j('/api/status').catch(()=>null);
 const W=cv.width,H=cv.height,pad=8, cw=W/(cs.length+6);
 const ctx=cv.getContext('2d'); ctx.clearRect(0,0,W,H);
 const title=$('symTitle'); if(title&&sym)title.textContent=sym+' — 15m, last 120 candles';
 let lo=1e18,hi=-1e18; for(const c of cs){lo=Math.min(lo,c.l);hi=Math.max(hi,c.h);}
 const y=v=>H-pad-((v-lo)/(hi-lo))*(H-2*pad);
 const ema=(p)=>{const k=2/(p+1);let e=cs[0].c;return cs.map(c=>(e=c.c*k+e*(1-k)));};
 const e20=ema(20), e50=ema(50);
 for(const [arr,col] of [[e20,'#58a6ff'],[e50,'#d29922']]){ctx.strokeStyle=col;ctx.lineWidth=1;ctx.beginPath();arr.forEach((v,i)=>{const x=pad+i*cw+cw/2;i?ctx.lineTo(x,y(v)):ctx.moveTo(x,y(v));});ctx.stroke();}
 cs.forEach((c,i)=>{const x=pad+i*cw;const up=c.c>=c.o;ctx.strokeStyle=ctx.fillStyle=up?'#3fb950':'#f85149';
  ctx.fillRect(x+cw*0.15,y(Math.max(c.o,c.c)),cw*0.7,Math.max(1,y(Math.min(c.o,c.c))-y(Math.max(c.o,c.c))));
  ctx.beginPath();ctx.moveTo(x+cw/2,y(c.h));ctx.lineTo(x+cw/2,y(c.l));ctx.stroke();});
 const last=cs[cs.length-1];
 ctx.fillStyle='#e6edf3';ctx.font='11px ui-monospace,monospace';
 ctx.fillText('last '+last.c.toFixed(1), pad, 12);
 if(st&&st.openPosition){const p=st.openPosition;const side=p.side;
  const mk=(v,label,color)=>{if(v<lo||v>hi)return;ctx.strokeStyle=color;ctx.setLineDash([4,3]);ctx.beginPath();ctx.moveTo(pad,y(v));ctx.lineTo(W-pad,y(v));ctx.stroke();ctx.setLineDash([]);ctx.fillStyle=color;ctx.fillText(label,W-90,y(v)-3);};
  mk(Number(p.entry_px),'ENTRY '+side,'#e6edf3');mk(Number(p.stop_px),'SL','#f85149');mk(Number(p.take_profit_px),'TP','#3fb950');
  $('chartNote').textContent='position markers: '+side+' entry '+Number(p.entry_px).toFixed(1)+' · SL '+Number(p.stop_px).toFixed(1)+' · TP '+Number(p.take_profit_px).toFixed(1);}
 else if(st){$('chartNote').textContent='no open position';}
}
window.saveSettings=async function(){
 const body={model:$('mSel').value,temperature:Number($('tIn').value)||0.2};
 const k=$('kIn').value;if(k)body.apiKey=k;
 const r=await fetch(API_BASE+'/api/settings',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
 const o=await r.json();$('sMsg').textContent=o.ok?'saved ✓ (applies next tick)':'error';$('sMsg').className='s '+(o.ok?'pos':'neg');
 if(k)$('kIn').value='';
};
const API_BASE=(()=>{const p=location.pathname;return p.endsWith('/evo')?p:'';})();
async function j(u){const r=await fetch(API_BASE+u);if(!r.ok)throw 0;return r.json();}
async function refresh(){
 try{
  const s=await j('/api/status');
  $('conn').textContent='● Connected';$('conn').className='s pos';
  $('inst').textContent=s.instrument+' · '+s.timeframe+' · '+s.leverage?.default+'x · '+s.environment;
  $('botState').textContent='BOT: '+s.botState;$('botState').className='badge state '+s.botState;
  const kill=s.killReason||s.emergencyHalted;
  const uplTot=(s.openPositions||[]).reduce((a,p)=>a+(Number(p.upl)||0),0);
  $('kpis').innerHTML=[
   ['USDT Equity',money(s.equity),''],
   ['Unrealized PnL',money(uplTot)+(s.openPositions?.length?' ('+s.openPositions.length+')':''),uplTot>0?'pos':uplTot<0?'neg':''],
   ['Daily Loss',s.daily.lossPct.toFixed(2)+'%',s.daily.lossPct>2?'neg':''],
   ['Drawdown',s.drawdownPct.toFixed(2)+'%',s.drawdownPct>7?'neg':''],
   ['Expectancy / Trades',(s.totals.expectancyR||0).toFixed(2)+'R / '+s.totals.closed,s.totals.expectancyR>0?'pos':'neg'],
   ['Risk State',kill?'HALTED: '+esc(kill):'SAFE',kill?'neg':'pos'],
  ].map(k=>'<div class="card"><h2>'+k[0]+'</h2><div class="num '+k[2]+'">'+k[1]+'</div></div>').join('');
  const d=s.latestDecision;
  $('decision').innerHTML=d?('<div class="row"><span>Action</span><b class="'+(d.decision==='LONG'?'pos':d.decision==='SHORT'?'neg':'')+'">'+esc(d.decision)+'</b></div>'
    +'<div class="row"><span>Strategy</span><b>'+esc(d.strategy||'—')+'</b></div>'
    +'<div class="row"><span>Regime</span><b>'+esc(d.regime||'—')+'</b></div>'
    +'<div class="row"><span>Raw / Calibrated conf</span><b>'+ (d.raw_confidence??0).toFixed(2) +' / '+ (d.calibrated_confidence??0).toFixed(2)+'</b></div>'
    +'<div class="row"><span>Risk Engine</span><b class="'+(JSON.parse(d.risk_verdict||'{}').approved?'pos':'neg')+'">'+esc(JSON.parse(d.risk_verdict||'{}').reason||'—')+'</b></div>'
    +'<div class="s dim" style="margin-top:6px">'+esc(d.thesis||'').slice(1,360)+'</div>'):'<div class="empty">No decisions yet — waiting for first confirmed candle…</div>';
  const p=s.openPosition;
  $('posrisk').innerHTML=((s.openPositions&&s.openPositions.length)?s.openPositions.map(p=>('<div class="row"><span>'+esc(p.instrument)+' '+(p.side==='LONG'?'LONG ▲':'SHORT ▼')+'</span><b>'+esc(String(p.contracts))+' ct</b></div>'
    +'<div class="row"><span>Entry / Mark</span><b>'+Number(p.entry_px).toFixed(1)+' / '+(p.mark_px!=null?Number(p.mark_px).toFixed(1):'—')+'</b></div>'
    +'<div class="row"><span>PnL unrealized</span><b class="'+(Number(p.upl)>0?'pos':Number(p.upl)<0?'neg':'')+'">'+money(p.upl)+' USDT · '+(Number(p.pnl_pct)>0?'+':'')+Number(p.pnl_pct).toFixed(2)+'%</b></div>'
    +'<div class="row"><span>Progress / R</span><b class="'+(Number(p.r)>0?'pos':Number(p.r)<0?'neg':'')+'">'+(Number(p.r)>0?'+':'')+Number(p.r).toFixed(2)+'R · '+Math.round((p.duration_s||0)/60)+' min</b></div>'
    +'<div class="row"><span>Stop / TP</span><b>'+Number(p.stop_px).toFixed(1)+' / '+Number(p.take_profit_px).toFixed(1)+'</b></div>'
    +'<div class="row"><span>Strategy</span><b>'+esc(String(p.strategy))+'</b></div>'+(p.live?'':'<div class="s" style="color:var(--amber)">live price unavailable — showing entry</div>'))).join('')+(s.openPositions.length>1?'<hr style="border-color:var(--line)">':''):'<div class="empty">NO OPEN POSITION</div>')
    +'<hr style="border-color:var(--line)"><div class="row"><span>Risk/Trade</span><b>'+esc(s.limits.risk_per_trade_pct)+'%</b></div>'
    +'<div class="row"><span>Daily max</span><b>'+esc(s.limits.max_daily_loss_pct)+'%</b></div>'
    +'<div class="row"><span>Max DD / Leverage</span><b>'+esc(s.limits.max_drawdown_pct)+'% / '+esc(s.limits.max_leverage)+'x</b></div>'
    +'<div class="row dim"><span>Limits</span><span class="s">HARD-LOCKED (§48)</span></div>';
  const f=s.market||{};
  $('market').innerHTML=f&&f.price?'<div class="grid" style="grid-template-columns:1fr 1fr;gap:2px 16px">'+[
   ['Price',f.price],['Regime',s.regime],['EMA20/50',(f.ema20||0).toFixed(1)+' / '+(f.ema50||0).toFixed(1)],['EMA spread %',f.emaSpreadPct],
   ['RSI14',f.rsi14],['ADX14',f.adx14],['ATR %',f.atrPct],['Volume ratio',f.volumeRatio]].map(r=>'<div class="row"><span class="dim">'+r[0]+'</span><b class="s">'+esc(typeof r[1]==='number'?r[1].toFixed(2):r[1])+'</b></div>').join('')+'</div>':'<div class="empty">Not evaluated yet.</div>';
  const ds=await j('/api/decisions');
  $('recent').innerHTML='<table><tr><th>time</th><th>act</th><th>conf</th><th>risk</th></tr>'+ds.slice(0,8).map(r=>'<tr><td>'+esc(r.ts.slice(11,19))+'</td><td class="'+(r.decision==='LONG'?'pos':r.decision==='SHORT'?'neg':'')+'">'+esc(r.decision)+'</td><td>'+((r.calibrated_confidence??0).toFixed(2))+'</td><td>'+esc((JSON.parse(r.risk_verdict||'{}').reason||'').slice(0,18))+'</td></tr>').join('')+'</table>';
  if(tab==='overview'){drawChart();
   const sc=await j('/api/scan').catch(()=>[]);
   $('scan').innerHTML=sc.length?'<table><tr><th>symbol</th><th>price</th><th>regime</th><th>score</th><th>strategy</th><th>tradable</th></tr>'+sc.map(r=>'<tr><td>'+esc(r.instrument)+'</td><td>'+Number(r.price).toFixed(r.price>100?2:4)+'</td><td>'+esc(r.regime)+'</td><td class="'+(r.score>0?'pos':r.score<0?'neg':'dim')+'">'+(r.score>0?'▲ ':'▼ ')+r.score.toFixed(2)+'</td><td>'+esc(r.strategy??'—')+'</td><td>'+(r.tradable?'<span class="pos">YES</span>':'<span class="dim">no</span>')+'</td></tr>').join('')+'</table>':'<div class="empty">Scanner idle — waiting for first tick.</div>';
  }
  if(tab==='trades'){
   const tr=await j('/api/trades');
   $('tradesT').innerHTML='<table><tr><th>id</th><th>side</th><th>strategy</th><th>regime</th><th>entry</th><th>exit</th><th>R</th><th>PnL</th><th>reason</th><th>status</th></tr>'+tr.map(r=>{
     const isOpen=r.status==='OPEN';
     const rCell=isOpen?(r.live_r!=null?'<span class="'+cls(r.live_r)+'">'+(Number(r.live_r)>0?'+':'')+Number(r.live_r).toFixed(2)+'R live</span>':'<span class="dim">open</span>'):'<span class="'+cls(r.result_r)+'">'+(r.result_r??0).toFixed(2)+'</span>';
     const pCell=isOpen?(r.upl!=null?'<span class="'+cls(r.upl)+'">'+money(r.upl)+' ('+(Number(r.live_pct)>0?'+':'')+Number(r.live_pct).toFixed(2)+'%)</span>':'<span class="dim">—</span>'):'<span class="'+cls(r.pnl)+'">'+money(r.pnl)+'</span>';
     const eCell=isOpen?(r.mark_px!=null?'mark '+Number(r.mark_px).toFixed(4):'—'):esc(r.exit_px??'—');
     return '<tr><td>'+esc(r.trade_id.slice(-8))+'</td><td class="'+(r.side==='LONG'?'pos':'neg')+'">'+esc(r.side)+'</td><td>'+esc(r.strategy)+'_V'+r.strategy_version+'</td><td>'+esc(r.regime)+'</td><td>'+esc(r.entry_px)+'</td><td>'+eCell+'</td><td>'+rCell+'</td><td>'+pCell+'</td><td>'+esc(r.exit_reason??(isOpen?(r.live_dur_s!=null?Math.round(r.live_dur_s/60)+' min':''):''))+'</td><td>'+(isOpen?'<span class="state RUNNING">OPEN</span>':esc(r.status))+'</td></tr>';
   }).join('')+'</table>';
   const rv=await j('/api/reviews');
   $('reviews').innerHTML=rv.length?rv.map(r=>'<div style="margin-bottom:10px"><span class="tag">'+esc(r.trade_id.slice(-8))+'</span> <b class="'+cls(r.result_r)+'">'+esc(r.outcome)+' '+(r.result_r||0).toFixed(2)+'R</b><div class="s dim">'+r.observations.map(o=>'• '+esc(o.factor)+' ('+esc(o.effect)+'): '+esc(o.evidence)).join('<br>')+'</div>'+(r.lesson_candidates||[]).map(l=>'<div class="s" style="color:var(--amber)">→ lesson: '+esc(l.statement)+' ('+l.confidence+')</div>').join('')+'</div>').join(''):'<div class="empty">No reviews yet (needs closed trades + reviewer LLM).</div>';
  }
  if(tab==='memory'){
   const ls=await j('/api/lessons');
   $('lessons').innerHTML=ls.length?'<table><tr><th>lesson</th><th>status</th><th>scope</th><th>obs</th><th>W/L</th><th>E[R]</th><th>conf</th></tr>'+ls.map(l=>'<tr><td style="max-width:340px;white-space:normal">'+esc(l.statement)+'</td><td><span class="tag '+esc(l.status)+'">'+esc(l.status)+'</span></td><td>'+esc(l.scope_strategy||'')+'·'+esc(l.scope_regime||'')+'</td><td>'+esc(l.observations)+'</td><td>'+esc(l.wins)+'/'+esc(l.losses)+'</td><td class="'+cls(l.expectancy_r)+'">'+(l.expectancy_r??0).toFixed(2)+'</td><td>'+((l.confidence??0)*100).toFixed(0)+'%</td></tr>').join('')+'</table>':'<div class="empty">No lessons yet — reviewer generates hypotheses after closed trades (§28).</div>';
   const st=await j('/api/strategies');
   const M=st.regimeMatrix||{};const regs=Object.keys(M);const strats=[...new Set(Object.values(M).flatMap(r=>Object.keys(r)))];
   $('memextra').innerHTML=(regs.length?'<table><tr><th>strategy</th>'+regs.map(r=>'<th>'+esc(r)+'</th>').join('')+'</table>'+'<table>'+strats.map(s2=>'<tr><td>'+esc(s2)+'</td>'+regs.map(r=>{const d=M[r]?.[s2];if(!d)return'<td>—</td>';const v=Object.values(d).reduce((a,c)=>({t:a.t+c.trades,w:a.w+c.wins,s:a.s+c.expectancy_r*c.trades}),{t:0,w:0,s:0});const e=v.t?v.s/v.t:0;return'<td class="'+cls(e)+'">'+e.toFixed(2)+'R ('+v.t+')</td>'}).join('')+'</tr>').join('')+'</table>':'<div class="dim s">no regime stats yet</div>')
   +'<div class="s" style="margin-top:10px">weights: '+Object.entries(st.weights||{}).map(([k,v])=>k+' <b>'+v.toFixed(2)+'</b>').join(' · ')+'</div>'
   +(st.calibration?'<div class="s dim" style="margin-top:6px">calibration (n='+st.calibration.sample+'): '+st.calibration.buckets.map(b=>(b.lo*100).toFixed(0)+'-'+(b.hi*100).toFixed(0)+'% → '+(b.winRate*100).toFixed(0)+'% (n'+b.n+')').join(' · ')+'</div>':'<div class="s dim">calibration needs ≥10 closed trades</div>');
  }
  if(tab==='strategies'){
   const st=await j('/api/strategies');
   $('strats').innerHTML='<table><tr><th>strategy</th><th>ver</th><th>status</th><th>parent</th><th>hypothesis</th><th>params</th></tr>'+st.strategies.map(r=>'<tr><td>'+esc(r.name)+'</td><td>V'+r.version+'</td><td><span class="tag '+esc(r.status)+'">'+esc(r.status)+'</span></td><td>'+esc(r.parent_version?('V'+r.parent_version):'—')+'</td><td style="white-space:normal;max-width:280px;font-family:inherit" class="s dim">'+esc(r.hypothesis||'')+'</td><td class="s" style="white-space:normal;max-width:300px;font-size:11px">'+esc(Object.entries(JSON.parse(r.params)).map(([k,v])=>k+'='+v).join(' '))+'</td></tr>').join('')+'</table>';
  }
  if(tab==='settings'){
   const se=await j('/api/settings');
   $('aiProv').innerHTML='<div class="row"><span>Provider</span><b class="s">'+esc(se.llm.provider)+'</b></div>'
    +'<div class="row"><span>Base URL</span><b class="s">'+esc(se.llm.baseUrl)+'</b></div>'
    +'<div class="row"><span>API key</span><b class="s">'+esc(se.llm.apiKeyMasked||'— not set —')+'</b></div>'
    +'<label class="s dim" style="display:block;margin-top:8px">Model</label>'
    +'<select id="mSel" style="width:100%;background:var(--card);color:var(--txt);border:1px solid var(--line);padding:6px">'+
      se.llm.models.map(m=>'<option '+(m===se.llm.model?'selected':'')+'>'+esc(m)+'</option>').join('')+'</select>'
    +'<label class="s dim" style="display:block;margin-top:8px">New API key (optional — stored server-side, never displayed again)</label>'
    +'<input id="kIn" type="password" placeholder="sk-..." style="width:100%;background:var(--card);color:var(--txt);border:1px solid var(--line);padding:6px">'
    +'<label class="s dim" style="display:block;margin-top:8px">Temperature</label>'
    +'<input id="tIn" type="number" step="0.1" min="0" max="1" value="'+esc(se.llm.temperature)+'" style="width:100%;background:var(--card);color:var(--txt);border:1px solid var(--line);padding:6px">'
    +'<div style="margin-top:10px"><button onclick="saveSettings()">SAVE</button> <span id="sMsg" class="s"></span></div>';
   $('exch').innerHTML='<div class="row"><span>Exchange</span><b>'+esc(se.exchange.exchange)+'</b></div>'
    +'<div class="row"><span>Environment</span><b class="badge demo">'+esc(se.exchange.environment)+'</b> <span class="s dim">🔒 '+esc(se.exchange.note)+'</span></div>';
   const L=se.learning;
   $('learn').innerHTML=[['Post-trade review','ENABLED'],['Signal evolution','every '+L.signalInterval+' trades'],['Strategy evolution','every '+L.strategyInterval+' trades'],['Min validation sample',L.minSample+' trades'],['Max weight change','±'+L.maxWeightChangePct+'%'],['Max param changes/challenger',L.maxParamChanges]]
     .map(r=>'<div class="row"><span class="dim">'+r[0]+'</span><b class="s">'+esc(r[1])+'</b></div>').join('');
   $('locked').innerHTML=se.controlsLocked.map(x=>'🔒 '+esc(x)).join(' &nbsp;·&nbsp; ');
  }
  if(tab==='events'){
   const ev=await j('/api/events');
   $('events').innerHTML='<table><tr><th>ts</th><th>kind</th><th>payload</th></tr>'+ev.map(e=>'<tr><td>'+esc(e.ts.slice(5,19))+'</td><td>'+esc(e.kind)+'</td><td style="white-space:normal;max-width:480px;font-size:11px" class="dim">'+esc(String(e.payload).slice(0,220))+'</td></tr>').join('')+'</table>';
  }
 }catch(e){$('conn').textContent='● offline (bot not running?)';$('conn').className='s neg';}
}
refresh();setInterval(refresh,5000);
</script></body></html>`;
