import { z } from "zod";
import { readFileSync } from "node:fs";
import path from "node:path";
import { llmJson, type LlmConfig } from "../core/llm.ts";
import type { Store } from "../memory/db.ts";
import { logSystemEvent, kvGet, kvSet } from "../memory/db.ts";
import type { TradingEngine } from "../memory/engines.ts";
import { measureContributions } from "../learning/signal-weights.ts";
import { summarize } from "../evaluation/performance.ts";
import { DEFAULT_V2_PARAMS, StrategyV2ParamsSchema, type StrategyV2Id, type StrategyV2Params } from "../strategy/core-v2.ts";
import { createV2Challenger, getV2Champions, listV2Versions, V2_STRATEGIES } from "../strategy/v2-registry.ts";
import { familyForV2 } from "../strategy/identity.ts";

const ProposalSchema = z.object({
  proposals: z.array(z.object({
    strategy: z.enum(["TREND_FOLLOWING_V2", "BREAKOUT_V2", "MEAN_REVERSION_V2"]),
    parent_version: z.number().int().positive(),
    changed_parameter: z.string().min(1),
    old_value: z.number(),
    new_value: z.number(),
    hypothesis: z.string().min(12).max(500),
  }).strict()).max(V2_STRATEGIES.length).default([]),
  no_change_reason: z.string().max(500).nullable().default(null),
}).strict();

export interface V2EvolutionConfig {
  intervalTrades: number;
  minimumSample: number;
  maxParamChanges: number;
  maxParamDeltaPct: number;
}

export interface ClosedEvidence {
  result_r: number; side: "LONG" | "SHORT"; instrument: string; regime: string;
  regime_axes: string | null; exit_reason: string | null; mfe: number | null; mae: number | null;
  entry_px: number | null; initial_stop_px: number | null; entry_ts: string; exit_ts: string;
}

export function getV2EvolutionEvidence(store: Store, strategy: StrategyV2Id, version: number,
  engine: TradingEngine = "SWING_15M"): ClosedEvidence[] {
  return store.db.prepare(`SELECT result_r,side,instrument,regime,regime_axes,exit_reason,mfe,mae,entry_px,initial_stop_px,entry_ts,exit_ts
    FROM trades WHERE status='CLOSED' AND result_r_basis='NET' AND engine=? AND strategy=?
      AND strategy_core_version=2 AND strategy_version=? ORDER BY exit_ts`)
    .all(engine, familyForV2(strategy), version) as ClosedEvidence[];
}

export function evolutionReviewEligible(sample: number, lastReviewed: number, minimumSample: number, interval: number): boolean {
  return sample >= minimumSample && sample - lastReviewed >= interval;
}
export function v2EvolutionStateKey(engine: TradingEngine, strategy: StrategyV2Id, championVersion: number): string {
  return `evolution_v2:${engine}:${familyForV2(strategy)}:core2:v${championVersion}:last_trade_count`;
}

export function validateV2Proposal(input: {
  strategy: StrategyV2Id; parentVersion: number; changedParameter: string; oldValue: number; newValue: number;
}, champion: { version: number; params: StrategyV2Params[StrategyV2Id] }, maxChanges: number, maxDeltaPct: number): {
  ok: boolean; reason?: string; params?: StrategyV2Params[StrategyV2Id];
} {
  const paramKeys = Object.keys(champion.params);
  if (maxChanges < 1 || maxChanges > 1) return { ok: false, reason: "V2 attribution permits exactly one changed parameter per Challenger" };
  if (input.parentVersion !== champion.version) return { ok: false, reason: "proposal parent is not the active Champion" };
  if (paramKeys.length === 0 || !Object.hasOwn(champion.params, input.changedParameter)) {
    return { ok: false, reason: `parameter ${input.changedParameter} does not belong to ${input.strategy}` };
  }
  const oldValue = (champion.params as Record<string, number>)[input.changedParameter];
  if (!Number.isFinite(oldValue) || input.oldValue !== oldValue) return { ok: false, reason: "old value does not match immutable parent" };
  if (!Number.isFinite(input.newValue) || input.newValue === oldValue) return { ok: false, reason: "new value must be finite and different" };
  const floor = Number.isInteger(oldValue) ? 1 : Math.max(0.01, Math.abs(oldValue) * 0.01);
  const maxDelta = Math.max(floor, Math.abs(oldValue) * maxDeltaPct / 100);
  if (Math.abs(input.newValue - oldValue) > maxDelta) return { ok: false, reason: `delta exceeds ${maxDeltaPct}%/minimum step bound` };
  const candidate = { ...champion.params, [input.changedParameter]: input.newValue };
  try {
    const parsed = StrategyV2ParamsSchema.parse({ ...DEFAULT_V2_PARAMS, [input.strategy]: candidate });
    return { ok: true, params: parsed[input.strategy] };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : "parameter violates V2 family bounds" };
  }
}

