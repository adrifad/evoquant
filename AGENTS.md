# EvoQuant — Agent Instructions (AGENTS.md)

Self-evolving AI quant trading system for **OKX Demo Trading only**.
Full product spec: `docs/EVOQUANT_SPEC.md` (sections referenced below).

## Non-negotiable invariants (spec §44, §48, §56)

1. **DEMO ONLY.** The code must hard-abort if `environment != "demo"`. Never send requests without `x-simulated-trading: 1` header for private endpoints. No production base URL may exist in the client except behind an explicit, default-disabled guard.
2. **AI proposes, deterministic code disposes.** The Risk Engine (pure TypeScript, no LLM) has final authority (§22). Leverage caps, risk-per-trade, daily loss, drawdown, max positions are constants from `config/risk.yaml`, never mutable by agent output.
3. **`sz` = contracts, NOT coin quantity** (§7.2). Always normalize via instrument metadata (`tickSz`, `lotSz`, `minSz`).
4. **Exchange is source of truth** for positions/orders (§7.8, §45). Reconcile after restart; on mismatch → `STATE_UNCERTAIN` → no new entries.
5. **Never log secrets** (§51): API key/secret/passphrase/signature redacted.
6. Strategy versions are immutable; evolution creates challengers, never in-place edits (§20, §35).

## Stack conventions

- TypeScript strict mode, NodeNext modules. Node >= 22 (native fetch, `node --test`).
- SQLite via `node:sqlite` (experimental) or `better-sqlite3` — DB at `data/trader.db`, schema per spec §40.
- Deterministic modules (exchange client, indicators, risk, sizing) must have unit tests. No network in unit tests; use injected fetch.
- LLM calls go through `src/core/llm.ts` (OpenAI-compatible, env-configured) and must return **structured JSON validated by zod**; invalid output = safe fallback to HOLD (§21: no arbitrary strings).
- Timestamps: UTC ISO strings; money/price math: use strings/decimal-safe handling for OKX payloads, floats only for derived features.

## Build / test commands

- `npm run typecheck` — tsc --noEmit, must pass
- `npm test` — node --test tests/*.test.ts, all green
- `npm run smoke:public` — read-only OKX public endpoints (no credentials)
- `npm run smoke:demo` — Milestone 1 live walkthrough §8–§13 (requires .env demo creds; opens+verifies+closes LONG then SHORT, 1 contract)

## Definition of done for a task

Files compile, tests pass, behavior traced to spec section numbers in code comments, and `state.json`/DB writes are recoverable (§45). When in doubt: less clever, more deterministic.
