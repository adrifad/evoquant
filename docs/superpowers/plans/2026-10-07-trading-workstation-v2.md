# Trading workstation V2 implementation plan

**Goal:** Make Demo trading, capital, deterministic decisions, bounded risk configuration, and strategy evolution observable in one operational console.

**Architecture:** Preserve the TypeScript trading process, SQLite store, React console, deterministic safety hierarchy and existing promotion criteria. Add focused domain projections and runtime risk persistence; reuse the current tables, charts, drawers and role settings. No exchange order is part of verification.

**Tech stack:** TypeScript, React, Vite, SQLite, node:test.

## Source review and confirmed gaps

- `src/core/dashboard.ts` discards exchange leverage and reports zero equity on exchange failure; position mapper forces isolated mode and omits margin.
- `src/risk/engine.ts` uses validated startup settings but there is no persisted runtime risk API or audit lifecycle.
- `src/execution/executor.ts` synchronizes leverage at startup only, and records notional allocation as planned risk in percent sizing mode.
- `src/evaluation/v2-promotion.ts` repeats four expensive historical evaluations before checking whether a version is already in shadow.
- `src/core/llm-role-service.ts` counts completed logical calls, omits retry counts in its ledger, and permits concurrent calls to race budget checks.
- `apps/console/src/pages/EvolutionPage.tsx` reads the V1 registry regardless of active V2 engine.
- The console has a wide dark shell, locked risk fields, no dedicated Trading workspace, and no actual capital or leverage representation.
- Reviewer already has an in-flight trade set; Critic and immutable bounded V2 proposals already exist and must be preserved.

## Design read

Energy 1, rhythm 2, motion 1. Navy `#12213f` navigation, workspace `#f3f5f7`, white surfaces, border `#d8dee7`, text `#202d40`, blue `#315fb1` selection. Retain IBM Plex Sans for compact labels and tabular numbers for financial comparison. A narrow labeled icon rail reserves space for instrument tables. White panels separate operational sections; small radii and borders define hierarchy. Status labels always accompany color. The focal point is current trading state and capital, followed by decision trace and evolution evidence.

## Implementation tasks

- [x] Risk lifecycle: add strict server-side operational settings bounded by existing `ABSOLUTE_MAX`, transactionally persist values and per-field audit events in SQLite, load at startup and hot apply to both engines. Require explicit confirmation for increases. Guard in-flight entries against revised settings, synchronize leverage only for unoccupied instruments, preserve existing positions. Add validation, restart, audit, baseline and reload tests.
- [x] Capital domain: preserve OKX position fields and margin mode, map actual versus estimated values, use only supported linear contract metadata for derived values, persist entry financial metadata and expose account totals without double counting. Unknown data stays null. Test missing values, cross margin, contract semantics and leverage mismatch.
- [x] Historical cache: persist content-addressed aggregate results keyed by strategy definitions, actual confirmed pre-cutoff candles, timeframe, costs, tick sizes and evaluator revision; reuse results without changing thresholds or promotion logic. Test hits, invalidation, restart and parity.
- [x] AI accounting: record provider attempts independently of logical runs, enforce budgets at request dispatch including retries and concurrent calls, expose tokens and retry telemetry with sanitized errors. Fix atomic environment writes and cover key protection.
- [x] API projections: bounded candle timeframe API, correlated market decisions, V2 family evidence/cadence/comparisons, lifecycle events, account freshness, position/trade metadata and discrepancies.
- [x] Console: light workstation shell, Trading workspace and details, shared timeframe chart with candle/volume and entry/exit/SL/TP overlays, compact capital summary, editable Risk, V2 Evolution, AI role overview/settings, meaningful scanner states and filtered logs. Retain existing Memory/Strategies access as secondary tabs.
- [x] Verification: core typecheck/tests, console typecheck/build, isolated console preview without trading, visual and interaction checks at 1440/1280/768/390, empty/error/stale and long content checks, independent specification and quality review.
- [x] Delivery: intentional files only; commit and push `feat/trading-workstation-v2`; inspect CI for exact pushed SHA; record remaining issues honestly.

## Test strategy

Use temporary SQLite stores and injected fetch for all backend mechanisms. Never load real credentials into fixtures. Preserve and run all existing tests. Browser validation runs against an isolated dashboard harness with explicitly synthetic test data, never production seeded data. Record outcomes and limitations in `docs/WORKSTATION_V2_REVIEW.md`.
