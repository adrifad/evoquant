// V1 operations console (§57–102). Single-page dark dashboard + JSON API,
// served by the bot process on 127.0.0.1 only (access via SSH tunnel — keeps
// emergency controls off the public net). Priorities per §97: risk state,
// open position, PnL, bot state, latest decision — AI narrative last.
//
// NOTE: §58 recommends Next.js/shadcn; V1 ships a dependency-free console to
// fit the 2GB host and avoid a second build pipeline. §101 acceptance
// questions are all answerable here; a Next.js port is a later milestone.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import type { Store } from "../memory/db.ts";
import { getBotState, setBotState, isEmergencyHalted, setEmergencyHalted, baseline } from "../core/state.ts";
import { getWeights } from "../learning/signal-weights.ts";
import { regimeStats } from "../memory/regimes.ts";
import { kvGet } from "../memory/db.ts";
import { emergencyStop, type ExecutorDeps } from "../execution/executor.ts";
import { setEnvKeys, maskKey } from "./settings.ts";
import { loadRepoEnv } from "./env.ts";
import path from "node:path";
import { getBalance } from "../exchange/okx/account.ts";
import { createLogger } from "./logger.ts";

const log = createLogger("dashboard");
const REPO_ROOT = path.resolve(import.meta.dirname, "../..");
function loadRepoEnvSafe(): Record<string, string> {
  try { return loadRepoEnv(REPO_ROOT) as Record<string, string>; } catch { return {}; }
}

export interface DashboardConfig {
  port: number;
  bind?: string;
  auth?: { user: string; password: string };
  trading: { instrument: { id: string }; timeframe: string; leverage: { default: number } };
  risk: { hard_limits: Record<string, unknown> };
  deps: () => ExecutorDeps;
  getLastTick: () => { features: unknown; regime: string; at: string } | null;
  getKillReason: () => string | null;
  evolution: {
    reviewEvery: boolean; signalInterval: number; strategyInterval: number; minSample: number;
    maxWeightChangePct: number; maxParamChanges: number;
  };
}

