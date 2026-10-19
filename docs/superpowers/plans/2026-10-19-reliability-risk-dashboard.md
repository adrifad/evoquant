# Reliability Hardening and Risk Dashboard Plan

## Baseline

- Branch: `fix/reliability-risk-dashboard`
- Base: `bc9d04e89f5b43fa4e5ff2ac5bbf79f9f855fad`
- Preserve the existing demo-only exchange restrictions, risk limits, strategy parameters, SQLite compatibility, and the unrelated `reference/` worktree entry.

## Implementation sequence

1. **Chronological structure events:** deduplicate confirmed candles deterministically; reveal pivots only at confirmation time; maintain bias incrementally; attach before/after bias and pivot/break timing to structure-break events. Add prefix-invariance, duplicate, out-of-order, and pivot/break tests.
2. **Owned range boundaries:** identify a candidate range from distinct confirmed support/resistance zones, then validate breaches only against that pair. Reconstruct state from ordered candles and test unrelated historical zones, upper/lower breaks, retests, and malformed history.
3. **Freshness projection:** retain confirmed-candle-only persisted reads; expose current/stale/insufficient/unavailable metadata based on timeframe, candle close time, publication grace, and injected evaluation time. Test without network access.
4. **Scalp protection failure recovery:** verify existing post-fill ownership and halt path; add a narrowly scoped, idempotent risk-reducing recovery using executor's serialized close path only after fresh matching position readback. Preserve unresolved state on uncertainty. Add mocked exchange regression tests.
5. **Monitor health:** distinguish complete from partial sweeps; keep last complete success unchanged after partial failure; make no-required status neutral in API and UI.
6. **Risk Control Center:** reorganize the existing page into risk overview, safety/readiness, monitoring, settings, expandable diagnostics, and event timeline. Reuse current components/theme and preserve all revision/confirmation/save semantics. Add scoped responsive styles at 375/768/1280/1700px.
7. **Evolution V3 gap note:** document implemented, partial, and missing requirements with the next independently testable increment; do not activate research strategies.

## Verification

- Establish current baseline with root typecheck/tests and console typecheck.
- Add deterministic backend and frontend-facing projection tests before implementation changes where practical.
- Run root typecheck/tests, console typecheck/build, focused market/intelligence, monitor, scalp execution, and workstation API tests.
- Review the full diff for risk/config/strategy changes and migration impact.
- Perform read-only independent code review; fix blocking findings and rerun affected checks.
- Browser-render the console at representative desktop and mobile widths if local browser tooling permits; state clearly if visual rendering could not be performed.
- Commit and push the reviewed branch; prepare a PR targeting `master` without merging or deploying.
