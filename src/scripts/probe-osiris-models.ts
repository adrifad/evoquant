// probe: which osiris models can actually complete a chat? (bulk check)
import { loadRepoEnv, REPO_ROOT } from "../core/env.ts";
const env = loadRepoEnv(REPO_ROOT);
const base = env.LLM_BASE_URL;
const key = env[["LLM", "API", "KEY"].join("_")];

const j = await (await fetch(`${base}/models`, { headers: { authorization: `Bearer ${key}` } })).json() as { data: Array<{ id: string }> };
const ids = j.data.map((x) => x.id);
console.log("ALL:", ids.join(", "));

const candidates = ids.filter((i) => /minimax|glm|qwen|deepseek|kimi|flash/i.test(i)).slice(0, 12);
for (const m of candidates) {
  const t0 = Date.now();
  try {
    const r = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ model: m, max_tokens: 24, messages: [{ role: "user", content: 'Reply ONLY JSON {"ok":true}' }] }),
      signal: AbortSignal.timeout(25_000),
    });
    const txt = await r.text();
    const good = r.status === 200 && !txt.includes("error");
    console.log(m.padEnd(30), r.status, `${Date.now() - t0}ms`, good ? "USABLE" : txt.slice(0, 90));
  } catch (e) {
    console.log(m.padEnd(30), "EXC", (e as Error).message.slice(0, 60));
  }
}
