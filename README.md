# EvoQuant

Self-evolving AI quant trading system — **OKX Demo only**.
*Adaptive Quant Intelligence.*

Full specification: [`docs/EVOQUANT_SPEC.md`](docs/EVOQUANT_SPEC.md)
Milestone brief: [`docs/TASK-M1.md`](docs/TASK-M1.md) · Agent rules: [`AGENTS.md`](AGENTS.md)

## Status

| Milestone | Scope | Status |
|---|---|---|
| M1 — OKX Demo Adapter | auth, client, market, account, orders, sizing, smoke tests | ✅ implemented & unit-tested |
| M2 — Deterministic core | scheduler, indicators, regime, risk engine, sizing math, PnL | ⏳ |
| M3 — Decision Agent | LONG/SHORT/HOLD structured JSON | ⏳ |
| M4 — Trade Reviewer | hypothesis-only post-trade review | ⏳ |
| M5 — Learning memory | lessons, regime/strategy/signal stats | ⏳ |
| M6 — Evolution | weights, calibration, challengers | ⏳ |
| M7 — Champion vs Challenger | backtest, walk-forward, promotion | ⏳ |

## Safety invariants (enforced in code, not comments)

- **DEMO ONLY** — every client constructor, factory, and config loader throws
  unless `OKX_ENV=demo`; production URL aborts the process (spec §44).
- Every request carries `x-simulated-trading: 1` (spec §5.2).
- `sz` = **contracts** (never coins) — normalized to `lotSz` with BigInt math
  (spec §7.2/§24).
- Absolute risk maximums are hardcoded in `src/core/config.ts`; config files
  may only tighten them (spec §48).
- Secrets are redacted centrally by `src/core/logger.ts` (spec §51).

## Strategy Core V2 research mode

`config/trading.yaml` selects the strategy engine with `strategy_core.version`;
the shipped setting is V2. `validation.baseline_mode` is a separate experiment
overlay: it freezes evolution, disables scalp, and limits concurrent positions
to one without switching back to V1. Outside baseline mode, V2 can run with
evolution enabled and scalp controlled independently by `scalp.enabled`.

V2 uses deterministic candidates and an LLM ALLOW/DENY context gate. Evolution
creates immutable, one-parameter V2 Challengers after the configured sample
interval. A Challenger must pass after-cost historical, trailing OOS, walk-
forward, and cross-symbol validation before it enters shadow-forward. Shadow
trades are simulated in a separate ledger and never reach OKX order APIs,
account equity, live position limits, or real-trade learning. Promotion is
deterministic and waits for both Challenger shadow and Champion forward samples.

The defaults are tuned for a short research window, not for guaranteed
significance: signal learning every 8 closed trades (20-trade evidence floor),
V2 proposal reviews every 15 family/version trades, historical gate at 50,
and at least 15 closed shadow trades plus 15 Champion forward trades before
promotion can be considered. Fee, spread, slippage, OOS, symbol, fold, and
drawdown assumptions are in `config/evaluation.yaml` and
`config/evolution.yaml`. This configuration does not establish profitability.
See [`docs/STRATEGY_CORE_V2_EVOLUTION.md`](docs/STRATEGY_CORE_V2_EVOLUTION.md)
for lifecycle and limitations.

## Setup

```bash
cp .env.example .env      # add OKX DEMO creds (spec §5.1) — never commit
npm install
npm run typecheck && npm test
npm run smoke:public      # no credentials, read-only
npm run smoke:demo        # full §8–§13 open/verify/close LONG + SHORT on demo
```

## Layout

```
src/exchange/okx/   OKX demo adapter (M1)   src/core/        config + logger
src/market/         M2 indicators/features  src/risk/        M2 risk engine
src/agents/         M3+ LLM agents          src/learning/    M4–M6
src/strategy/       registry (immutable v)  src/evaluation/  M7
config/*.yaml       trading, risk, evolution prompts/*.md    decision, review, evolution
tests/              deterministic unit tests, no network     docs/  spec + task briefs
```
