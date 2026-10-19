# Market Intelligence V1 — Research and Diagnostic Contract

## Scope

The first market-intelligence layer is deterministic and descriptive. It is exposed through `GET /api/market-intelligence` and consumes only confirmed candles already persisted in SQLite. Missing or stale history is reported as unavailable; this path does not fetch substitute live candles.

This release does not wire structure, zones, range state, or candle patterns into entry eligibility. Existing Swing and Scalp strategy conditions, scores, risk checks, and execution remain the only entry authority. Trend Pullback and Breakout Retest remain research evaluators, not live strategies.

## Confirmed market structure

`src/market/market-structure.ts` uses strict local extrema with configurable left/right bars. A pivot is recorded only at the timestamp of the rightmost confirming bar. The pivot keeps its source candle timestamps and algorithm version. HH/HL/LH/LL comparisons are emitted as confirmation-time events; a close-through structure event is recorded only on a later confirmed candle. Evaluating a historical prefix cannot use bars beyond that prefix.

The current implementation is a bounded pivot model, not a complete market-structure ontology. Equal-high/low plateaus do not create pivots, and no claim is made that a structure event predicts an outcome.

## Support/resistance zones

Zones cluster confirmed pivot highs or lows within an ATR-scaled tolerance. Repeated pivots count only when confirmation indices are separated by the configured minimum number of bars. The output contains a bounded set of confirmed zones, touch count, age, average rejection distance in ATR units, and whether the latest close crossed the zone. It intentionally does not label zones as "strong" based on touch count alone.

## Structural range assessment

The range snapshot requires two distinct boundaries, repeated separated pivot reactions, sufficient observation duration, a width inside configured ATR bounds, and no confirmed close beyond a boundary tolerance. A boundary break is reported as `TRANSITION`. `RANGE_CANDIDATE` means evidence is incomplete; it is not a trade instruction. The classifier is stateless and therefore does not claim persistent hysteresis. A future stateful labeler needs durable, timestamped evidence and separate validation before use.

Range width after fees/spread is checked by the `MEAN_REVERSION_RANGE_V1` research evaluator, but is not an entry filter. The evaluator has fixture coverage only; no historical range-strategy comparison or profitability claim is included in this release.

## Price action

The candle descriptor reports wick/body ratios, body strength, rejection, engulfing, close breakout, and wick-only false breakout. Breakout-retest and pullback helpers accept only confirmed candles supplied up to the caller's evaluation time. `entrySignal` is always false: features do not authorize trades.

## Research evaluator timing

Trend Pullback V1 and Breakout Retest V1 filter input candles to `confirm='1'` and `candle.ts <= FeatureSnapshot.ts`. Their backtest enters at the next confirmed candle open and resolves same-candle stop/target ambiguity against the stop first. Costs use the existing V2 cost model. These deterministic simulations do not replay LLM Gate decisions or guarantee live fill equivalence.

## Evidence and rollout

Current database history and shadow evidence were not used to claim that any new feature improves net expectancy. The console/API output is diagnostic only. No new entry-routing flag was added because none of these features is connected to the live entry path. To roll back the presentation, revert the API/console diagnostic changes; no database migration or persisted research state is introduced.
