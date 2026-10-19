# Evolution V3 Gap Report

Audit base: `bc9d04e89f5b43fa4e5ff2ac5bbf79f9f855fad`.

This report separates current implementation from the broader Strategy Intelligence & Evolution V3 objective. Passing tests establish software behavior only; no new historical, out-of-sample, shadow, or Demo performance evidence was available in this worktree.

| Capability | Current state | Evidence / boundary |
|---|---|---|
| Verified closed-trade loss attribution | **Partial** | `/api/loss-attribution` and `src/memory/loss-attribution.ts` aggregate verified NET evidence and expose unavailable causal fields. There is no complete persisted deterministic trade-diagnosis record for every requested cause. |
| Parameter Challenger lifecycle | **Implemented in bounded form** | `src/agents/v2-evolution.ts`, V2 registry, deterministic validation, Critic, walk-forward/history checks, shadow evidence, and atomic promotion are present. This remains parameter evolution, not broad strategy rewriting. |
| Structural research candidates | **Partial / research-only** | `src/strategy/research-v1.ts` and `config/research-strategies.yaml` define Trend Pullback, Breakout Retest, and structural Range Mean Reversion. The configuration states these strategies are not linked to live scanner/execution. |
| Market structure / range context | **Implemented as descriptive research features** | `src/market/market-structure.ts`, `support-resistance.ts`, `range-detector.ts`, and `price-action.ts` provide deterministic context. This patch corrects chronological break classification and active-boundary ownership; it does not establish profitability. |
| Strategy-regime suitability / shadow router | **Missing** | No validated runtime suitability projection or shadow-first multi-strategy router was found in the reviewed runtime path. |
| Hypothesis lifecycle states and evidence provenance | **Partial** | V2 strategy versions retain hypothesis text and validation/shadow status, but the full requested research state machine, validation-window provenance/usage history, and duplicate-rejection lifecycle are not present as one integrated workflow. |
| Purging / embargo and multiple-comparison controls | **Not verified / missing** | Existing chronological, OOS, rolling, and shadow checks are present, but this audit found no comprehensive purging/embargo or multiple-comparison tracking suitable for asserting the full V3 requirement. |
| Scalp-specific evolution and promotion | **Missing** | Scalp has deterministic live signals and verified trade attribution, but it does not use a parallel strategy-family Challenger and promotion lifecycle. |
| Independent performance evidence for the research candidates | **Unavailable** | No reproducible independent OOS or forward Demo evidence was produced in this task. Research candidates remain disabled for live entries. |

## Recommended next increment

Implement deterministic **trade diagnosis v1** as a read-only projection over closed trades with complete, valid NET accounting. Each diagnosis should distinguish directly observed facts from hypotheses, record unavailable inputs explicitly, and be covered by fixtures for partial fills, costs, MFE/MAE, and entry-time feature availability. Persist only after defining an idempotent evidence contract and migration; do not have a Reviewer invent missing market facts. The next separate increment can evaluate diagnosis cohorts across strategy/regime and build an observation-only suitability report. Any router or experimental entry policy should remain disabled until independent OOS and forward evidence plus operator approval exist.
