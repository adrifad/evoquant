// one-off: why no trades yet — dump decision stats from trader.db
import { openStore } from "../memory/db.ts";
import { REPO_ROOT } from "../core/env.ts";

const store = openStore(REPO_ROOT);
const dec = store.db.prepare(`
  SELECT decision, regime, raw_confidence, calibrated_confidence, risk_verdict, ts
  FROM decisions ORDER BY ts DESC LIMIT 15`).all() as Array<Record<string, unknown>>;

for (const d of dec) {
  const v = JSON.parse(String(d.risk_verdict ?? "{}")) as { reason?: string };
  console.log(
    String(d.ts).slice(5, 16), String(d.decision).padEnd(6), String(d.regime).padEnd(16),
    "conf " + (Number(d.raw_confidence) || 0).toFixed(2), "→", v.reason ?? "?",
  );
}

const agg = store.db.prepare(`
  SELECT decision, COUNT(*) n FROM decisions GROUP BY decision ORDER BY n DESC`).all() as Array<{ decision: string; n: number }>;
console.log("\ntotals:", agg.map((a) => `${a.decision}=${a.n}`).join("  "));

const reasons = new Map<string, number>();
for (const d of store.db.prepare("SELECT risk_verdict FROM decisions").all() as Array<{ risk_verdict: string }>) {
  const r = (JSON.parse(d.risk_verdict) as { reason?: string }).reason ?? "?";
  reasons.set(r, (reasons.get(r) ?? 0) + 1);
}
console.log("verdicts:", [...reasons.entries()].map(([k, v]) => `${k}=${v}`).join("  "));

const t = store.db.prepare("SELECT COUNT(*) n FROM trades").get() as { n: number };
console.log("trades:", t.n);

const regime = store.db.prepare("SELECT regime, COUNT(*) n FROM decisions GROUP BY regime ORDER BY n DESC").all() as Array<{ regime: string; n: number }>;
console.log("regimes seen:", regime.map((r) => `${r.regime}=${r.n}`).join("  "));

const closed = store.db.prepare("SELECT COUNT(*) n FROM decisions WHERE ts > strftime('%Y-%m-%dT%H:00:00','now')").get() as { n: number };
console.log("decisions this hour:", closed.n);
store.close();
