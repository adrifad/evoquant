# EvoQuant Reliability and UI Audit

## Scope and provenance

- Audited `origin/master` at `cb6d4bc7f8bbeac92f496f54c14ddc1f44073874`.
- Work is isolated on `fix/full-trading-reliability-ui-audit`; the worktree also contains the directly-descendant accounting/lesson recovery change `57abf383d219d2e3501cb7668378101e0b01467a` and uncommitted work described below.
- This is a source/test audit with deterministic exchange and UI fixtures. No production trader database or authenticated exchange session was available. No order was submitted.

## Findings

| Severity | Finding | Evidence / disposition |
|---|---|---|
| P1 deployment blocker | Native OKX protection behavior has not been exercised against Demo. | The source now places separate conditional SL and TP algo legs, reads both back, and rejects mismatched side, isolated mode, size, trigger type or price (`src/exchange/okx/algo.ts`). Mock coverage is not exchange integration proof. |
| P1 | A second protection leg or exact live position size could not be trusted after request/readback failure. | Separate legs are checked; failed post-fill position readback leaves the trade protected on best available fill quantity but marked `DEGRADED`, sets `RISK_HALTED`, and prevents new entries. Recovery re-reads the exact exchange position and both legs. |
| P1 | Exchange-triggered exits could leave the independent sibling algo live. | A trade remains `RECONCILIATION_PENDING` until both protection IDs reach a confirmed terminal state. Cleanup failures persist a reason, degrade protection and halt new entries. |
| P1 | Funding history could be truncated at the first 100 bills. | Funding lookup now uses bounded time windows and `billId` pagination; a missing cursor or exhausted page/window bound throws, leaving funding unknown and the trade ineligible. |
| P1 runtime evidence unavailable | Reported `SCALP-35317323`, MAGIC loss and October 5 loss cannot be reconstructed here. | No runtime DB/credentials were present. No source-only conclusion is made about those reported outcomes or a risk-limit breach. |
| P2 | Previous reports mixed closed-trade populations and could make missing expectancy appear as zero. | Status API separates all closed totals from trusted VALID/NET counts and totals. UI uses the trusted count; null stays unavailable. Loss attribution groups trusted records only and explicitly reports missing evidence. |
| P2 | Small nonzero currency amounts and timezone labels were ambiguous. | Shared console formatter preserves exact zero, renders sub-cent values with more precision, distinguishes null, and labels timestamps UTC. |
| P2 | Reviewer-generated language cannot be statistically validated as a general rule without semantic leakage. | Reviewer lessons remain source-linked provisional hypotheses. Deterministic lesson evidence accepts only independent closed valid NET trades in scope; only machine-verified lessons reach bounded Evolution context. No LLM confidence promotes a lesson. |

## Confirmed changes

### Native TP/SL and execution recovery

- `src/exchange/okx/algo.ts` normalizes prices with integer decimal arithmetic against instrument `tickSz`; stop rounding does not increase risk and target rounding does not expand target distance. Long and short use their correct closing side. SL and TP have independent `algoClOrdId` identifiers and are verified by exchange algo ID.
- `src/execution/position-management.ts` amends the exact SL leg, then re-reads both SL and TP before changing the local stop. Any uncertain amendment/readback marks protection degraded and pauses entries.
- `src/execution/executor.ts` uses actual filled contracts, requires exact position readback before labelling protection verified, verifies open protection on restart/cycle, and keeps Layer B monitoring active during degraded state. After a proven exit it cancels and verifies both algo legs before closing the local row. Unknown cleanup remains reconcilable and blocks entries.
- `src/scalp/runner.ts` applies the same position/protection verification and retries checks during its management sweep.
- Exact instrument metadata remains required; no cross-symbol contract metadata fallback was introduced.

### Accounting and evidence

- Fill accounting independently proves full entry and exit quantities against exact instrument/order/side/position side and interval. Recent fills are combined with bounded paginated history; duplicate trade fills are removed by stable exchange identifiers. Incomplete history, invalid fee currency or partial quantity remains pending.
- OKX signed fee values are converted to positive cost by negation, so a rebate reduces cost. Fees are not assumed zero when unavailable.
- Funding uses the OKX bill `pnl` field, retains its sign, filters subtypes 173/174 and exact trade interval, and waits the settlement grace. Unknown lookup is never converted to zero.
- Relevant funding bills must carry a stable exchange `billId`; if it is missing, the lookup stays incomplete instead of de-duplicating by a synthetic tuple that could collapse distinct ledger rows.
- `ACCOUNTING_INCOMPLETE` has persisted retry state/backoff. Exit-fill/protection reconciliation now also persists attempt count and next retry time. Both recovery paths are bounded per cycle and idempotent; they issue no trading order.
- If protective-order cleanup fails after a known strategy close, the original exit reason is persisted while reconciliation is pending; a later confirmed cleanup/fill recovery retains that attribution.
- Only closed VALID evidence with complete NET accounting and non-null result fields is exposed as trusted performance or learning evidence.

