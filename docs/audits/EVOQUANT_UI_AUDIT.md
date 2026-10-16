# EvoQuant Console UI Audit

## Validation limits

The React console and backend projections were reviewed in source and typechecked/built. API-backed display checks use sanitized fixtures. A local Vite server did not remain reachable for this run, so the pages were **not** represented as browser-rendered or interaction-tested. No before/after screenshots are available. Responsive behavior, console/network errors, keyboard navigation, modal behavior and interactive mutations still require browser validation.

## Page audit

| Page | Issue | Severity | Root Cause | Fix | Validation |
|---|---|---|---|---|---|
| Dashboard | Trusted expectancy could be shown with the count of every closed trade; unavailable expectancy could look like `0R`. Tiny PnL was rounded away. | P2 | Fallback dashboard used raw closed count and `value || 0`; money helper had 2 decimals. | Fallback now uses trusted NET trade count, preserves null as `—`, and distinguishes tiny nonzero values. React dashboard also labels trusted NET totals and evidence counts. | API projection tests, format utility tests, typecheck/build pass before final backend edits; browser rendering not verified. |
| Trading | Native protection status is material to whether an open position is actually covered. | P1 | API order acceptance is not proof of active TP and SL. | Backend now exposes degraded protection through status/warnings and blocks entries on uncertain protection. | Mocked protection lifecycle tests; OKX Demo behavior not verified. |
| Markets | Scan/candidate/Gate/risk are separate states; dynamic watchlist limits could be hardcoded in the UI. | P2 | A signal timestamp alone is not scan activity; limits may drift from config. | Existing nested scan activity remains explicit; watchlist slot and score values render from API config. | Workstation API tests and console typecheck/build; browser interactions not verified. |
| Trades | Closed rows with incomplete accounting could display partial PnL/R like trusted NET results. | P1 | Nullable/incomplete accounting was not a UI trust boundary. | Only VALID, eligible, NET, complete rows show trusted closed PnL/R; other rows show evidence state/reason. Loss attribution excludes incomplete rows. | Workstation/loss attribution tests and formatter tests. |
| Strategies | No confirmed source defect was established in this pass. | — | Read-only source review; no live validation database. | No strategy UI changes. | Source inspected; browser/render validation not available. |
| Evolution | LLM completion can be mistaken for accepted/promoted strategy evidence. | P2 | Proposal, validation and promotion states need distinct interpretation. | Existing API retains status/provenance; this patch leaves promotion policy unchanged and only supplies verified scoped lessons. | Existing Evolution tests; visual/runtime rendering not verified. |
| Risk | Risk values could be misleading if UI uses stale or nullable operational fields. | P1 | No production config/database available to compare UI against runtime exchange state. | No risk settings or limits changed; APIs continue to expose configured values and deterministic checks. | Existing risk API/runtime tests; no live account comparison. |
| AI | Reported Reviewer error rates were not verifiable without `llm_runs` from the production database. | P2 | Runtime data unavailable. | No model/provider behavior was altered in this patch; invalid role output remains fail-closed and diagnostics remain safe. | Existing LLM role tests; production error distribution unavailable. |
| Logs | No evidence of a credential leak was found in the inspected presentation changes. | — | Static source review only. | No raw provider response or credentials added to UI. | Existing redaction tests; browser inspection unavailable. |
| Settings | Runtime settings persistence and optimistic concurrency cannot be proven from a screenshot. | — | Requires live authenticated runtime. | No settings mutation behavior changed. | Existing API tests; safe mocked UI mutation interaction not run. |
| Memory (AI Memory tab) | Reviewer lesson candidates are not validated general rules merely because an LLM generated them. | P1 | Natural-language claims lack a deterministic semantic validator. | Candidates remain source-linked provisional. Only later independent eligible NET evidence can verify scoped lessons; Evolution receives verified lessons only. | Lesson lifecycle/evolution tests; browser display not verified. |

## Shared formatting and data contracts

- `apps/console/src/lib/format.ts` distinguishes missing values, exact zero, and tiny nonzero currency values; timestamps state UTC. Price formatting continues to use existing instrument precision metadata where available.
- `/api/status` carries separate all-closed and trusted NET totals, plus evidence counts. It does not reinterpret null as zero.
- Dashboard, Trades and loss attribution use the same deterministic evidence eligibility boundary for trusted results.
- Markets keeps Swing and Scalp scan activity separate and avoids conflating deterministic setup, Gate veto and risk outcome.
- Tables retain their existing horizontal overflow behavior for wide financial data; no columns were intentionally hidden as a substitute for scrolling.

## Interaction coverage

Not completed in a browser: sidebar navigation, chart/timeframe controls, trade dialogs, position/market selection, filters/search, pagination, risk/AI settings mutation, pause/resume, emergency stop, reconnect/timeout, empty/large histories, long labels, pending evidence, concurrent edits, keyboard flow, modal dismissal and responsive checks at 1920/1366/1024/768/390 px. These require an accessible running console with a stable mock server and must use mocks for all order-sensitive controls.

## Conclusion

The audited financial presentation paths now preserve evidence validity and unavailable values in code and API contracts. The build is not visual proof: full browser acceptance remains outstanding, and the current deployment readiness is **NOT YET VERIFIED**.
