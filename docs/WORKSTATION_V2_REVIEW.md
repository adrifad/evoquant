# EvoQuant workstation V2 review

Branch: `feat/trading-workstation-v2`. This is a controlled extension of the
existing TypeScript/SQLite trading process and React console. It does not enable
live trading or establish profitability.

## Product and architecture review

The actual system already implements deterministic Strategy Core V2, Gate,
Scalp, post-trade Reviewer, bounded one-parameter Evolution proposals, Critic,
historical/OOS/rolling validation, matched shadow experiments and deterministic
promotion. Reviewer already prevents duplicate concurrent reviews. These
mechanisms were reused rather than replaced.

Authority remains absolute safety limits → deterministic risk engine → strategy
core → deterministic execution. AI provides context, review and bounded
proposals; it cannot select leverage, risk, order execution or promotion.
The exchange adapter remains OKX Demo only.

Confirmed UX gaps were a wide dark shell, locked operational risk controls,
missing actual capital/leverage, no dedicated Trading workspace, generic scanner
states and an Evolution screen reading the legacy registry when V2 was active.
The replacement visual language uses a compact navy rail, light workspace,
small bordered sections, tables, simple tabs and restrained financial metrics.

## Pages and reusable components

| Page | Operational changes |
| --- | --- |
| Dashboard | Account/capital groups, bot/exchange environment, current decision and execution, AI availability, active positions, chart, critical errors and evolution |
| Trading | Actual leverage/margin mode, margin source, contracts, notional, stop risk, position state/duration and instrument chart; shared detail dialog |
| Markets | Separate setup, candidate, Gate and risk states; deterministic setup conditions and reasons; instrument chart |
| Trades | Financial ledger, version, entry/exit, MFE/MAE, result and exit reason; persisted historical replay and review detail |
| Evolution | Separate V2 families, evidence/cadence, immutable Champion/Challenger parameters, Critic/proposal context, validation/shadow comparison and version history |
| Risk | Account overview, editable supported risk settings, read-only ceilings, planned-loss preview, revision conflicts, confirmation, audit and existing-position discrepancies |
| AI | Five roles with purpose/provider/model, health, latency, budget, logical calls, HTTP requests, retries and token availability; secondary role settings and Memory tabs |
| Logs | Trading, Risk, AI, Evolution, System and Errors filters with concise event context |
| Settings | Grouped general/trading/system information and links to dedicated Risk/AI controls; existing functionality retained |

New components are `CapitalSummary`, `InstrumentChart`, `RiskSettings`,
`TradingPage`, `AiPage` and `EvolutionWorkspace`. Existing chart, shell, position,
decision, trade-detail and role-setting components were extended. API polling
is bounded, aborts timed-out requests and ignores obsolete responses.

## Backend and API changes

- `GET/PUT /api/risk`: strict operational limits, immutable ceilings, revision
  conflict detection, explicit confirmation for increases and audit events.
- Account snapshots coalesce concurrent reads and cache for five seconds.
  Exchange failures remain unavailable/stale rather than becoming zero equity.
- Status/trade projections include capital, actual leverage, discrepancies,
  latest execution and scanner decisions. Final entry rejection overrides an
  earlier approved risk decision so the scanner cannot falsely show READY.
- `GET /api/candles`: watchlist instruments only; confirmed 1m/5m/15m/1h bars;
  bounded 2–400 candles. Public fallback is limited to 300, cached and coalesced.
  A trade ID selects stored historical candles for that instrument/timeframe;
  missing history is empty, never substituted with current candles.
- V2 evolution projections preserve per-family samples, version context,
  historical/OOS/rolling evaluation and matched shadow results. The legacy V1
  path remains available when the active engine requires it.
- Mutation endpoints reject cross-origin requests and oversized bodies.

## Runtime risk and execution

Supported controls are risk per trade, maximum concurrent positions, maximum
leverage, daily loss limit and maximum drawdown. Existing absolute ceilings are
10%, 3 positions, 10x, 5% and 20% respectively. The risk-per-trade ceiling was
raised from 2% by explicit operator request on 2026-10-08; the shipped active
default remains 2%. Invalid values are rejected with
an understandable error; they are not silently clamped. Baseline mode retains
its one-position restriction.

Risk values and per-field events are committed in one SQLite transaction.
Events contain timestamp, parameter, old/new values, revision and source
`dashboard`. The shared RiskConfig changes only after successful persistence;
both entry engines use the new limits without restart. Corrupt persisted limits
abort startup. Existing positions are not resized by the settings update.
Existing deterministic account-loss/drawdown halt behavior remains authoritative.

Swing and Scalp entries serialize the final entry section, recheck current risk
after asynchronous preparation, confirm exchange leverage before submitting,
and refuse to change leverage for an occupied instrument. Actual filled position
leverage is preferred over the configured value. Entry risk records the planned
loss to the actual stop rather than notional allocation.

An unresolved entry is reserved durably before POST. Ambiguous submission,
timeout or duplicate evidence blocks another entry across restart. The reservation
is released only on proven rejection or exact terminal order/fill reconciliation.
Optional capital persistence cannot prevent protection of an accepted position.

## Capital, margin and leverage

Exchange `lever`, `mgnMode`, `margin`, `imr`, `notionalUsd`, `ccy` and observation
time are retained. Every view labels actual, estimated or unavailable values.
Isolated USDT margin uses exchange values when supplied. Cross IMR is shown as
a USD requirement, not allocated USDT collateral. USD notional and USDT equity
are kept distinct; incomplete aggregate inputs remain unavailable.