### Lessons and Evolution

- The evidence recovery change verifies that lesson evidence comes from independent, later, closed, valid NET trades and matches lesson scope; duplicate evidence is not counted. Contradiction is retained rather than ignored. Threshold transitions are deterministic.
- Natural-language Reviewer lesson candidates remain provisional because arbitrary statements cannot be mapped safely to trade outcomes by keyword or LLM confidence. Verified lesson IDs are scoped and bounded in Evolution context. Lessons remain advisory; deterministic validation and promotion authority are unchanged.

### Performance and API/UI data

- `/api/status` reports raw all-closed PnL separately from trusted NET PnL/expectancy/count and evidence states.
- Loss attribution reports only trusted NET values for financial metrics; unavailable aggregates remain null. Sequence drawdown is labelled as a closed-trade sequence metric, not account equity drawdown. Price-unit MFE/MAE are withheld when combining different instruments.
- Dashboard, Trades and Markets views now distinguish trusted evidence, incomplete accounting, protection degradation and unknown values. Markets renders dynamic limits from the API instead of embedding slot/score values.
- The built-in dashboard fallback now labels trusted expectancy and uses its trusted trade denominator; null expectancy is `—`, not `0R`. Tiny nonzero money values are distinguishable from exact zero.

## State and recovery summary

| Condition | State / behavior |
|---|---|
| Exit or position size not proven | `RECONCILIATION_PENDING`; no trusted PnL or learning; persisted retry with exponential backoff capped at 6 hours. |
| Fees, funding or candle evidence temporarily unavailable | `EVIDENCE_PENDING`; null remains null; finalizer retries. |
| Retry budget for initial accounting pass exhausted | `ACCOUNTING_INCOMPLETE`; independent bounded reconciliation path continues with durable attempts/backoff. |
| All required exact evidence verified | `VALID`, `result_r_basis=NET`, eligible for Reviewer/Evolution. |
| Protection leg missing, mismatch or uncertain amendment | `protection_state=DEGRADED`, bot state `RISK_HALTED`; no new entries; position management continues. |

## Runtime trade/loss diagnosis limits

The code path runs from scanner and deterministic strategy to Gate, Risk, exchange order/fills, finalizer and evidence-gated Reviewer/Evolution. Source review confirms invalid Gate output fails closed and deterministic risk remains authoritative. No live database was present to quantify role errors, reconstruct October 5/MAGIC risk-at-entry, reconcile actual fills, or calculate Demo expectancy/drawdown. These are reported-runtime hypotheses, not confirmed defects in the current source.

The source supports fee/funding/NET calculations only when the exchange supplies complete exact evidence. Fee currencies other than USDT are conservatively left pending because no verified conversion path exists here. Historical fill retention beyond the documented lookup window remains incomplete and cannot be repaired by guessing.

## Verification evidence

- Root typecheck: PASS after final edits.
- Root test suite: PASS, 322/322 tests.
- Console typecheck: PASS.
- Console Vite build: PASS (1,914 modules transformed; JavaScript bundle approximately 371.73 KB).
- `git diff --check`: PASS.
- Browser screenshots/interactions: NOT VERIFIED. A sanitized mock API was available, but the Vite server did not remain reachable in this environment, so no fully loaded page screenshots or interaction claims are made.
- Demo exchange validation: NOT EXECUTED. No credentials, orders or exchange calls were used.
- Lint: no lint script is defined in the repository package scripts.

## Deployment readiness

**NOT YET VERIFIED.** The code is suitable for static/staging checks only until CI is rerun and the two-leg protection lifecycle is verified in controlled OKX Demo with bounded, explicitly authorized smoke procedures. Do not treat this audit as real-money readiness or evidence of improved profitability.

## Compatibility and safety

- SQLite changes are idempotent `ALTER TABLE` migrations; no database reset or historical row deletion.
- No strategy thresholds, trading parameters, risk limits, leverage ceilings, position count, or position-sizing authority were intentionally changed.
- OKX Demo enforcement remains in `src/exchange/okx/client.ts`; no live orders were placed.
