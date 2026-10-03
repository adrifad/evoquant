// probe one model on the CURRENT kiosapi key: list check + real decision-shaped call
import { loadRepoEnv, REPO_ROOT } from "../core/env.ts";
import { readFileSync } from "node:fs";
const env = loadRepoEnv(REPO_ROOT);
const key = env[["LLM", "API", "KEY"].join("_")];
const want = process.argv[2] ?? "";

const ml = await fetch(`${env.LLM_BASE_URL}/models`, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15_000) });
const ids = ml.ok ? ((await ml.json() as { data?: Array<{ id: string }> }).data ?? []).map((x) => x.id) : [];
console.log("GET /models:", ml.status, "| available:", ids.join(", ") || "(list fail)");
if (want && !ids.includes(want)) console.log(`NOTE: "${want}" not in model list`);

const sys = readFileSync(`${REPO_ROOT}/prompts/decision.md`, "utf8");
const input = JSON.stringify({
  instrument: "BTC-USDT-SWAP", timeframe: "15m", ts: new Date().toISOString(), regime: "TRENDING_BEARISH",
  features: { price: 84500, ema20: 84620, ema50: 84900, emaSpreadPct: -0.33, rsi14: 41, adx14: 24, atr14: 300, atrPct: 0.35, volumeRatio: 1.18 },
  open_position: false, enabled_strategies: [{ id: "TREND_FOLLOWING_V1", params: { adx_min: 22, volume_ratio_min: 1.1, stop_atr: 1.5, take_profit_atr: 3.0 } }],
  strategy_memory: [], lessons: [],
});
for (const m of want ? [want] : ids.slice(0, 3)) {
  const t0 = Date.now();
  try {
    const r = await fetch(`${env.LLM_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ model: m, temperature: 0.2, messages: [{ role: "system", content: sys }, { role: "user", content: input }], response_format: { type: "json_object" } }),
      signal: AbortSignal.timeout(110_000),
    });
    const txt = await r.text();
    const dur = Math.round((Date.now() - t0) / 1000);
    if (r.status !== 200) { console.log(m.padEnd(24), r.status, `${dur}s`, txt.slice(0, 90)); continue; }
    const j = JSON.parse(txt) as { choices?: Array<{ message?: { content?: string } }> };
    const c = j?.choices?.[0]?.message?.content ?? "";
    let jsonOk = "NOT-JSON";
    try { const p = JSON.parse(c.slice(c.indexOf("{"), c.lastIndexOf("}") + 1)); jsonOk = `${p.decision} conf=${p.confidence} stop=${p.suggested_stop_atr}`; } catch { /* keep */ }
    console.log(m.padEnd(24), 200, `${dur}s`, jsonOk);
  } catch (e) {
    console.log(m.padEnd(24), "EXC", (e as Error).name, `${Math.round((Date.now() - t0) / 1000)}s`);
  }
}
