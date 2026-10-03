// probe: osiris provider — list models + one decision-schema call, latency measured
import { loadRepoEnv, REPO_ROOT } from "../core/env.ts";
const env = loadRepoEnv(REPO_ROOT);
const base = env.LLM_BASE_URL;
const key = env[["LLM", "API", "KEY"].join("_")];
const model = env.LLM_MODEL;

const r = await fetch(`${base}/models`, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15_000) });
console.log("GET /models ->", r.status);
if (r.ok) {
  const j = await r.json() as { data?: Array<{ id: string }> };
  const ids = (j.data ?? []).map((x) => x.id);
  console.log("models count:", ids.length, "| has minimax-m2.7:", ids.some((i) => i.includes("minimax")));
}

const t0 = Date.now();
const c = await fetch(`${base}/chat/completions`, {
  method: "POST",
  headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
  body: JSON.stringify({
    model, temperature: 0.2,
    messages: [
      { role: "system", content: 'Reply ONLY with JSON {"ok":true,"say":"PONG_OSIRIS"}' },
      { role: "user", content: "ping" },
    ],
  }),
  signal: AbortSignal.timeout(60_000),
});
console.log("chat ->", c.status, `${Date.now() - t0}ms`);
const txt = await c.text();
console.log(txt.slice(0, 300));
