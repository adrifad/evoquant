# Strategy Core V2 evolution and validation

## Runtime selection

`strategy_core.version` selects V1 or V2 independently from
`validation.baseline_mode`. V2 is the shipped default. V2 uses the persisted
Champion parameter set for each strategy family; V1 continues to use the
existing V1 registry and scorer. `scalp.enabled` remains an independent
setting. Baseline mode is an overlay: it freezes learning/evolution/promotion,
turns off scalp, and limits concurrent positions to one without changing the
selected strategy core.

Every V2 candidate is produced by the same pure setup evaluator used by V2
backtests and shadow simulation. Mandatory setup conditions decide whether a
candidate exists. Engine/strategy/version-scoped signal weights can adjust
quality ranking only after all mandatory conditions pass; they cannot change
side, geometry, or a failed condition. The LLM only returns ALLOW or DENY for
the precomputed candidate. It cannot select direction, parameters, size,
leverage, or promotion.

## Proposal cadence and immutable versions

The V2 Evolution Agent reads net, engine- and version-scoped trade evidence,
including side, symbol, regime axes, exit reason, MFE/MAE, performance and
signal contributions. It may propose at most one existing parameter for a
family per Challenger. Each family is parsed with its own strict Zod schema,
existing hard bounds, exact parent value, and a bounded per-cycle delta.
Invalid or cross-family parameter names are recorded as rejected proposals.

V2 definitions live in `strategy_v2_versions`, separate from the V1
`strategy_versions` registry. A SQLite trigger prevents edits to a definition
after insertion. Lifecycle/evidence fields may change, but params, parent,
changed parameter, and initial hypothesis do not. Existing V2 v2 definitions
from the old registry are imported only when their family schema validates;
V1-shaped rows are not reinterpreted.

Default proposal/evidence schedule:

- Signal weights: inspect every 8 scoped closed trades; do not update before 20 observations; max weight step 5%.
- Strategy hypothesis: the first family review becomes eligible at 20 scoped closed trades, then every 15 additional trades (20, 35, 50, ...), with one parameter per Challenger.
- Historical gate: at least 50 candidate trades, at least 15 trailing OOS trades, configured walk-forward folds, and at least four aligned symbols.
- Shadow-forward gate: at least 15 closed Challenger Shadow trades and 15 closed Champion Shadow trades for the same persisted engine/family/parent/challenger experiment.

The family schema and constraints remain the deterministic authority. The
Evolution Agent cannot change hard risk, trading mode, symbols, execution,
costs, or promotion criteria. Reviewer natural-language lessons remain
provisional and are not fed into parameter mutation until a structured
machine-verifiable validator exists.

## Validation lifecycle

```text
CHAMPION
   └─ proposal → CHALLENGER
                    ├─ insufficient data → remain CHALLENGER
                    ├─ historical/OOS/WF/symbol failure → REJECTED
                    └─ all historical gates pass → SHADOW
                                                ├─ insufficient forward sample → remain SHADOW
                                                ├─ forward/risk gate fails → REJECTED
                                                └─ all gates pass → CHAMPION
```

Historical gates compare Champion and Challenger with `backtestV2()` and
`rollingForwardRobustnessV2()` over identical per-symbol windows and costs.
This is sequential fixed-parameter forward-fold robustness, not rolling
parameter fitting. Data is cut off after the latest closed trade used to create
the proposal; remaining aligned history is split into a pre-OOS validation
segment and a trailing untouched OOS segment. These segments do not overlap.
Where a full independent post-hypothesis dataset is unavailable, the cutoff and
sample limitation are reported rather than treating live evidence as
independent. A candidate needs positive net expectancy, better train and OOS
expectancy than Champion, non-materially worse drawdown, majority-positive
symbols, and majority-positive valid forward folds with a non-worse fold mean.
Too little data leaves it awaiting evidence; it does not cause rejection or
promotion.

After historical validation, the Challenger enters shadow-forward and persists
one `shadow_started_ts` boundary. From that same boundary, Champion Shadow and
Challenger Shadow receive the same confirmed candles and V2 evaluator. Neither
path calls the LLM or exchange order APIs. A signal is recorded as pending at
the close and simulated at the next available candle open; actual-fill
differences remain an exchange-vs-model limitation. Stops,
targets, close-derived SL+, time stops, conservative same-candle stop-first
ordering, and the cost assumptions are simulated deterministically. Shadow
records are stored only in `shadow_trades`, explicitly tagged with role and
experiment ID; they are not real trades, orders, equity, balance, risk state,
or live position slots. If a variant is occupied at cycle start, an exit on that
candle cannot trigger a replacement signal until the next confirmed candle.

Only after both forward samples meet their thresholds can deterministic code
promote. Shadow net expectancy must be positive and beat matched Champion Shadow
net expectancy, positive-symbol fraction must meet its threshold, and drawdown
may not degrade beyond the configured tolerance. Actual Champion Demo results
remain separately observable as an execution-sanity metric. LLM output never
promotes. If automatic promotion is disabled, shadow evidence continues to be
collected but versions remain unpromoted.

## Cost and fill assumptions

`calculateExecutionCostR()` charges entry fee against entry notional and exit
fee against exit notional exactly once. Spread and slippage are charged once
per side against that side's notional, and total execution cost is normalized
by initial price risk. Defaults are 0.05% fee per side, 1.5 bps spread per
side, and 1.5 bps slippage per side; see `config/evaluation.yaml` for runtime
values. Promotion compares net metrics.

Backtest and shadow signal at confirmed close and model entry at the next
candle open. If a candle touches both stop and target, stop resolves first;
gaps through stops use the worse open. SL+ is calculated from the candle's
favorable excursion and close and applies from the next modeled candle. Live
uses mark/tick updates and the actual exchange fill, so this is conservative
candle-level parity, not tick-exact equivalence. Historical and shadow runners
receive each instrument's `tickSz` for SL+ stop rounding; initial stop/target
trigger serialization still follows the existing OKX adapter precision and is
not yet fully reproduced as exchange-tick rounding in the candle simulator.
Funding is not modeled.

## Observability

`/api/strategies` and `/api/evolution` add strategy-core/baseline state, the V2
version registry, shadow trade records/aggregates, and lifecycle events such
as `EVOLUTION_TRIGGERED`, `EVOLUTION_PROPOSAL_REJECTED`,
`CHALLENGER_HISTORICAL_PASS`, `CHALLENGER_HISTORICAL_FAIL`,
`CHALLENGER_SHADOW_STARTED`, `CHALLENGER_SHADOW_PROGRESS`, `PROMOTION`, and
`PROMOTION_REJECTED`. These are additive API fields.

Synthetic tests validate determinism, bounds and isolation only. They do not
prove statistical significance, OKX Demo runtime behavior, or profitability.
