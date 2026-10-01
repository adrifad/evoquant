// probe: replicate llmJson WITHOUT catch to surface the real failure branch
import { loadRepoEnv, REPO_ROOT } from "../core/env.ts";
import { readFileSync } from "node:fs";
import path from "node:path";
import { DecisionSchema } from "../agents/decision-agent.ts";

const env = loadRepoEnv(REPO_ROOT);
const cfg = { baseUrl: env.LLM_BASE_URL ?? "", apiKey: env.LLM_API_KEY ?? "", model: env.LLM_MODEL ?? "" };
const prompt = readFileSync(path.join(REPO_ROOT, "prompts/decision.md"), "utf8");
const input = {
  instrument: "BTC-USDT-SWAP", timeframe: "15m",
  market: { regime: "TRENDING_BULLISH", price: 84700, ema20: 84500, ema50: 84100, emaSpreadPct: 0.48, rsi14: 58, adx14: 29, atr14: 260, atrPct: 0.31, volume_ratio: 1.3 },
  open_position: false,
  enabled_strategies: [{ id: "TREND_FOLLOWING_V1", params: { adx_min: 22, volume_ratio_min: 1.1, rsi_min: 48, rsi_max: 68, stop_atr: 1.5, take_profit_atr: 3 } }],
  strategy_memory: {}, lessons: [],
};
const res = await fetch(`${cfg.baseUrl.replace(/\/$/, "")}/chat/completions`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.apiKey}` },
  body: JSON.stringify({
    model: cfg.model, temperature: 0.2,
    messages: [{ role: "system", content: prompt }, { role: "user", content: JSON.stringify(input) }],
    response_format: { type: "json_object" },
  }),
});
console.log("res.ok:", res.ok, "status:", res.status);
const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
const text = json.choices?.[0]?.message?.content ?? "";
console.log("content len:", text.length);
const start = text.indexOf("{");
const end = text.lastIndexOf("}");
console.log("braces:", start, end);
const parsed: unknown = JSON.parse(text.slice(start, end + 1));
const v = DecisionSchema.safeParse(parsed);
console.log("success:", v.success);
if (!v.success) console.log(JSON.stringify(v.error.issues, null, 1).slice(0, 600));
else console.log(JSON.stringify(v.data).slice(0, 200));
