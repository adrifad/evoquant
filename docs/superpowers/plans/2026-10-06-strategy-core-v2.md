# Strategy Core V2 and Learning Isolation Implementation Plan

> **For agentic workers:** Inline implementation is requested. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Establish an auditable, engine-scoped deterministic strategy pipeline whose live and historical evaluation share setup, geometry, lifecycle, and cost assumptions, without weakening existing Demo or risk controls.

**Architecture:** Preserve V1 registry history and exchange execution while adding immutable V2 strategy definitions and a pure candidate evaluator. Persist engine ownership on every trade, route swing and scalp through the same global entry-risk boundary, reduce V2 entry LLM authority to a fail-closed veto, and scope learning/evaluation by engine and version. Historical evaluation uses paginated cached candles, conservative OHLC fill ordering, explicit costs, and multi-symbol walk-forward evidence; promotion remains deterministic and evolution is configurable/freezeable.

**Tech Stack:** Existing strict TypeScript/NodeNext, Zod/YAML, better-sqlite3, OKX Demo client, and `node:test`; no trading-mode or exchange-client changes.

---

## Source map and constraints

- `src/memory/db.ts`, `src/memory/trades.ts`: additive SQLite migrations, engine-aware trade persistence, decision linkage, and versioned dimension queries. Migrations must be idempotent and preserve all historical rows.
- `src/market/features.ts`, `src/market/regime.ts`: only add deterministic features used by V2; expose trend and volatility independently while preserving V1 regime strings for old records and APIs.
- `src/strategy/library.ts`, `src/strategy/scanner.ts`, new `src/strategy/core-v2.ts`: retain V1 scorer; add discriminated immutable family params, auditable conditions, candidate selection, and shared V2 setup evaluation.
- `src/agents/decision-agent.ts`, `src/agents/scalp-agent.ts`, prompts: V2 gate can only ALLOW/DENY the fixed candidate; unavailable/invalid means DENY. No gate output changes side, strategy, or geometry.
- `src/execution/executor.ts`, `src/scalp/runner.ts`, new `src/risk/global-entry-gate.ts`: persist one decision ID per order, enforce engine ownership, global state/risk on both engines, and keep existing exchange-native protection/race guards.
- `src/learning/*`, `src/memory/lessons.ts`, `src/memory/regimes.ts`: dimension queries include engine, strategy version, side, regime, instrument; weight evidence is side-aligned net R with sample and delta bounds; confidence/lesson samples stay scoped.
- `src/evaluation/*`, `src/exchange/okx/market.ts`: shared candidate evaluator, fee/slippage/spread costs, conservative stop-first OHLC fills, SL+ and time-stop simulation, fold diagnostics, cached paginated history, and per-symbol/aggregate comparisons.
- `config/*.yaml`, `src/core/config.ts`, `src/core/main.ts`, `src/agents/reviewer-agent.ts`, `src/core/dashboard.ts`: non-destructive baseline-mode flags, conservative evidence schedule, richer review context and additive observability payloads.
- Tests: extend existing `tests/m2-core.test.ts`, `tests/m6-advanced.test.ts`, `tests/scalp.test.ts`; add focused strategy-core, migration, engine ownership, candidate-gate, cost/backtest, and backfill pagination tests as needed.

## Phase 1: Correctness, ownership, and safe migration

- [ ] Add idempotent `trades.engine` migration; deterministically backfill legacy `timeframe='scalp'` rows to `SCALP_5M`, all other rows to `SWING_15M`, retaining original timeframe and every row.
- [ ] Add optional engine to `openTrade`, infer only for legacy callers, and persist explicit `SWING_15M`/`SCALP_5M` for all new entries.
- [ ] Fix swing executor to allocate one decision ID and reuse it for `recordDecision` and `openTrade`; record scalp decision before opening and link its exact ID.
- [ ] Add pure ownership filters so the swing manager never makes discretionary decisions for scalp rows and ScalpRunner only applies scalp lifecycle to its engine; retain global risk/emergency actions.
- [ ] Add regression tests for migration idempotence/history preservation, engine tagging, both decision links, and cross-engine manager exclusions.

## Phase 2: Shared global risk gate and deterministic candidate model

