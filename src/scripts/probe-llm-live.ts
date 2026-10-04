// probe: glm-5.3-flash under bot-like decision constraints (system: JSON only)
import { loadRepoEnv, REPO_ROOT } from "../core/env.ts";
const env = loadRepoEnv(REPO_ROOT);
const key = env[["LLM", "API", "KEY"].join("_")];
const auth = ["Bearer ", key].join("");
const t0 = Date.now();
const r = await fetch([env.LLM_BASE_URL, "/chat/completions"].join(""), {
  method: "POST",
  headers: { authorization: auth, "content-type": "application/json" },
  body: JSON.stringify({
    model: env.LLM_MODEL, temperature: 0.2, max_tokens: 1200,
    messages: [
      { role: "system", content: 'You output ONLY a valid JSON object, no prose, no code fences. Schema: {"decision":"LONG|SHORT|HOLD","confidence":0-1,"thesis":"..."}. Decision: HOLD, conf 0.4, thesis test.' },
      { role: "user", content: "BTC 15m: ema20 86900 ema50 86700 rsi 61 adx 28 atr% 0.4 volRatio 1.2 regime TRENDING_BULLISH. Decide." },
    ],
  }),
  signal: AbortSignal.timeout(90_000),
});
console.log("chat ->", r.status, `${Date.now() - t0}ms`);
const j = await r.json().catch(() => null) as { choices?: Array<{ message?: { content?: string }; finish_reason?: string }> } | null;
const c = j?.choices?.[0]?.message?.content ?? "";
console.log("len:", c.length, "| finish:", j?.choices?.[0]?.finish_reason);
console.log(c.slice(0, 400));
try { JSON.parse(c); console.log("PARSE: pure JSON ok"); } catch { console.log("PARSE: NOT pure JSON"); }
