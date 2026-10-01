// probe: raw decision call with diagnostics
import { loadRepoEnv, REPO_ROOT } from "../core/env.ts";
import { readFileSync } from "node:fs";
import path from "node:path";

const env = loadRepoEnv(REPO_ROOT);
const prompt = readFileSync(path.join(REPO_ROOT, "prompts/decision.md"), "utf8");
const input = {
  instrument: "BTC-USDT-SWAP", timeframe: "15m",
  market: { regime: "TRENDING_BULLISH", price: 84700, ema20: 84500, ema50: 84100, emaSpreadPct: 0.48, rsi14: 58, adx14: 29, atr14: 260, atrPct: 0.31, volume_ratio: 1.3 },
  open_position: false,
  enabled_strategies: [{ id: "TREND_FOLLOWING_V1", params: { adx_min: 22, volume_ratio_min: 1.1, rsi_min: 48, rsi_max: 68, stop_atr: 1.5, take_profit_atr: 3 } }],
  strategy_memory: {}, lessons: [],
};
const r = await fetch(`${(env.LLM_BASE_URL ?? "").replace(/\/$/, "")}/chat/completions`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.LLM_API_KEY}` },
  body: JSON.stringify({
    model: env.LLM_MODEL, temperature: 0.2,
    messages: [{ role: "system", content: prompt }, { role: "user", content: JSON.stringify(input) }],
    response_format: { type: "json_object" },
  }),
});
const text = await r.text();
console.log("HTTP", r.status);
console.log(text.slice(0, 1200));
