// probe4: latency + schema-validity across candidate models (decision prompt)
import { loadRepoEnv, REPO_ROOT } from "../core/env.ts";
import { llmJson } from "../core/llm.ts";
import { DecisionSchema } from "../agents/decision-agent.ts";
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
const models = process.argv.slice(2);
for (const m of models) {
  const t0 = Date.now();
  const out = await llmJson(
    { baseUrl: env.LLM_BASE_URL ?? "", apiKey: env.LLM_API_KEY ?? "", model: m, timeoutMs: 100_000, temperature: 0.2 },
    prompt, JSON.stringify(input), DecisionSchema,
  );
  const ms = Date.now() - t0;
  console.log(m.padEnd(28), `${String(ms).padStart(6)}ms`, out ? `${out.decision} conf=${out.confidence} strat=${out.strategy}` : "NULL");
}