- [ ] Extract reusable global pre-entry evaluation for bot state, emergency halt, API/account certainty, reconciliation, daily loss, drawdown, open-position cap, and occupied instrument; have swing and scalp call the same function before any gate or order.
- [ ] Add deterministic FeatureSnapshot fields only where used (`ema20SlopePct`, EMA extension distance, candle body/range) and introduce a compatibility-preserving `{trend, volatility}` regime projection.
- [ ] Add family-specific V2 params and `TradeCandidate`/condition result types. Implement trend continuation, true N-bar breakout with anti-chase, and sideways mean-reversion with reclaim confirmation as pure evaluators.
- [ ] Refactor scanner to return explainable accepted/rejected candidates with conditions and setup quality; rank only valid candidates. Keep the V1 scorer and persisted versions unchanged.
- [ ] Add deterministic unit tests for required LONG/SHORT setup, mandatory-condition rejects, breakout geometry/anti-chase, and mean-reversion confirmation/trend rejection.

## Phase 3: Candidate gate, deterministic geometry, and lifecycle parity

- [ ] Add strict V2 LLM gate schema (`ALLOW|DENY`, confidence, reasoning, risk flags); malformed/unavailable response denies. Bind prompt input to candidate ID/fingerprint and reject any direction/strategy/stop/target fields.
- [ ] Route configured V2 entries from candidate side/strategy/version/stop/target only; run deterministic risk and sizing afterward. Keep V1 compatibility explicit and prevent V2 candidate changes from changing V1 historical rows.
- [ ] Disable AI-managed closes for V2; retain SL/TP, SL+, time stop, and risk close as separately recorded deterministic exit reasons.
- [ ] Add exit-policy simulator shared between backtest and V2 lifecycle with stop-first same-candle resolution, fee/spread/slippage assumptions, and the live SL+ activation/lock-in rule.
- [ ] Add tests proving LLM cannot flip side/change geometry, invalid gates fail closed, identical candle/config input is deterministic, costs lower net results, SL+ and time stops match the shared simulator, and same-candle SL/TP resolves conservatively.

## Phase 4: Isolated learning, review, and statistics

- [ ] Scope signal-weight contribution/update by engine and use `clamp(result_r) × side-aligned directional feature`; require configured minimum sample, bound outlier influence/weight/delta, persist before/after/sample/contribution/engine/timestamp.
- [ ] Scope calibration tables and calibrate calls by engine plus strategy family when enough observations exist; use identity fallback until the scoped minimum is met.
- [ ] Make regime/performance queries group by engine, strategy, strategy version, regime, side, and instrument; preserve existing endpoint keys while adding richer nested/versioned dimensions.
- [ ] Extend lesson and evidence scope with engine, strategy version, instrument, regime, and direction; validation only consumes evidence matching every populated scope; leave unsupported semantic candidates provisional.
- [ ] Extend reviewer input with engine, entry conditions, MFE_R/MAE_R, fees, net R, exit reason and regime; reviewer remains observations/candidate-hypotheses only.
- [ ] Add short/long contribution symmetry, R-magnitude/outlier, sample threshold, engine isolation, version separation, scoped confidence, lesson-scope, and reviewer non-authority tests.

## Phase 5: Historical evidence, multi-symbol evaluation, and frozen evolution

- [ ] Add bounded OKX history pagination respecting endpoint page limits and `after`/`before` cursor semantics; cache confirmed candles in SQLite and resume backfill without deleting/rewriting existing history.
- [ ] Evaluate champion/challenger over configured symbols using identical windows and shared V2 evaluators; persist per-symbol, per-regime, per-fold, and aggregate net metrics.
- [ ] Require configured sample, positive aggregate net expectancy, stable majority folds, acceptable worst fold/drawdown, and multi-symbol robustness before deterministic promotion; do not use win rate as the primary criterion.
- [ ] Add `validation.baseline_mode` as an opt-in runtime overlay: disable scalp, weight/strategy evolution and auto-promotion, and cap swing positions to one without rewriting normal trading/risk YAML or relaxing hard limits.
- [ ] Raise default learning/evolution minimum evidence conservatively; make enable/freeze switches deterministic and add `evolution_frozen`/`evolution_resumed` audit events.
- [ ] Add pagination/caching, multi-symbol aggregation, walk-forward dispersion, freeze/resume, and no-in-place-version-mutation tests.

## Verification and scope review

- [ ] Read applicable sections of `docs/EVOQUANT_SPEC.md` alongside existing source behavior; do not modify OKX demo guards, exchange reconciliation, order sizing hard maxima, protective orders, race guard, or secret redaction.
- [ ] Run `npm run typecheck`, `npm test`, `npm --prefix apps/console run typecheck`, and `npm --prefix apps/console run build`.
- [ ] Inspect final diff and migration tests; report backtest limitations and explicitly distinguish static/unit evidence from Demo-forward profitability.

