# Configurable Trading, Risk and AI connection diagnostics

Branch: `feat/configurable-trading-risk`. Follow-up to workstation V2, based on
master `0860df1`. Changes are confined to operator configuration, its safe entry
application and connection diagnostics. OKX Demo, deterministic trade direction,
position protection and bounded strategy evolution retain their authority.

## Findings and changes

- Settings previously showed Trading and Risk as read-only summaries. It now
  has Trading, Risk and General tabs; Risk reuses the existing RiskSettings editor.
- The operator explicitly requested a 10% absolute risk-per-trade ceiling.
  The shipped active default remains 2%; existing persisted limits are preserved.
- AI connection testing previously replaced the configured output limit with
  24 tokens and reduced timeout to 15 seconds. A successful manual free-form
  request therefore did not establish that the structured probe would work.
  The probe now uses configured temperature, output tokens and timeout, bounded
  to 2048 tokens and 60 seconds, with no retries.
- Review found a save/refresh race: an older GET could replace a newly saved
  form snapshot. Save responses now update local state immediately, invalidate
  older requests and force a fresh read. Role health uses the forced refresh too.

## Supported settings

| Group | Editable fields | Boundaries |
| --- | --- | --- |
| Risk | Risk per trade, maximum positions, portfolio open risk, leverage cap, daily loss, drawdown | Absolute maxima: 10%, 5 positions, 5% portfolio open risk, 10x, 10% daily loss and 10% drawdown |
| Trading | Primary instrument, entry leverage, trading leverage cap, swing sizing mode, swing notional allocation | Instrument needs available metadata and risk permission; integer leverage 1-10; default <= cap; supported sizing modes; allocation 0.1-100% |

Trading's primary instrument selects the watchlist anchor. It does not replace
the scanner watchlist. Effective entry leverage is the minimum of entry leverage,
trading cap, operational risk cap and absolute ceiling. Actual leverage of open
positions remains exchange state, not the new-entry setting.

Swing percent-of-equity allocation describes target notional, not margin or loss
at stop. Risk-based sizing uses stop distance; deterministic risk constrains both
modes. Scalp retains its own allocation and shares leverage/risk controls.
Timeframe, margin mode, position mode and Demo environment remain read-only;
changing their schedulers, evidence contracts or execution semantics needs a
coordinated engine change.

## Persistence and application

`GET/PUT /api/trading` returns revision, settings, constraints, effective leverage,
execution context and recent audit. Strict server validation rejects invalid or
extra fields. Revision conflicts return 409; increases in leverage/allocation
and sizing-mode changes require explicit confirmation. Risk increases retain the
existing confirmation requirement. There is no silent clamping of submitted values.

Trading settings persist under `runtime_trading_v1` in existing SQLite KV storage.
Per-field `TRADING_SETTING_CHANGED` events record timestamp, field, old/new value,
revision and dashboard source in the same transaction. Runtime objects change
only after commit, preserve shared nested references and restore on startup.
Invalid persisted settings abort startup. No new database table or migration is needed.
Both Risk GET and PUT include audit so the committed response is complete.

Both entry engines fingerprint Trading and Risk settings across asynchronous
leverage synchronization and preparation. A changed fingerprint prevents order
submission under stale settings. Saves do not resize or close existing positions.
Existing deterministic daily-loss/drawdown halt behavior still applies.

## AI diagnostics and security

The transport classifies truncated output, empty final content, malformed
completion, invalid JSON and schema mismatch. Diagnostics contain fixed safe
messages and enums; they never return provider bodies, reasoning or keys.
Probe success requires exactly `{"ok":true}` after a completed response.
Production role validation remains strict. Reaching `finish_reason: "length"`
fails even when a partial answer contains parseable JSON.

Each probe reserves the existing role request budget. Logical calls, actual
HTTP attempts and token availability retain their existing accounting.
Provider-reported token usage is retained when final content is empty/truncated.
Keys remain masked and server-local. Trading mutations use the existing
origin/body-size protection. This work does not alter capital/margin formulas,
exchange financial projections, charts, promotion rules or live activation.

## Verification

