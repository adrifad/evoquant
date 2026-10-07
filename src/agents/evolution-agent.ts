// M6 (§34) — Evolution Agent: proposes bounded challengers; NEVER promotes
// (§37). Promotion is deterministic (evaluation/champion-challenger.ts).
import { readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { RoleLlmService } from "../core/llm-role-service.ts";
import type { Store } from "../memory/db.ts";
import { logSystemEvent } from "../memory/db.ts";
import { BASE_STRATEGIES, loadStrategies, saveStrategy, type StrategyParams } from "../strategy/library.ts";
import { regimeStats } from "../memory/regimes.ts";
import type { TradingEngine } from "../memory/engines.ts";

export const ProposalSchema = z.object({
  proposals: z.array(z.object({
    candidate: z.object({ name: z.string(), version: z.number().int().positive() }),
    parent: z.object({ name: z.string(), version: z.number().int().positive() }),
    changes: z.record(z.string(), z.object({ old: z.number(), new: z.number() })),
    hypothesis: z.string().min(5),
    evidence: z.object({ trades_analyzed: z.number().int().nonnegative() }).passthrough(),
    expected_effect: z.string().default(""),
  })).max(2).default([]),
  no_change_reason: z.string().nullable().default(null),
});
export type Proposals = z.infer<typeof ProposalSchema>;

const PARAM_KEYS: Array<keyof StrategyParams> = ["adx_min", "volume_ratio_min", "rsi_min", "rsi_max", "stop_atr", "take_profit_atr"];

// §36 + config constraints: ≤maxChanges params, all numeric, within ±25% of
// parent value, and ONLY whitelisted strategy params (hard limits NEVER, §48).
export function validateProposal(
  p: Proposals["proposals"][number],
  current: StrategyParams,
  maxChanges: number,
): { ok: boolean; reason?: string } {
  if (p.candidate.name !== p.parent.name || p.candidate.version <= p.parent.version) {
    return { ok: false, reason: "candidate must be the next immutable version of its parent" };
  }
  const keys = Object.keys(p.changes);
  if (keys.length === 0 || keys.length > maxChanges) return { ok: false, reason: `changes count ${keys.length} > ${maxChanges}` };
  for (const k of keys) {
    if (!PARAM_KEYS.includes(k as keyof StrategyParams)) return { ok: false, reason: `param ${k} not evolveable (§48/§20)` };
    const ch = p.changes[k]!;
    const cur = current[k as keyof StrategyParams] as number;
    if (ch.old !== cur) return { ok: false, reason: `${k}: proposed old ${ch.old} != current ${cur}` };
    if (!Number.isFinite(ch.new) || Math.abs(ch.new - cur) > Math.abs(cur) * 0.25) return { ok: false, reason: `${k}: change exceeds 25% bound (§36)` };
  }
  return { ok: true };
}

export async function maybeEvolveStrategies(
  root: string, roles: RoleLlmService, store: Store,
  interval: number, maxParamChanges: number, minSample: number, engine: TradingEngine = "SWING_15M",
): Promise<number> {
  const closed = (store.db.prepare("SELECT COUNT(*) c FROM trades WHERE status='CLOSED' AND result_r_basis='NET' AND engine=? AND strategy_core_version=1").get(engine) as { c: number }).c;
  let lastRun = 0;
  for (const row of store.db.prepare("SELECT payload FROM system_events WHERE kind='EVOLUTION' ORDER BY id DESC LIMIT 20").all() as Array<{ payload: string }>) {
    try {
      const p = JSON.parse(row.payload) as { engine?: TradingEngine; tradesAtRun?: number };
      if ((p.engine ?? "SWING_15M") === engine && typeof p.tradesAtRun === "number") { lastRun = p.tradesAtRun; break; }
    } catch { /* ignore malformed payload */ }
  }
  if (closed < Math.max(minSample, interval) || closed - lastRun < interval) return 0;
  const prompt = readFileSync(path.join(root, "prompts/evolution.md"), "utf8");
  const strategies = loadStrategies(store);
  const input = {
    champion_strategies: strategies.filter((s) => s.status === "CHAMPION").map((s) => ({ name: s.name, version: s.version, params: s.params })),
    regime_stats: regimeStats(store, engine),
    lessons_verified: store.db.prepare("SELECT lesson_id,statement,scope_engine,scope_strategy,scope_strategy_version,scope_regime,scope_direction,expectancy_r,observations FROM lessons WHERE status='VERIFIED' AND scope_engine=?").all(engine),
    engine, closed_trades: closed,
    constraints: { max_param_changes: maxParamChanges, minimum_validation_sample: minSample },
  };
  const out = await roles.json("evolution", prompt, JSON.stringify(input), ProposalSchema, "legacy_strategy_evolution");
  store.db.prepare("INSERT INTO system_events(ts,kind,payload) VALUES(?,?,?)").run(
    new Date().toISOString(), "EVOLUTION", JSON.stringify({ engine, tradesAtRun: closed, proposals: out?.proposals?.length ?? 0 }));
  if (!out) return 0;
  let created = 0;
  for (const p of out.proposals) {
    const parent = strategies.find((s) => s.name === p.parent.name && s.version === p.parent.version)
      ?? BASE_STRATEGIES.find((s) => s.name === p.parent.name);
    if (!parent) continue;
    const v = validateProposal(p, parent.params, maxParamChanges);
    if (!v.ok) { logSystemEvent(store, "EVOLUTION_REJECT", { proposal: p, reason: v.reason }); continue; }
    const existingChallenger = strategies.find((s) => s.name === p.parent.name && s.status === "CHALLENGER");
    if (existingChallenger) continue; // one active challenger per strategy (§36)
    const next: StrategyParams = { ...parent.params };
    for (const [k, ch] of Object.entries(p.changes)) (next as unknown as Record<string, number>)[k] = ch.new;
    saveStrategy(store, {
      name: p.candidate.name, version: p.candidate.version, status: "CHALLENGER",
      params: next, allowed_regimes: parent.allowed_regimes,
    }, p.parent.version, p.hypothesis);
    logSystemEvent(store, "CHALLENGER_CREATED", { name: p.candidate.name, version: p.candidate.version, changes: p.changes, hypothesis: p.hypothesis });
    created += 1;
  }
  return created;
}
