// probe: raw LLM decision call diagnostics
import { loadRepoEnv, REPO_ROOT } from "../core/env.ts";
import { llmJson } from "../core/llm.ts";
import { DecisionSchema } from "../agents/decision-agent.ts";
import { readFileSync } from "node:fs";
import path from "node:path";

const env = loadRepoEnv(REPO_ROOT);
const cfg = { baseUrl: env.LLM_BASE_URL ?? "", apiKey: env.LLM_API_KEY ?? "", model: env.LLM_MODEL ?? "", timeoutMs: 150_000 };
const prompt = readFileSync(path.join(REPO_ROOT, "prompts/decision.md"), "utf8");
const input = {
  instrument: "BTC-USDT-SWAP", timeframe: "15m",
  market: { regime: "TRENDING_BULLISH", price: 84700, ema20: 84500, ema50: 84100, emaSpreadPct: 0.48, rsi14: 58, adx14: 29, atr14: 260, atrPct: 0.31, volume_ratio: 1.3 },
  open_position: false,
  enabled_strategies: [{ id: "TREND_FOLLOWING_V1", params: { adx_min: 22, volume_ratio_min: 1.1, rsi_min: 48, rsi_max: 68, stop_atr: 1.5, take_profit_atr: 3 } }],
  strategy_memory: {}, lessons: [],
};
console.log("model:", cfg.model);
const out = await llmJson(cfg, prompt, JSON.stringify(input), DecisionSchema);
console.log("result:", JSON.stringify(out));

// also raw fetch to see what the API says
const r = await fetch(`${cfg.baseUrl.replace(/\/$/, "")}/chat/completions`, {
  method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.apiKey}` },
  body: JSON.stringify({ model: cfg.model, messages: [{ role: "user", content: "Reply JSON {\"ok\":true} only" }], response_format: { type: "json_object" } }),
});
console.log("http:", r.status, (await r.text()).slice(0, 400));