Calculated values are restricted to matching supported linear USDT contract
metadata, valid contract value/lot size and finite prices. Quantity uses
contracts × contract value. Estimated USDT notional then uses mark price;
isolated margin fallback uses that notional divided by actual exchange leverage.
Unsupported semantics are unavailable. Potential loss to stop is a price-risk
estimate before execution costs, clearly labeled. Totals do not double-count
exchange positions and persisted trades.

These distinctions follow the [OKX position and contract documentation](https://www.okx.com/docs-v5/en/).
Immutable entry snapshots support future closed-trade financial details. Older
trades without snapshots remain unavailable rather than receiving invented data.

## Charts

One shared chart switches 1m, 5m, 15m and 1h without rendering four charts at
once. It shows confirmed candles, volume, entry/exit timestamps, entry/SL/TP and
current price with trade side. It contains no unrelated indicators. A responsive
viewBox preserves mobile label readability; the observer disconnects on cleanup.
Dashboard overlays always match the displayed instrument. Closed-trade replay
uses persisted trade windows and explicitly warns when a 400-candle window is
partial; unavailable timeframes have an explanatory empty state.

## Evolution and historical performance

Proposal evidence, evidence cutoff, model identity, Critic verdict and hypothesis
survive validation/shadow/promotion transitions. Validation results are stored
alongside original context rather than replacing it. Family evidence is not
merged. Champion Demo results remain separate from matched shadow comparisons.
No promotion thresholds or validation semantics were changed.

Historical aggregates are persisted by strategy version/stage with a fingerprint
of actual confirmed pre-cutoff candles, parameters, costs, tick sizes, timeframe
and evaluator revision. Repeated lifecycle passes reuse valid results. Input
changes, malformed summaries or checksum corruption trigger recomputation.
Infinity is explicitly encoded and restored. Symbol evaluation order is preserved
to keep drawdown semantics unchanged. Cache storage is bounded per version/stage.
The historical cutoff scan no longer spreads large candle arrays onto the stack.
Matched shadow continues to consume new market evidence independently.

## AI accounting and security

Logical runs and actual provider HTTP attempts are separate. Every retry reserves
a budget unit transactionally at dispatch; concurrent calls cannot consume the
same final unit. The dispatch ledger survives restart. Legacy inferred budget
charges are displayed separately. Token totals remain unavailable when provider
usage, retry usage or completion records are incomplete. Safe role failures retain
existing fail-closed behavior and independent role health.

API responses mask keys; forms use password inputs. Secrets, provider response
bodies and prompts are not added to accounting/audit records. Environment saves
validate line injection before writing, use a private 0600 temporary file and
atomic rename. Risk changes contain no secrets. CI is unchanged. No credentials,
environment files, runtime databases, WAL files, logs or browser fixtures are
included in the commit. Original checkout changes are preserved.

## Database additions

- KV records: `runtime_risk_v1`, durable `unresolved_entry_v1`, bounded historical
  cache entries.
- `entry_capital`: immutable observed entry snapshot keyed by trade ID.
- `llm_provider_requests`: per-attempt timestamp, role and retry flag.
- Nullable `llm_runs.provider_requests`: distinguishes migrated legacy records
  from newly accounted logical runs.
- Existing system events hold risk audit entries; existing V2 evidence JSON keeps
  original proposal fields and nested validation results.

Additions are idempotent and backward compatible; tests cover reopen/migration.

## Verification

| Required command | Result |
| --- | --- |
| `npm run typecheck` | PASS |
| `npm test` | PASS — 163 tests, 0 failures, 0 skipped |
| `npm --prefix apps/console run typecheck` | PASS |
| `npm --prefix apps/console run build` | PASS |
| GitHub CI, implementation SHA `6bb803c52e56851b5e4cffa26b0c6e49d0d9faef` | [PASS](https://github.com/adrifad/evoquant/actions/runs/37731344789) |

New tests cover risk ceilings/confirmation/audit/rollback/restart/revisions,
shared hot limits and in-flight entries, actual leverage, unresolved orders,
capital currency/source/contract semantics, private atomic settings, provider
retry/concurrency/restart/token accounting, historical cache parity/corruption,
API unavailable states/replay isolation, scanner decisions and preserved V2
proposal context through promotion. Unit/API tests use temporary stores and
injected clients, without OKX connectivity.

The actual built console ran against an isolated synthetic verification harness,
not production-seeded data. Firefox inspected all nine pages at 1440, 1280, 768
and 390 pixels: 36 combinations without page overflow or unhandled browser errors.
Twenty-five interaction checks cover risk saving/confirmation/audit, four live
and replay timeframes, trade dialogs, mobile navigation/forms, protected keys,
family isolation, log filters and chart/position error or empty states.
Eleven additional checks passed for error feedback across seven pages, stale
status, loading/recovery and absence of unhandled browser errors.
Independent backend and frontend source reviews passed after their findings were
fixed. Local checks do not prove exchange integration or strategy profitability.

## Remaining issues and verification limits

- **P0:** No known unresolved finding from this review.
- **P1:** Real OKX Demo fill/protection/leverage reconciliation and provider billing
  require a credentialed integration run. This is an unverified integration
  boundary, not evidence of a passing exchange run. No real orders were submitted.
- **P2:** Historical replay is bounded to 400 stored candles and has no pagination;
  higher timeframes help only where those candles were retained. Legacy trades
  cannot recover missing entry capital. Missing provider usage remains unavailable.
- **P3:** No known unresolved finding from this review.

The implementation was pushed to `feat/trading-workstation-v2`; the remote SHA
matches the implementation SHA above and its CI passed. Master was not merged.
The final report identifies the branch head including this verification record.
