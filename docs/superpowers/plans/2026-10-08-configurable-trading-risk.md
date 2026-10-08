# Configurable Trading and Risk Implementation Plan

> **For agentic workers:** Use subagent-driven-development for the backend task, followed by specification and code-quality review. Preserve original checkout changes.

**Goal:** Make operational Risk and Trading editable in Settings, raise the user-requested risk-per-trade ceiling to 10%, and correct misleading AI connection diagnostics.

**Architecture:** Reuse RuntimeRiskService and RiskSettings. Add a transactional, audited RuntimeTradingService for supported entry settings sharing the existing TradingConfig object. Confirm increases, reject stale revisions and preserve open-position management. Keep Demo, isolated/hedged execution, strategy timeframe and promotion rules fixed. AI diagnostics use bounded configured request settings with explicit failure reasons; trading role JSON validation remains strict.

**Tech Stack:** TypeScript, Zod, SQLite, React, Vite, node:test.

## Task 1: Trading lifecycle

Files: `src/core/runtime-trading.ts`, `src/core/main.ts`, `src/core/dashboard.ts`,
`src/execution/executor.ts`, `tests/runtime-trading.test.ts`.

- [x] Add strict `{revision, settings, confirmIncrease?}` API payload. Settings are
  `{instrument_id, leverage_default, leverage_cap, sizing_mode, position_pct}`.
  Require watchlist/risk-allowed primary instrument, integer leverage 1–10,
  default ≤ cap, supported sizing mode and allocation 0.1–100%.
- [x] Persist `runtime_trading_v1` and per-field `TRADING_SETTING_CHANGED` events
  in one transaction, with source dashboard. Apply to the existing TradingConfig
  object after commit; reload on startup. Return effective leverage separately.
- [x] Require confirmation for leverage/allocation increases or sizing-mode changes.
  Entry preparation fingerprints include trading settings as well as risk so
  configuration changes cannot submit using stale leverage/sizing.
- [x] Add `GET/PUT /api/trading`, include audit and constraints, update main anchor
  selection each cycle and share the same configuration with both entry engines.
- [x] Test validation, identity/hot application, audit rollback, restart, revisions,
  confirmation, effective leverage and in-flight entry changes with injected clients.

## Task 2: Settings UI and 10% risk ceiling

Files: `src/core/config.ts`, `apps/console/src/components/TradingSettings.tsx`,
`apps/console/src/pages/SettingsPage.tsx`, `apps/console/src/workstation.css`,
`tests/runtime-risk.test.ts`, `tests/workstation-api.test.ts`.

- [x] Change the absolute risk-per-trade maximum to `10.0`; keep shipped active
  risk at 2%. Test exact 10%, reject 10.01%, confirmation, audit and restart.
- [x] Embed existing RiskSettings in Settings and remove the duplicate read-only
  risk summary. Add TradingSettings with visible labels, server constraints,
  confirmation, save/reload feedback, revision conflict and audit table.
- [x] Show actual timeframe and execution mode as read-only supported engine
  context; do not invent a cross-margin or strategy-timeframe hot reload.

## Task 3: Connection diagnostics

Files: `src/core/llm.ts`, `src/core/llm-role-service.ts`,
`apps/console/src/components/AiRoleSettings.tsx`, relevant LLM tests.

- [x] Replace the hardcoded 24-token/15-second probe with configured limits bounded
  to 2048 output tokens and 60 seconds; keep zero retries and request budget accounting.
- [x] Classify output-limit truncation, empty final content, malformed completion,
  invalid JSON and schema mismatch without returning provider bodies or reasoning.
- [x] Require literal `ok: true` for probe success. Preserve strict production role
  output validation. Display useful error explanations rather than only an enum.
- [x] Regression-test reasoning-only truncated output, successful configured probe,
  invalid JSON, false acknowledgement and safe diagnostics/accounting.

## Verification and delivery

- [x] Run `npm run typecheck`, `npm test`, console typecheck and build.
- [x] Run an isolated preview and inspect/edit/save/reload Settings at desktop,
  laptop, tablet and mobile. Verify 10% ceilings and connection messages.
- [x] Independently review specification compliance then implementation quality.
- [x] Commit/push feature branch, verify CI for exact SHA; merge only if authorized
  for this new feature. Document actual applied settings and verification limits.

Implementation `95543984aa9660039f61df894b2fb51bc4c020da` was pushed; its
[CI run](https://github.com/adrifad/evoquant/actions/runs/37740508759) passed.
The original checkout changes remain untouched. No merge or operator-instance
restart was performed for this follow-up.