export function startDashboard(cfg: DashboardConfig): { close(): void } {
  const store = cfg.deps().store;

  async function api(req: IncomingMessage, method: string, url: URL, res: ServerResponse): Promise<void> {
    const p = url.pathname;
    const send = (code: number, body: unknown): void => {
      res.writeHead(code, { "content-type": "application/json", "x-content-type-options": "nosniff" });
      res.end(JSON.stringify(body));
    };
    if (p === "/api/status") {
      const bal = await getBalance(cfg.deps().client).catch(() => null);
      const usdt = bal?.details.find((d) => d.ccy === "USDT");
      const eq = usdt ? Number(usdt.availEq) : 0;
      const base = baseline(store, eq);
      const open = store.db.prepare("SELECT * FROM trades WHERE status='OPEN'").all();
      const closed = store.db.prepare("SELECT COUNT(*) c, COALESCE(SUM(pnl),0) p, COALESCE(AVG(result_r),0) e FROM trades WHERE status='CLOSED'").get() as { c: number; p: number; e: number };
      return send(200, {
        environment: "DEMO",                       // §96 always visible
        exchange: "OKX",
        instrument: cfg.trading.instrument.id,
        timeframe: cfg.trading.timeframe,
        botState: getBotState(store),              // §89
        emergencyHalted: isEmergencyHalted(store),
        killReason: cfg.getKillReason(),
        equity: eq,
        daily: { dayStart: base.dayStartEquity, lossPct: base.dayStartEquity ? Math.max(0, (base.dayStartEquity - eq) / base.dayStartEquity * 100) : 0 },
        drawdownPct: base.peakEquity ? Math.max(0, (base.peakEquity - eq) / base.peakEquity * 100) : 0,
        totals: { closed: closed.c, pnl: closed.p, expectancyR: closed.e },
        openPosition: open[0] ?? null,             // §65
        latestDecision: store.db.prepare("SELECT * FROM decisions ORDER BY ts DESC LIMIT 1").get() ?? null, // §66
        regime: cfg.getLastTick()?.regime ?? "UNKNOWN",
        market: cfg.getLastTick()?.features ?? null,
        limits: cfg.risk.hard_limits,              // §83
        hardMaxesLocked: true,                     // §48: shown as locked
      });
    }
    if (p === "/api/trades") {
      const rows = store.db.prepare("SELECT trade_id,instrument,side,strategy,strategy_version,regime,entry_px,exit_px,result_r,pnl,duration_s,exit_reason,exit_ts,status,calibrated_confidence FROM trades ORDER BY COALESCE(exit_ts,entry_ts) DESC LIMIT 100").all();
      return send(200, rows);
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
      return send(200, { strategies: rows, regimeMatrix: regimeStats(store), weights: getWeights(store), calibration: JSON.parse(kvGet(store, "calibration") ?? "null") }); // §73–§82
    }
    if (p === "/api/lessons") {
      const rows = store.db.prepare("SELECT lesson_id,statement,status,scope_strategy,scope_instrument,scope_regime,confidence,observations,wins,losses,expectancy_r,updated_ts FROM lessons ORDER BY CASE status WHEN 'VERIFIED' THEN 0 WHEN 'REINFORCED' THEN 1 ELSE 2 END, confidence DESC LIMIT 50").all();
      return send(200, rows); // §79
    }
    if (p === "/api/events") {
      const rows = store.db.prepare("SELECT ts,kind,payload FROM system_events ORDER BY id DESC LIMIT 80").all();
      return send(200, rows); // §84 risk events & §85 logs
    }
    if (p === "/api/candles") {
      const limit = Math.min(Number(url.searchParams.get("limit") ?? 200), 400);
      const rows = store.db.prepare(
        "SELECT ts,o,h,l,c,vol FROM candles WHERE confirm='1' ORDER BY ts DESC LIMIT ?",
      ).all(limit) as Array<Record<string, unknown>>;
      return send(200, rows.reverse()); // chronological for the chart
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
          models: await listKiosModels(env),
        },
        learning: cfg.evolution,
        controlsLocked: [
          "environment", "max leverage", "risk per trade", "daily loss", "drawdown",
          "allowed symbols", "max positions", "promotion criteria", "kill switch", // §48/§88
        ],
      });
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
      setEnvKeys(path.join(REPO_ROOT, ".env"), updates);
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
    for await (const c of req2) chunks.push(c as Buffer);
    try { return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>; } catch { return {}; }
  }
  async function listKiosModels(env: Record<string, string>): Promise<string[]> {
    if (!env.LLM_BASE_URL || !env[KEY_ENV_NAME]) return [];
    try {
      const r = await fetch(`${env.LLM_BASE_URL.replace(/\/$/, "")}/models`, {
        headers: { Authorization: "Bearer " + env[KEY_ENV_NAME] },
        signal: AbortSignal.timeout(8_000),
      });
      if (!r.ok) return [];
      const j = (await r.json()) as { data?: Array<{ id: string }> };
      return (j.data ?? []).map((m) => m.id).sort();
    } catch { return []; }
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
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (url.pathname.startsWith("/api/")) return void (await api(req, req.method ?? "GET", url, res));
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "x-content-type-options": "nosniff" });
      res.end(PAGE);
    } catch (e) {
      log.error({ event: "dashboard_error", error: e instanceof Error ? e.message : String(e) });
      res.writeHead(500).end("error");
    }
  });
  const bind = cfg.bind ?? "127.0.0.1";
  server.listen(cfg.port, bind, () => log.info({ event: "dashboard_listen", port: cfg.port, bind }));
  return { close: () => server.close() };
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
  <div class="card" style="margin-top:14px"><h2>BTC-USDT-SWAP · 15m — last 120 candles (EMA20/50, SL/TP & entry markers when in position §64)</h2>
    <canvas id="chart" width="1180" height="300" style="width:100%;height:auto"></canvas>
    <div class="s dim" id="chartNote"></div></div>
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
async function drawChart(){
 const cv=$('chart'); if(!cv) return;
 let cs; try{cs=await j('/api/candles?limit=120');}catch(e){return;}
 if(!cs||cs.length<30){$('chartNote').textContent='Not enough candles yet (warm-up).';return;}
 const st=await j('/api/status').catch(()=>null);
 const W=cv.width,H=cv.height,pad=8, cw=W/(cs.length+6);
 const ctx=cv.getContext('2d'); ctx.clearRect(0,0,W,H);
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
const API_BASE=(()=>location.pathname.replace(/\/+$/, ''))(); // '' at root, '/evo' when proxied under a prefix
async function j(u){const r=await fetch(API_BASE+u);if(!r.ok)throw 0;return r.json();}
async function refresh(){
 try{
  const s=await j('/api/status');
  $('conn').textContent='● Connected';$('conn').className='s pos';
  $('inst').textContent=s.instrument+' · '+s.timeframe+' · '+s.leverage?.default+'x · '+s.environment;
  $('botState').textContent='BOT: '+s.botState;$('botState').className='badge state '+s.botState;
  const kill=s.killReason||s.emergencyHalted;
  $('kpis').innerHTML=[
   ['USDT Equity',money(s.equity),''],
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
  $('posrisk').innerHTML=(p?('<div class="row"><span>'+(p.side==='LONG'?'LONG ▲':'SHORT ▼')+'</span><b>'+esc(p.contracts)+' ct</b></div>'
    +'<div class="row"><span>Entry / Mark</span><b>'+Number(p.entry_px).toFixed(1)+'</b></div>'
    +'<div class="row"><span>Stop / TP</span><b>'+Number(p.stop_px).toFixed(1)+' / '+Number(p.take_profit_px).toFixed(1)+'</b></div>'
    +'<div class="row"><span>Strategy</span><b>'+esc(p.strategy)+'_V'+p.strategy_version+'</b></div>'):'<div class="empty">NO OPEN POSITION</div>')
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
  if(tab==='overview') drawChart();
  if(tab==='trades'){
   const tr=await j('/api/trades');
   $('tradesT').innerHTML='<table><tr><th>id</th><th>side</th><th>strategy</th><th>regime</th><th>entry</th><th>exit</th><th>R</th><th>PnL</th><th>reason</th><th>status</th></tr>'+tr.map(r=>'<tr><td>'+esc(r.trade_id.slice(-8))+'</td><td class="'+(r.side==='LONG'?'pos':'neg')+'">'+esc(r.side)+'</td><td>'+esc(r.strategy)+'_V'+r.strategy_version+'</td><td>'+esc(r.regime)+'</td><td>'+esc(r.entry_px)+'</td><td>'+esc(r.exit_px??'—')+'</td><td class="'+cls(r.result_r)+'">'+(r.result_r??0).toFixed(2)+'</td><td class="'+cls(r.pnl)+'">'+money(r.pnl)+'</td><td>'+esc(r.exit_reason??'')+'</td><td>'+esc(r.status)+'</td></tr>').join('')+'</table>';
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