| Check | Result |
| --- | --- |
| Core typecheck | PASS |
| Core tests | PASS: 183 tests, no failures/skips |
| Console typecheck | PASS |
| Console production build | PASS |
| GitHub CI | PASS for implementation `95543984aa9660039f61df894b2fb51bc4c020da`: [run 37740508759](https://github.com/adrifad/evoquant/actions/runs/37740508759) |
| Browser interactions | PASS: 28 configuration/probe checks |
| Browser states, keyboard and contrast | PASS: 14 additional checks |
| Independent specification review | PASS |
| Independent code quality re-review | PASS after save/refresh correction |

Backend regressions cover exact 10% risk, rejecting 10.01%, confirmation,
persistence/restart, audit rollback, stale revisions, shared runtime references,
effective leverage, existing-position retention, origin rejection and changes
during preparation in both engines. Transport tests cover reasoning-only
truncation, token usage, each safe failure reason, false acknowledgement,
configured probe settings and caps. No test requires actual OKX connectivity.

Browser verification used an isolated SQLite store and injected exchange/provider
responses. Synthetic data lived only in a temporary fixture, never production
views or repository config. All three Settings tabs were visually inspected at
1440, 1280, 768 and 390 px. Checks exercised save/reload, cancellation, audit,
server rejection, an intentionally delayed old GET, readable mobile diagnostics,
loading/error/stale recovery, Tab/Enter focus and Escape navigation. Normal text
contrast ratios tested range from 5.43 to 10.20. No horizontal page overflow or
unhandled browser errors was observed in these cases.

## Design delivery gate

Direction preserves the approved workstation: navy rail, light workspace,
small bordered sections and compact labeled forms. Dials: ENERGY 1, RHYTHM 2,
MOTION 1. The editable form is the focal point; execution context and audit
provide secondary operational evidence.

### Hard Gate

- R-02 PASS: edited form copy contains no em dash; unavailable AI readings are labeled.
- R-03 PASS: all 12 Settings tab/viewport combinations have no page overflow.
- R-17/R-18/R-38 PASS: production values come from APIs; no testimonials or invented metrics.
- R-23/R-24 PASS: no visual assets or new main-navigation links were introduced.
- R-25 PASS: body, muted, error and accent text contrast measured at 5.43 or higher.
- R-26 PASS: save, reload, tabs, selects and connection tests have implemented handlers; browser tests exercise changes.
- R-27 PASS: injected loading, 500 error, stale refresh and recovery show explicit states; empty audit is labeled.
- R-28 PASS: no FAQ was introduced.
- R-32 PASS: keyboard Tab/Enter activates Risk; Risk/AI focus is visible; Escape closes mobile navigation.
- R-33 PASS: product changes are checked-in source/CSS; temporary browser scripts only drive the UI.
- R-34 PASS: no theme toggle was introduced or removed.
- R-35 PASS: console built and ran; configuration/probe interactions and screenshots recorded.
- R-36 PASS: verification is bounded to local tests/fixtures; no provider or profitability claim.
- R-37 PASS: design direction was declared before implementing the forms and preserves the operator reference.

### Purpose-Gate

- R-01/R-07/R-08/R-10/R-12/R-13/R-19/R-22 PASS: no new gradients, decorative patterns, glass, elevation, motion or illustration.
- R-04 PASS: reused existing save/test/key icons indicate their actual actions.
- R-06 PASS: small tabular/monospace financial metadata supports scanning; no new display typeface.
- R-09 PASS: existing Demo/health badges identify operational state.
- R-14 PASS: form/context/audit differ in composition to match their responsibilities.

### Liveliness

- PASS: declared 1/2/1 dials match the calm form layout and absence of new animation.
- PASS: editable settings are the focal point, context is secondary and audit is full-width evidence.
- PASS: section gaps group responsibilities; blue marks selected tabs, focus and save actions.
- PASS: repeated labeled rows and numeric alignment preserve the workstation identity.

### Craftsmanship and Quality Locks

- C-1/C-3/R-05/R-20/R-30/R-31 PASS: each section has an operational purpose and reuses the existing product layout.
- C-2/C-4 PASS: forms persist through real local APIs; keyboard, error, stale and responsive states were exercised.
- C-5/R-16 PASS: no fabricated claims or marketing copy was added.
- R-11/R-15 PASS: small rectangular controls use explicit Save/Reload/Test labels.
- R-21/R-29 PASS: approved light workspace/navy shell with restrained blue action accent is preserved.

## Remaining limits

- P0/P1: no unresolved finding from the scoped specification/quality reviews.
- P2: actual KiosAPI/GLM connection success is unverified; no real provider call was made.
- P2: a reasoning model may still exhaust the configured tokens or the 2048-token probe cap; the diagnostic explains it.
- P3: strategy timeframe and independent Scalp allocation are not dashboard-editable in this change.

The running operator instance was not restarted or modified. New code must be
deployed and restarted once to install these services; subsequent supported
settings updates apply without restart. Implementation is pushed to the feature
branch; it has not been merged into master. The final delivery SHA may additionally
include this verification record.
