# Opportunity Engine V1

## Opportunity layers

- **Market universe** decides which instruments are evaluated. The existing configuration retains its seven Core symbols and up to twelve Dynamic symbols, with the configured total capped at twenty.
- **Deterministic scanner** evaluates confirmed market data and Strategy Core hard conditions. A failed condition cannot be offset by setup score.
- **Candidate attempt queue** sends at most three ranked Swing candidates by default through Gate and deterministic Risk. A Gate denial or candidate-local sizing rejection can fall through; a global halt, unavailable Gate, budget exhaustion, or uncertain state stops the queue. It opens no more than one Swing position per global 15-minute cycle.
- **Gate** may only allow or veto the deterministic candidate. Direction and order geometry remain Strategy Core outputs; sizing, leverage, portfolio checks, and execution remain deterministic.

## Opportunity funnel

`opportunity_funnel_hourly` stores compact engine/hour/metric counters and bounded blocker labels. `opportunity_candidate_attempts` stores a 30-day operational trace for attempted Swing candidates. The API is `GET /api/opportunity-funnel?hours=24` or `hours=168`; it returns persisted values and does not infer missing history. Healthy per-symbol scans do not create system event rows.

The `CONFIDENCE_BELOW_MIN` count represents Gate-allowed Swing candidates later denied solely by calibrated minimum confidence. Its percentage uses Gate allows as the denominator.

## Experimental strategy families

`TREND_PULLBACK_V1` and `BREAKOUT_RETEST_V1` are deterministic research evaluators configured in `config/research-strategies.yaml`. Their strict schemas, symmetric direction checks, hard conditions, and ATR geometry are implemented in `src/strategy/research-v1.ts`. They are intentionally absent from the live scanner and Champion registry.

The current V2 registry seeds every registered strategy family as a Champion, while the lifecycle/promotion code is typed to that registry. Adding a new family there would expose it to production scanning before it passes a separate Challenger lifecycle. These evaluators therefore must not be represented as promoted, shadow-tested, or production-enabled. `src/evaluation/research-strategies.ts` provides deterministic cost-aware backtesting and train/OOS/rolling statistics for a later isolated research runner.

No runtime historical candle database was available in this checkout, so no measured train/OOS/rolling results are claimed. Neither experimental family has completed matched Shadow validation or promotion.

## Entry timing research

This patch does not introduce a 15-minute pending setup with 5-minute timing. That feature needs persisted expiry/thesis state and a fresh execution-time risk gate; adding a second entry state machine would require its own validation and operator observability.