/** Runs at most once per global tick; it only creates immutable V2 Challenger records. */
export async function maybeEvolveV2Strategies(root: string, cfg: LlmConfig, store: Store,
  evolution: V2EvolutionConfig, engine: TradingEngine = "SWING_15M"): Promise<number> {
  const champions = getV2Champions(store);
  const evidenceByStrategy = new Map<StrategyV2Id, ClosedEvidence[]>();
  const ready: StrategyV2Id[] = [];
  for (const strategy of V2_STRATEGIES) {
    if (listV2Versions(store, strategy).some((version) => version.status === "CHALLENGER" || version.status === "SHADOW")) continue;
    const champion = champions[strategy];
    const evidence = getV2EvolutionEvidence(store, strategy, champion.version, engine);
    evidenceByStrategy.set(strategy, evidence);
    const stateKey = v2EvolutionStateKey(engine, strategy, champion.version);
    const lastCount = Number(kvGet(store, stateKey) ?? "0");
    if (evolutionReviewEligible(evidence.length, lastCount, evolution.minimumSample, evolution.intervalTrades)) ready.push(strategy);
  }
  if (ready.length === 0) return 0;

  logSystemEvent(store, "EVOLUTION_TRIGGERED", { engine, strategies: ready, intervalTrades: evolution.intervalTrades });
  const prompt = readFileSync(path.join(root, "prompts/evolution-v2.md"), "utf8");
  const strategyEvidence = Object.fromEntries(ready.map((strategy) => {
    const champion = champions[strategy];
    const trades = evidenceByStrategy.get(strategy) ?? [];
    const rs = trades.map((trade) => trade.result_r);
    const bySide = Object.fromEntries((["LONG", "SHORT"] as const).map((side) => [side,
      summarize(trades.filter((trade) => trade.side === side).map((trade) => trade.result_r))]));
    const perSymbol = Object.fromEntries([...new Set(trades.map((trade) => trade.instrument))].map((symbol) => [symbol,
      summarize(trades.filter((trade) => trade.instrument === symbol).map((trade) => trade.result_r))]));
    const perRegimeAxes = Object.fromEntries([...new Set(trades.map((trade) => trade.regime_axes ?? trade.regime))].map((axes) => [axes,
      summarize(trades.filter((trade) => (trade.regime_axes ?? trade.regime) === axes).map((trade) => trade.result_r))]));
    const positive = rs.filter((r) => r > 0).length;
    const negative = rs.filter((r) => r < 0).reduce((sum, r) => sum + Math.abs(r), 0);
    const shadows = store.db.prepare(`SELECT COUNT(*) trades,COALESCE(AVG(net_r),0) expectancy_r,
      COALESCE(AVG(mfe_r),0) mfe_r,COALESCE(AVG(mae_r),0) mae_r FROM shadow_trades
      WHERE strategy=? AND strategy_core_version=2 AND strategy_version=? AND shadow_role='CHALLENGER' AND status='CLOSED'`)
      .get(familyForV2(strategy), champion.version) as Record<string, number>;
    return [strategy, {
      champion_version: champion.version, params: champion.params, sample: trades.length,
      performance: summarize(rs), profit_factor: negative > 0 ? rs.filter((r) => r > 0).reduce((a, b) => a + b, 0) / negative : null,
      positive_R_count: positive, by_side: bySide, by_symbol: perSymbol, regime_axes: perRegimeAxes,
      mfe_r_mean: mean(trades.map(normalizedMfe)), mae_r_mean: mean(trades.map(normalizedMae)),
      exit_reasons: countBy(trades.map((trade) => trade.exit_reason ?? "UNKNOWN")),
      signal_contributions: measureContributions(store, engine, {
        strategy: familyForV2(strategy), strategyCoreVersion: 2, strategyVersion: champion.version,
      }),
      shadow_challenger_summary: shadows,
      machine_verified_lessons: [], // Natural-language hypotheses stay provisional until a structured validator exists.
      evidence_cutoff_ts: latestEvidenceExitTs(trades),
    }];
  }));
  const result = await llmJson(cfg, prompt, JSON.stringify({ engine, strategies: strategyEvidence,
    constraints: { max_parameter_changes_per_challenger: evolution.maxParamChanges,
      max_parameter_delta_pct: evolution.maxParamDeltaPct, minimum_closed_trade_sample: evolution.minimumSample } }), ProposalSchema);
  let created = 0;
  for (const strategy of ready) {
    const tradeCount = evidenceByStrategy.get(strategy)?.length ?? 0;
    kvSet(store, v2EvolutionStateKey(engine, strategy, champions[strategy].version), String(tradeCount));
  }
  if (!result || result.proposals.length === 0) {
    logSystemEvent(store, "EVOLUTION_NO_CHANGE", { engine, strategies: ready, reason: result?.no_change_reason ?? "invalid_or_unavailable_model_response" });
    return 0;
  }
  const seen = new Set<StrategyV2Id>();
  for (const proposal of result.proposals) {
    const champion = champions[proposal.strategy];
    const validation = validateV2Proposal({ strategy: proposal.strategy, parentVersion: proposal.parent_version,
      changedParameter: proposal.changed_parameter, oldValue: proposal.old_value, newValue: proposal.new_value },
    champion, evolution.maxParamChanges, evolution.maxParamDeltaPct);
    let reason = validation.reason;
    if (!ready.includes(proposal.strategy)) reason = "strategy has not reached its evolution evidence interval";
    if (seen.has(proposal.strategy)) reason = "only one proposal per strategy family is accepted per cycle";
    if (reason || !validation.params) {
      logSystemEvent(store, "EVOLUTION_PROPOSAL_REJECTED", { engine, proposal, reason: reason ?? "invalid parameter schema" });
      continue;
    }
    seen.add(proposal.strategy);
    try {
      const proposalTrades = evidenceByStrategy.get(proposal.strategy) ?? [];
      const version = createV2Challenger(store, { strategy: proposal.strategy, parentVersion: champion.version,
        params: validation.params, changedParameter: proposal.changed_parameter, oldValue: proposal.old_value,
        newValue: proposal.new_value, hypothesis: proposal.hypothesis,
        evidence: { engine, sample: proposalTrades.length,
          summary: summarize(proposalTrades.map((trade) => trade.result_r)),
          capturedAt: new Date().toISOString(),
          evidenceCutoffTs: latestEvidenceExitTs(proposalTrades) } });
      logSystemEvent(store, "CHALLENGER_CREATED", { engine, strategy: proposal.strategy, version,
        parentVersion: champion.version, changedParameter: proposal.changed_parameter,
        oldValue: proposal.old_value, newValue: proposal.new_value });
      created++;
    } catch (e) {
      logSystemEvent(store, "EVOLUTION_PROPOSAL_REJECTED", { engine, proposal,
        reason: e instanceof Error ? e.message : "immutable registry rejected proposal" });
    }
  }
  if (created === 0 && result.proposals.length > 0) logSystemEvent(store, "EVOLUTION_NO_CHANGE", { engine, strategies: ready, reason: "all proposals rejected" });
  return created;
}

function normalizedMfe(trade: ClosedEvidence): number { const risk = Math.abs(Number(trade.entry_px) - Number(trade.initial_stop_px)); return risk > 0 ? Number(trade.mfe ?? 0) / risk : 0; }
function normalizedMae(trade: ClosedEvidence): number { const risk = Math.abs(Number(trade.entry_px) - Number(trade.initial_stop_px)); return risk > 0 ? Number(trade.mae ?? 0) / risk : 0; }
function latestEvidenceExitTs(trades: ClosedEvidence[]): string | null {
  const valid = trades.map((trade) => trade.exit_ts).filter((ts) => Number.isFinite(Date.parse(ts)));
  return valid.length ? new Date(Math.max(...valid.map(Date.parse))).toISOString() : null;
}
function mean(values: number[]): number { return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0; }
function countBy(values: string[]): Record<string, number> { return values.reduce<Record<string, number>>((out, value) => { out[value] = (out[value] ?? 0) + 1; return out; }, {}); }
