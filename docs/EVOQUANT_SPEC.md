# EvoQuant — Self-Evolving AI Futures Trading Bot for OKX Demo

> Status: Draft V1 Specification  
> Exchange: OKX  
> Environment: Demo Trading  
> Product: USDT-M Perpetual Futures (`SWAP`)  
> Initial instrument: `BTC-USDT-SWAP`  
> Initial timeframe: `15m`

---

## 1. Objective

EvoQuant is an experimental AI-assisted futures trading bot designed to:

1. Observe the market.
2. Generate structured LONG / SHORT / HOLD decisions.
3. Validate every decision using deterministic risk rules.
4. Execute approved trades on **OKX Demo Trading**.
5. Monitor and close positions.
6. Review every completed trade.
7. Learn why a trade won or lost.
8. Store reusable lessons and market-regime knowledge.
9. Adjust signal weights and strategy parameters.
10. Propose improved challenger strategies.
11. Promote a new strategy only after validation.

The goal is **not** to let an LLM freely modify live trading code.

The intended loop is:

```text
Market
  ↓
Features
  ↓
Market Regime
  ↓
Decision Agent
  ↓
Risk Engine
  ↓
OKX Demo Execution
  ↓
Position Management
  ↓
Trade Closed
  ↓
Post-Trade Review
  ↓
Statistical Validation
  ↓
Trading Memory
  ↓
Evolution Engine
  ↓
Champion vs Challenger
  └──────────────→ Next Trading Cycles
```

---

# 2. Core Design Principles

## 2.1 AI reasons, deterministic systems enforce

AI may:

- classify market conditions;
- select a strategy;
- propose LONG / SHORT / HOLD;
- explain its reasoning;
- review completed trades;
- generate hypotheses;
- suggest strategy parameter changes.

AI must **not** override:

- maximum leverage;
- maximum loss per trade;
- maximum daily loss;
- maximum account drawdown;
- maximum concurrent positions;
- exchange safety validation;
- minimum evidence required for strategy promotion.

---

## 2.2 Self-learning is evidence-based

A single losing trade must not immediately change the strategy.

Bad:

```text
Trade loses
↓
AI decides RSI threshold is wrong
↓
Threshold changed immediately
```

Preferred:

```text
Trade loses
↓
Reviewer generates hypothesis
↓
Hypothesis becomes PROVISIONAL lesson
↓
Similar trades accumulate
↓
Statistics validate or reject the pattern
↓
Lesson becomes REINFORCED / VERIFIED
↓
Evolution Agent may propose a challenger
```

---

## 2.3 Self-evolve does not mean self-modifying production code

Evolution should primarily change:

- strategy parameters;
- signal weights;
- strategy preference by market regime;
- confidence calibration;
- optional entry filters;
- optional exit parameters.

Example:

```yaml
strategy: TREND_FOLLOWING_V3

parameters:
  adx_min: 22
  volume_ratio_min: 1.10
  rsi_min: 48
  rsi_max: 68
  stop_atr: 1.5
  take_profit_atr: 3.0
```

The Evolution Agent may propose:

```yaml
strategy: TREND_FOLLOWING_V4

changes:
  adx_min:
    from: 22
    to: 27

reason:
  "Trades with ADX below 27 showed negative expectancy in the
   current evidence window."
```

V4 does **not** replace V3 automatically.

It becomes a challenger first.

---

# 3. Initial Trading Configuration

Recommended V1:

```yaml
exchange: okx
environment: demo

instrument:
  id: BTC-USDT-SWAP
  type: SWAP

timeframe: 15m

account:
  margin_mode: isolated
  position_mode: long_short_mode

leverage:
  default: 3
  hard_max: 5

risk:
  risk_per_trade_pct: 0.5
  max_daily_loss_pct: 3.0
  max_account_drawdown_pct: 10.0
  max_concurrent_positions: 1

decision:
  minimum_confidence: 0.70

learning:
  review_every_closed_trade: true
  signal_evolution_interval_trades: 20
  strategy_evolution_interval_trades: 50
  minimum_validation_sample: 30
```

For early experiments, keep leverage fixed.

Do not let the AI vary leverage yet.

---

# 4. OKX Terminology

## 4.1 Product type

For this project:

```text
SWAP
```

means perpetual futures.

Example:

```text
BTC-USDT-SWAP
ETH-USDT-SWAP
SOL-USDT-SWAP
```

OKX also exposes:

```text
FUTURES
```

for expiry futures.

V1 should use `SWAP`.

---

## 4.2 Position mode

Recommended:

```text
long_short_mode
```

This allows LONG and SHORT sides to be represented explicitly.

Typical mapping:

| Action | side | posSide |
|---|---|---|
| Open LONG | `buy` | `long` |
| Close LONG | `sell` | `long` |
| Open SHORT | `sell` | `short` |
| Close SHORT | `buy` | `short` |

---

## 4.3 Margin mode

V1:

```text
isolated
```

Reasons:

- easier to reason about risk per position;
- easier for testnet experiments;
- isolates position margin from the rest of the account.

Later, `cross` may be supported as a separate configuration.

---

# 5. OKX Demo Trading

## 5.1 Creating Demo API credentials

In OKX:

```text
Login
→ Trade
→ Demo Trading
→ Personal Center
→ Demo Trading API
→ Create Demo Trading API Key
```

Create credentials with trading permission.

Store:

```text
OKX_API_KEY
OKX_API_SECRET
OKX_PASSPHRASE
```

Never commit these values into Git.

Example `.env`:

```dotenv
OKX_API_KEY=...
OKX_API_SECRET=...
OKX_PASSPHRASE=...

OKX_DEMO=true
OKX_FLAG=1
```

---

## 5.2 Demo REST endpoint

OKX Demo Trading currently uses:

```text
https://openapi.okx.com
```

Authenticated demo REST calls must include:

```http
x-simulated-trading: 1
```

Important:

```text
Production REST domain and Demo REST domain may be the same.
The demo environment is distinguished by the demo API key and
the x-simulated-trading: 1 header.
```

---

## 5.3 Demo WebSocket endpoints

Public:

```text
wss://wspap.okx.com:8443/ws/v5/public
```

Private:

```text
wss://wspap.okx.com:8443/ws/v5/private
```

Business:

```text
wss://wspap.okx.com:8443/ws/v5/business
```

---

# 6. OKX REST Authentication

Private endpoints require:

```http
OK-ACCESS-KEY
OK-ACCESS-SIGN
OK-ACCESS-TIMESTAMP
OK-ACCESS-PASSPHRASE
Content-Type: application/json
```

For Demo:

```http
x-simulated-trading: 1
```

Signature pre-hash:

```text
timestamp + method + requestPath + body
```

Then:

```text
HMAC-SHA256(secret)
↓
Base64
```

Example conceptual implementation:

```text
prehash =
  timestamp
  + "POST"
  + "/api/v5/trade/order"
  + request_body_json

signature =
  Base64(
    HMAC_SHA256(
      secret,
      prehash
    )
  )
```

Use UTC timestamps.

Before running the trading engine, synchronize or compare local time with OKX server time.

Useful endpoint:

```http
GET /api/v5/public/time
```

---

# 7. Core OKX Endpoints

## 7.1 Server time

```http
GET /api/v5/public/time
```

Use this at startup and periodically for clock-drift detection.

---

## 7.2 Instruments

Public instrument information:

```http
GET /api/v5/public/instruments?instType=SWAP
```

Account-aware instrument information:

```http
GET /api/v5/account/instruments?instType=SWAP
```

Before sizing any order, cache instrument metadata such as:

```text
tickSz
lotSz
minSz
ctVal
ctValCcy
```

Do not assume:

```text
sz = BTC quantity
```

For OKX derivatives:

```text
sz = number of contracts
```

This is critical.

---

## 7.3 Candles

```http
GET /api/v5/market/candles
```

Example:

```http
GET /api/v5/market/candles?instId=BTC-USDT-SWAP&bar=15m&limit=300
```

Returned candle structure:

```text
[
  ts,
  open,
  high,
  low,
  close,
  vol,
  volCcy,
  volCcyQuote,
  confirm
]
```

`confirm` should be checked.

For a candle-close strategy, only use completed candles.

---

## 7.4 Historical candles

```http
GET /api/v5/market/history-candles
```

Use for:

- backtesting;
- warm-up;
- strategy validation;
- challenger evaluation.

---

## 7.5 Ticker

```http
GET /api/v5/market/ticker?instId=BTC-USDT-SWAP
```

Useful for:

- latest price;
- bid / ask;
- sanity checks before placing an order.

---

## 7.6 Order book

```http
GET /api/v5/market/books?instId=BTC-USDT-SWAP
```

Later versions can derive:

```text
spread
order-book imbalance
bid liquidity
ask liquidity
microstructure features
```

---

## 7.7 Balance

```http
GET /api/v5/account/balance
```

Use as one source for:

- available balance;
- equity;
- margin;
- risk calculations.

---

## 7.8 Positions

```http
GET /api/v5/account/positions?instId=BTC-USDT-SWAP
```

Use for reconciliation.

Do not trust only local state.

The exchange must remain the source of truth for open positions.

---

## 7.9 Set position mode

Conceptually configure:

```text
long_short_mode
```

before the bot begins trading.

This should happen during account initialization rather than before every order.

---

## 7.10 Set leverage

```http
POST /api/v5/account/set-leverage
```

For isolated long/short mode, leverage is position-side aware.

Example LONG side:

```json
{
  "instId": "BTC-USDT-SWAP",
  "lever": "3",
  "posSide": "long",
  "mgnMode": "isolated"
}
```

Example SHORT side:

```json
{
  "instId": "BTC-USDT-SWAP",
  "lever": "3",
  "posSide": "short",
  "mgnMode": "isolated"
}
```

Configure both at startup.

---

# 8. Demo Trade Walkthrough

The following is the intended first integration test.

It is **not yet the AI strategy**.

It is a simple exchange smoke test.

---

## Step 1 — Validate credentials

Call:

```http
GET /api/v5/account/balance
```

Expected:

```json
{
  "code": "0",
  "msg": "",
  "data": [...]
}
```

Abort startup when:

```text
code != "0"
```

---

## Step 2 — Read instrument metadata

```http
GET /api/v5/public/instruments?instType=SWAP&instId=BTC-USDT-SWAP
```

Cache:

```text
tickSz
lotSz
minSz
ctVal
```

Validate order size against this metadata.

---

## Step 3 — Set position mode

Set account position mode to:

```text
long_short_mode
```

Do this once during environment initialization.

---

## Step 4 — Set leverage

LONG:

```json
{
  "instId": "BTC-USDT-SWAP",
  "lever": "3",
  "mgnMode": "isolated",
  "posSide": "long"
}
```

SHORT:

```json
{
  "instId": "BTC-USDT-SWAP",
  "lever": "3",
  "mgnMode": "isolated",
  "posSide": "short"
}
```

---

# 9. Open Demo LONG

Endpoint:

```http
POST /api/v5/trade/order
```

Example market order:

```json
{
  "instId": "BTC-USDT-SWAP",
  "tdMode": "isolated",
  "side": "buy",
  "posSide": "long",
  "ordType": "market",
  "sz": "1",
  "clOrdId": "evo-demo-long-001"
}
```

Interpretation:

```text
instrument : BTC-USDT-SWAP
margin     : isolated
action     : buy
position   : long
type       : market
size       : 1 contract
```

Do **not** interpret `sz=1` as `1 BTC`.

---

# 10. Verify LONG Position

Query:

```http
GET /api/v5/account/positions?instId=BTC-USDT-SWAP
```

Record at minimum:

```text
posId
instId
posSide
pos
avgPx
markPx
lever
upl
mgnMode
```

Local state should be reconciled against OKX.

---

# 11. Close Demo LONG

Example:

```json
{
  "instId": "BTC-USDT-SWAP",
  "tdMode": "isolated",
  "side": "sell",
  "posSide": "long",
  "ordType": "market",
  "sz": "1",
  "clOrdId": "evo-demo-close-long-001"
}
```

After submission:

1. query order;
2. query position;
3. query fills;
4. write final trade record.

---

# 12. Open Demo SHORT

```json
{
  "instId": "BTC-USDT-SWAP",
  "tdMode": "isolated",
  "side": "sell",
  "posSide": "short",
  "ordType": "market",
  "sz": "1",
  "clOrdId": "evo-demo-short-001"
}
```

---

# 13. Close Demo SHORT

```json
{
  "instId": "BTC-USDT-SWAP",
  "tdMode": "isolated",
  "side": "buy",
  "posSide": "short",
  "ordType": "market",
  "sz": "1",
  "clOrdId": "evo-demo-close-short-001"
}
```

---

# 14. Order Lifecycle

Never assume a successful HTTP request means a completed trade.

Track:

```text
submitted
↓
live
↓
partially_filled
↓
filled
```

or:

```text
submitted
↓
canceled
```

Order detail:

```http
GET /api/v5/trade/order
```

Pending orders:

```http
GET /api/v5/trade/orders-pending
```

Fills:

```http
GET /api/v5/trade/fills
```

Historical fills:

```http
GET /api/v5/trade/fills-history
```

---

# 15. Client Order IDs

Every EvoQuant order should use `clOrdId`.

Example format:

```text
EVQ-BTC-L-20261001-000001
EVQ-BTC-L-CLOSE-20261001-000001
```

Store a relationship:

```text
internal_trade_id
↔
clOrdId
↔
OKX ordId
↔
OKX trade/fill IDs
```

This greatly simplifies reconciliation.

---

# 16. Stop Loss and Take Profit

The project may support two layers:

## Layer A — Exchange-native protection

Preferred for actual position protection.

Use OKX conditional / algo order capabilities.

Endpoint:

```http
POST /api/v5/trade/order-algo
```

Possible concepts include:

```text
take-profit
stop-loss
conditional orders
trigger orders
trailing orders
```

## Layer B — Position Manager

The AI Position Manager may suggest:

```text
HOLD
CLOSE
MOVE_STOP
PARTIAL_TAKE_PROFIT
```

However, an exchange-native stop should remain active whenever possible.

AI must not be the only protection against an adverse move.

---

# 17. Market Data Pipeline

Initial input:

```text
BTC-USDT-SWAP 15m candles
```

Feature pipeline:

```text
OHLCV
  ↓
EMA
RSI
ATR
ADX
Volume Ratio
Return
Volatility
Trend Strength
  ↓
Market Regime
```

Later:

```text
Funding
Open Interest
Order Book
Long/Short metrics
Liquidation-related signals
```

may be added as separate feature providers.

---

# 18. Initial Feature Set

Recommended V1:

```yaml
features:

  trend:
    - ema_20
    - ema_50
    - ema_spread_pct

  momentum:
    - rsi_14
    - adx_14

  volatility:
    - atr_14
    - atr_pct

  volume:
    - volume
    - volume_sma_20
    - volume_ratio
```

Derived values:

```text
EMA spread %
ATR %
Volume ratio
distance from EMA
candle body %
upper/lower wick %
```

---

# 19. Market Regime Classifier

Initial regimes:

```text
TRENDING_BULLISH
TRENDING_BEARISH
SIDEWAYS
HIGH_VOLATILITY
LOW_VOLATILITY
UNKNOWN
```

Example deterministic baseline:

```text
ADX high
+
EMA20 > EMA50
→ TRENDING_BULLISH
```

```text
ADX high
+
EMA20 < EMA50
→ TRENDING_BEARISH
```

```text
ADX low
+
small EMA spread
→ SIDEWAYS
```

The classifier may later evolve independently.

---

# 20. Strategy Library

V1:

```text
TREND_FOLLOWING_V1
BREAKOUT_V1
MEAN_REVERSION_V1
```

Example registry:

```yaml
TREND_FOLLOWING_V1:
  enabled: true

  allowed_regimes:
    - TRENDING_BULLISH
    - TRENDING_BEARISH

  parameters:
    adx_min: 22
    volume_ratio_min: 1.10
    stop_atr: 1.5
    take_profit_atr: 3.0
```

Each strategy must have a version.

Never mutate a historical strategy version.

---

# 21. Decision Agent

Input example:

```json
{
  "instrument": "BTC-USDT-SWAP",
  "timeframe": "15m",

  "market": {
    "regime": "TRENDING_BULLISH",
    "price": 68450,
    "ema20": 68130,
    "ema50": 67580,
    "rsi14": 58.4,
    "adx14": 31.2,
    "atr14": 620,
    "volume_ratio": 1.38
  },

  "strategy_memory": {
    "TREND_FOLLOWING_V1": {
      "regime_win_rate": 0.61,
      "regime_expectancy_r": 0.31
    }
  },

  "lessons": []
}
```

Required output:

```json
{
  "decision": "LONG",
  "strategy": "TREND_FOLLOWING_V1",
  "confidence": 0.81,

  "thesis": [
    "Trend direction is bullish",
    "ADX indicates sufficient trend strength",
    "Volume confirms participation"
  ],

  "invalidations": [
    "Trend strength collapses",
    "Price closes below configured stop level"
  ],

  "suggested_stop_atr": 1.5,
  "suggested_take_profit_atr": 3.0
}
```

Allowed decision enum:

```text
LONG
SHORT
HOLD
CLOSE
```

No arbitrary strings.

---

# 22. Deterministic Risk Engine

The Risk Engine has final authority.

Example:

```text
Decision Agent
LONG
confidence 81%
        │
        ▼
Risk Engine
        │
        ├─ confidence >= 70% ? PASS
        ├─ valid regime ? PASS
        ├─ valid strategy ? PASS
        ├─ position already open ? NO
        ├─ daily loss < 3% ? PASS
        ├─ drawdown < 10% ? PASS
        ├─ risk <= 0.5% ? PASS
        ├─ leverage <= hard max ? PASS
        └─ order size valid ? PASS
        │
        ▼
APPROVED
```

Hard rejection example:

```json
{
  "approved": false,
  "reason": "MAX_DAILY_LOSS_REACHED"
}
```

AI cannot override this result.

---

# 23. Risk Limits

Recommended V1:

```yaml
hard_limits:

  risk_per_trade_pct: 0.5

  max_daily_loss_pct: 3.0

  max_drawdown_pct: 10.0

  max_leverage: 5

  max_concurrent_positions: 1

  allowed_symbols:
    - BTC-USDT-SWAP
```

Kill-switch conditions:

```text
API state uncertain
exchange/local position mismatch
repeated order failure
clock drift
database unavailable
invalid instrument metadata
unexpected position exists
max daily loss reached
max account drawdown reached
```

When a kill switch is active:

```text
NO NEW ENTRIES
```

---

# 24. Position Sizing

Position sizing must be based on:

```text
account equity
risk %
stop distance
contract specification
lot size
minimum size
```

Conceptually:

```text
risk_budget =
    account_equity
    × risk_per_trade
```

Then determine allowed notional from stop distance.

After that convert the desired notional/base quantity into:

```text
OKX contract quantity
```

using current instrument metadata.

Always normalize to:

```text
lotSz
minSz
```

and validate against OKX before submission.

Never hardcode BTC contract conversion.

---

# 25. Position Manager

The Position Manager runs while a trade is open.

Possible decisions:

```text
HOLD
CLOSE
PARTIAL_CLOSE
MOVE_STOP
```

V1 should keep this simple:

```text
exchange SL
exchange TP
optional early CLOSE
```

Avoid allowing the AI to repeatedly move the stop farther from entry.

Recommended invariant:

```text
AI may reduce risk.
AI may not increase maximum planned loss.
```

---

# 26. Trade Record

Every trade must preserve the complete context at entry.

Example:

```json
{
  "trade_id": "TRD-000001",

  "exchange": "OKX",
  "environment": "DEMO",

  "instrument": "BTC-USDT-SWAP",
  "timeframe": "15m",

  "strategy": {
    "name": "TREND_FOLLOWING",
    "version": 1
  },

  "entry_snapshot": {
    "regime": "TRENDING_BULLISH",

    "price": 68450,

    "features": {
      "ema20": 68130,
      "ema50": 67580,
      "rsi14": 58.4,
      "adx14": 31.2,
      "atr14": 620,
      "volume_ratio": 1.38
    }
  },

  "decision": {
    "action": "LONG",
    "raw_confidence": 0.81,
    "calibrated_confidence": 0.74
  },

  "risk": {
    "planned_risk_pct": 0.5,
    "leverage": 3
  }
}
```

---

# 27. Closed Trade Metrics

At close calculate:

```text
realized PnL
PnL %
R multiple
fees
funding if applicable
duration
MFE
MAE
entry slippage
exit slippage
planned vs actual risk
```

Definitions:

```text
MFE = Maximum Favorable Excursion
MAE = Maximum Adverse Excursion
```

These are extremely useful for learning.

---

# 28. Post-Trade Reviewer

The Reviewer receives:

```text
entry snapshot
decision
strategy
price path
exit reason
trade result
MFE
MAE
market regime
```

It produces hypotheses.

Example:

```json
{
  "outcome": "LOSS",
  "result_r": -1.0,

  "observations": [
    {
      "factor": "market_regime",
      "effect": "negative",
      "evidence": "Classifier returned SIDEWAYS after entry"
    },
    {
      "factor": "volume",
      "effect": "negative",
      "evidence": "volume_ratio=0.74"
    }
  ],

  "lesson_candidates": [
    {
      "statement":
        "Trend-following entries may underperform when volume ratio is below 0.8.",
      "confidence": 0.35
    }
  ]
}
```

Important:

```text
AI review = hypothesis

NOT

AI review = proven truth
```

---

# 29. Lesson Memory

Lesson states:

```text
PROVISIONAL
REINFORCED
VERIFIED
CONFLICTED
SUPERSEDED
REJECTED
```

Example:

```json
{
  "lesson_id": "LESSON-00023",

  "statement":
    "Breakout trades may underperform when volume_ratio < 1.15.",

  "status": "PROVISIONAL",

  "scope": {
    "strategy": "BREAKOUT",
    "instrument": "BTC-USDT-SWAP",
    "regime": "TRENDING_BULLISH"
  },

  "evidence": {
    "observations": 6,
    "wins": 1,
    "losses": 5,
    "expectancy_r": -0.41
  },

  "confidence": 0.52
}
```

---

# 30. Lesson Verification

Do not verify lessons using only win rate.

Check:

```text
sample size
expectancy
profit factor
average R
loss distribution
regime consistency
time-window consistency
out-of-sample behavior
```

Possible transition:

```text
PROVISIONAL
    ↓
minimum evidence reached
    ↓
REINFORCED
    ↓
validated on another sample
    ↓
VERIFIED
```

If contradictory evidence appears:

```text
CONFLICTED
```

---

# 31. Signal Weight Evolution

Initial:

```json
{
  "trend": 1.0,
  "momentum": 1.0,
  "volume": 1.0,
  "volatility": 1.0
}
```

After sufficient trades:

```json
{
  "trend": 1.24,
  "momentum": 0.91,
  "volume": 1.31,
  "volatility": 0.86
}
```

Do not update after every trade.

Recommended V1:

```text
every 20 closed trades
```

with bounded changes.

Example constraint:

```text
max weight change per evolution cycle = ±10%
```

---

# 32. Regime Memory

Store performance separately by:

```text
strategy
instrument
timeframe
direction
market regime
```

Example:

```json
{
  "TRENDING_BULLISH": {

    "TREND_FOLLOWING_V1": {
      "LONG": {
        "trades": 42,
        "wins": 28,
        "win_rate": 0.667,
        "expectancy_r": 0.39
      },

      "SHORT": {
        "trades": 11,
        "wins": 3,
        "win_rate": 0.273,
        "expectancy_r": -0.32
      }
    }
  }
}
```

This is much more useful than a global win rate.

---

# 33. Confidence Calibration

The Decision Agent may say:

```text
confidence = 90%
```

but historical performance may show:

```text
trades with AI confidence 0.90–1.00
actual win rate = 59%
```

The system should derive:

```text
raw confidence
↓
confidence calibrator
↓
calibrated confidence
```

Example:

```text
raw        0.91
calibrated 0.66
```

The Risk Engine should use calibrated confidence.

---

# 34. Strategy Evolution

Recommended interval:

```text
every 50 closed trades
```

Evolution Agent reviews:

```text
strategy statistics
verified lessons
regime performance
signal weights
confidence calibration
MFE / MAE
entry / exit quality
```

It may propose:

```yaml
candidate:
  name: TREND_FOLLOWING
  version: 2

  parent: TREND_FOLLOWING_V1

  changes:
    adx_min:
      old: 22
      new: 27

  hypothesis:
    "Removing weak-trend setups may improve expectancy."

  evidence:
    trades_analyzed: 73
```

---

# 35. Champion vs Challenger

Current production/demo strategy:

```text
CHAMPION
TREND_FOLLOWING_V1
```

Evolution creates:

```text
CHALLENGER
TREND_FOLLOWING_V2
```

Evaluation:

```text
historical backtest
+
walk-forward validation
+
demo forward performance
```

Comparison metrics:

```text
expectancy
profit factor
max drawdown
average R
Sharpe-like risk-adjusted metric
sample size
performance by regime
```

Promotion example:

```text
                 V1        V2

Trades           320       318
Win Rate         53%       57%
Expectancy       .24R      .36R
Profit Factor    1.43      1.69
Max DD           8.7%      6.1%
```

Only then:

```text
V2 → CHAMPION
```

Otherwise:

```text
V2 → REJECTED
```

---

# 36. Anti-Overfitting Rules

Evolution must obey:

```text
minimum sample size
bounded parameter changes
maximum number of simultaneous changes
out-of-sample validation
walk-forward validation
strategy versioning
rollback support
```

Recommended:

```text
one or two parameter changes per challenger
```

Do not let an agent rewrite ten thresholds simultaneously.

Otherwise it becomes impossible to determine which change caused the performance difference.

---

# 37. Recommended Agent Roles

## Opportunity Agent

Purpose:

```text
Should the market be evaluated for a trade?
```

Can cheaply filter obvious no-trade conditions.

---

## Decision Agent

Purpose:

```text
LONG / SHORT / HOLD
```

Uses:

```text
market features
regime
strategy library
verified lessons
historical strategy memory
```

---

## Position Manager

Purpose:

```text
HOLD / CLOSE
```

Later:

```text
partial TP
move stop
```

---

## Trade Reviewer

Purpose:

```text
Why did this trade win or lose?
What assumptions were correct?
What assumptions failed?
```

Generates hypotheses only.

---

## Evolution Agent

Purpose:

```text
Find recurring patterns.
Propose bounded changes.
Create challenger strategy.
```

It does not promote itself.

---

# 38. Non-AI Components

These should remain deterministic:

```text
OKX Client
Market Data Collector
Indicator Engine
Risk Engine
Position Sizing
Order Executor
State Reconciliation
PnL Calculator
Performance Statistics
Lesson Validator
Strategy Evaluator
Kill Switch
```

---

# 39. Proposed Project Structure

```text
evoquant/
│
├── src/
│   │
│   ├── agents/
│   │   ├── opportunity-agent.ts
│   │   ├── decision-agent.ts
│   │   ├── position-agent.ts
│   │   ├── reviewer-agent.ts
│   │   └── evolution-agent.ts
│   │
│   ├── exchange/
│   │   └── okx/
│   │       ├── client.ts
│   │       ├── auth.ts
│   │       ├── market.ts
│   │       ├── account.ts
│   │       ├── orders.ts
│   │       ├── positions.ts
│   │       ├── websocket.ts
│   │       └── instruments.ts
│   │
│   ├── market/
│   │   ├── indicators.ts
│   │   ├── features.ts
│   │   └── regime.ts
│   │
│   ├── strategy/
│   │   ├── strategy.ts
│   │   ├── library.ts
│   │   ├── scorer.ts
│   │   └── registry.ts
│   │
│   ├── risk/
│   │   ├── engine.ts
│   │   ├── limits.ts
│   │   └── position-sizing.ts
│   │
│   ├── execution/
│   │   ├── executor.ts
│   │   ├── reconciliation.ts
│   │   └── lifecycle.ts
│   │
│   ├── learning/
│   │   ├── trade-review.ts
│   │   ├── lessons.ts
│   │   ├── lesson-validator.ts
│   │   ├── signal-weights.ts
│   │   ├── confidence.ts
│   │   └── evolution.ts
│   │
│   ├── evaluation/
│   │   ├── performance.ts
│   │   ├── backtest.ts
│   │   ├── walk-forward.ts
│   │   └── champion-challenger.ts
│   │
│   ├── memory/
│   │   ├── decisions.ts
│   │   ├── trades.ts
│   │   ├── lessons.ts
│   │   ├── regimes.ts
│   │   └── strategies.ts
│   │
│   └── core/
│       ├── scheduler.ts
│       ├── state.ts
│       └── logger.ts
│
├── config/
│   ├── trading.yaml
│   ├── risk.yaml
│   ├── evolution.yaml
│   └── agents.yaml
│
├── data/
│   ├── trader.db
│   └── snapshots/
│
├── prompts/
│   ├── decision.md
│   ├── review.md
│   └── evolution.md
│
├── tests/
│
├── .env.example
├── AGENTS.md
└── README.md
```

---

# 40. Suggested Database Tables

```text
instruments
candles
market_snapshots
decisions
orders
fills
positions
trades
trade_reviews
lessons
lesson_evidence
strategies
strategy_versions
strategy_metrics
signal_weights
regime_metrics
evolution_runs
challengers
system_events
```

---

# 41. Decision Log

Every decision must be recorded, including HOLD.

Example:

```json
{
  "decision_id": "DEC-000932",

  "timestamp": "2026-10-01T12:00:00Z",

  "instrument": "BTC-USDT-SWAP",

  "decision": "HOLD",

  "strategy": "TREND_FOLLOWING_V1",

  "regime": "SIDEWAYS",

  "reason": [
    "Trend strength below minimum",
    "Volume confirmation absent"
  ]
}
```

Why store HOLD?

Because later the system can answer:

```text
Did we avoid bad trades correctly?

Did HOLD decisions miss profitable moves?
```

This prevents learning only from executed trades.

---

# 42. Main Trading Loop

```text
START
  │
  ▼
Validate OKX connection
  │
  ▼
Sync server time
  │
  ▼
Load instrument metadata
  │
  ▼
Load strategies / lessons / weights
  │
  ▼
Reconcile exchange positions
  │
  ▼
Wait for confirmed 15m candle close
  │
  ▼
Collect market data
  │
  ▼
Build feature snapshot
  │
  ▼
Classify regime
  │
  ▼
Opportunity filter
  │
  ▼
Decision Agent
  │
  ▼
Store decision
  │
  ▼
Risk Engine
  │
  ├── REJECT → log → wait
  │
  ▼
Position sizing
  │
  ▼
Submit OKX Demo order
  │
  ▼
Confirm fill
  │
  ▼
Protect position
  │
  ▼
Monitor
  │
  ▼
Position closes
  │
  ▼
Calculate metrics
  │
  ▼
Trade Reviewer
  │
  ▼
Lesson Validator
  │
  ▼
Update memory
  │
  ▼
Evolution interval reached?
  │
  ├── NO → wait
  │
  ▼
Evolution Agent
  │
  ▼
Create challenger
  │
  ▼
Evaluate
  │
  ▼
Promote / Reject
```

---

# 43. Startup Safety Sequence

At startup:

```text
1. Environment must equal DEMO.
2. Verify Demo API credentials.
3. Verify x-simulated-trading header is active.
4. Query balance.
5. Query server time.
6. Query instrument metadata.
7. Query existing positions.
8. Query pending orders.
9. Reconcile local DB.
10. Verify risk limits.
11. Verify position mode.
12. Verify leverage.
13. Only then enable decision execution.
```

For V1, strongly consider:

```text
ALLOW_LIVE_TRADING=false
```

and refuse to start if changed accidentally.

---

# 44. Demo-Only Hard Guard

Recommended code-level invariant:

```text
if environment != "demo":
    abort()
```

and:

```text
if x_simulated_trading != "1":
    abort()
```

Do not rely only on configuration comments.

---

# 45. Recovery After Restart

Never assume memory state matches the exchange.

Recovery flow:

```text
restart
↓
load local state
↓
query OKX positions
↓
query pending orders
↓
query recent fills
↓
reconcile
```

If mismatch:

```text
STATE_UNCERTAIN
```

Then:

```text
NO NEW TRADES
```

until resolved.

---

# 46. Initial Development Milestones

## Milestone 1 — OKX Demo Adapter

Implement:

```text
authentication
server time
balance
instrument metadata
candles
position mode
leverage
place order
query order
query fills
query position
close position
```

Success criteria:

```text
Automatically:
open demo LONG
verify
close demo LONG
open demo SHORT
verify
close demo SHORT
```

No AI yet.

---

## Milestone 2 — Deterministic Trading Core

Implement:

```text
15m scheduler
indicators
market regime
risk engine
position sizing
trade storage
PnL calculation
MFE / MAE
```

---

## Milestone 3 — Decision Agent

Add:

```text
LONG
SHORT
HOLD
```

using structured JSON output.

Still no evolution.

---

## Milestone 4 — Trade Reviewer

Every completed trade gets:

```text
post-trade analysis
lesson candidates
factor attribution
```

---

## Milestone 5 — Learning Memory

Implement:

```text
lesson states
regime statistics
strategy statistics
direction statistics
signal statistics
```

---

## Milestone 6 — Evolution

Implement:

```text
signal weighting
confidence calibration
strategy challenger generation
```

---

## Milestone 7 — Champion vs Challenger

Implement:

```text
backtest
walk-forward test
demo forward comparison
promotion rules
rollback
```

---

# 47. V1 Acceptance Criteria

The V1 system is successful when it can:

- connect to OKX Demo;
- never send live orders;
- read `BTC-USDT-SWAP` market data;
- retrieve and use instrument contract metadata;
- open and close LONG positions;
- open and close SHORT positions;
- persist orders and fills;
- reconcile positions after restart;
- compute closed-trade performance;
- generate structured AI decisions;
- enforce deterministic risk limits;
- perform post-trade reviews;
- accumulate lessons;
- distinguish provisional from verified lessons;
- create a challenger strategy;
- evaluate champion vs challenger;
- keep full audit logs for every decision.

---

# 48. What Must Not Evolve Automatically

These should remain hard-controlled:

```text
live/demo environment
exchange API credentials
maximum leverage
maximum risk per trade
maximum daily loss
maximum account drawdown
allowed symbols
maximum concurrent positions
strategy promotion criteria
kill-switch behavior
database integrity policy
```

The Evolution Agent may recommend changes for human review, but it must not apply them automatically.

---

# 49. Recommended First Experiment

Run only:

```text
Exchange:
OKX Demo

Instrument:
BTC-USDT-SWAP

Timeframe:
15m

Margin:
Isolated

Position Mode:
Long / Short

Leverage:
3x

Concurrent Position:
1

Risk:
0.5% / trade

Daily Stop:
3%

Strategies:
TREND_FOLLOWING_V1
BREAKOUT_V1
MEAN_REVERSION_V1
```

Evolution schedule:

```text
Every closed trade:
Post-trade review

Every 20 closed trades:
Signal-weight analysis

Every 50 closed trades:
Strategy evolution proposal

Every challenger:
Historical + walk-forward validation

Only validated challengers:
Eligible for demo forward comparison
```

---

# 50. Recommended Initial Strategy Selection Logic

Example:

```text
TRENDING_BULLISH
→ prefer LONG Trend Following
→ secondary Breakout

TRENDING_BEARISH
→ prefer SHORT Trend Following
→ secondary Breakout

SIDEWAYS
→ prefer Mean Reversion

HIGH_VOLATILITY
→ reduced size / stricter filtering

UNKNOWN
→ HOLD
```

This logic provides a deterministic baseline that the AI can reason around.

---

# 51. Observability

Log at minimum:

```text
market snapshot
regime
strategy considered
decision
AI raw confidence
calibrated confidence
risk decision
position size
OKX order request
OKX order response
fill
position update
close
PnL
MFE
MAE
review
lesson
evolution proposal
promotion/rejection decision
```

Never log:

```text
API secret
passphrase
raw authentication signature
```

---

# 52. Metrics Dashboard

Useful metrics:

```text
Total Trades
Win Rate
Average Win R
Average Loss R
Expectancy
Profit Factor
Max Drawdown
Current Drawdown
Long Win Rate
Short Win Rate
Performance by Regime
Performance by Strategy
Confidence Calibration
Lesson Count
Verified Lesson Count
Champion Version
Challenger Version
```

---

# 53. Important Research Warning

A post-trade explanation is not necessarily the true causal reason for a win or loss.

For example:

```text
"We lost because volume was low."
```

may sound plausible but remain false.

Therefore:

```text
LLM
=
hypothesis generator

Statistics
=
evidence validator
```

Self-evolution should be based on repeated evidence rather than compelling explanations.

---

# 54. OKX References

Official OKX API documentation:

```text
https://www.okx.com/docs-v5/en/
```

Relevant sections include:

```text
Overview
Demo Trading Services
REST Authentication
WebSocket
Market Data
Trading Account
Trade
Algo Trading
```

Core endpoint references used by this specification:

```text
GET  /api/v5/public/time

GET  /api/v5/public/instruments
GET  /api/v5/account/instruments

GET  /api/v5/market/ticker
GET  /api/v5/market/candles
GET  /api/v5/market/history-candles
GET  /api/v5/market/books

GET  /api/v5/account/balance
GET  /api/v5/account/positions

POST /api/v5/account/set-leverage

POST /api/v5/trade/order
GET  /api/v5/trade/order
GET  /api/v5/trade/orders-pending
GET  /api/v5/trade/fills
GET  /api/v5/trade/fills-history

POST /api/v5/trade/order-algo
```

Python wrapper reference used in OKX examples:

```text
https://github.com/okxapi/python-okx
```

Note: the repository itself describes the wrapper as unofficial even though it is hosted under the `okxapi` GitHub organization. The primary source of truth for API behavior should remain the official OKX V5 API documentation.

---

# 55. Final V1 Architecture

```text
                         OKX DEMO
                            │
              ┌─────────────┴─────────────┐
              │                           │
         REST / WS                    Account State
              │                           │
              └─────────────┬─────────────┘
                            ▼
                    Market Collector
                            │
                            ▼
                     Feature Engine
                            │
                            ▼
                    Regime Classifier
                            │
                            ▼
                    Opportunity Filter
                            │
                            ▼
                     Decision Agent
                            │
                LONG / SHORT / HOLD
                            │
                            ▼
                      Risk Engine
                     deterministic
                            │
                            ▼
                    Position Sizing
                            │
                            ▼
                      OKX Executor
                            │
                            ▼
                    Position Manager
                            │
                            ▼
                       Trade Closed
                            │
                            ▼
                   Performance Engine
                            │
                            ▼
                     Trade Reviewer
                            │
                    hypothesis only
                            │
                            ▼
                    Lesson Validator
                            │
                            ▼
                    Trading Memory
                     /      |      \
                    /       |       \
             Strategy    Regime    Signals
              Memory     Memory    Weights
                    \       |       /
                     \      |      /
                            ▼
                    Evolution Agent
                            │
                            ▼
                      Challenger
                            │
                            ▼
                       Evaluation
                            │
                 ┌──────────┴──────────┐
                 ▼                     ▼
               REJECT               PROMOTE
                                       │
                                       ▼
                                 NEW CHAMPION
```

---

# 56. Development Rule

The first real milestone is **not profitable trading**.

The first milestone is:

```text
A deterministic, observable, recoverable OKX Demo trading engine
that can safely open/close futures positions and preserve enough
data for meaningful learning.
```

Only after that foundation is reliable should self-learning and self-evolution be trusted.
---

# 57. EvoQuant UI / UX Specification

## 57.1 UI Objective

The EvoQuant UI should behave like a professional quantitative trading operations console.

It should prioritize:

```text
Clarity
Risk visibility
Trading state
Decision traceability
Learning visibility
Operational safety
Fast scanning
```

It should **not** look like:

```text
a crypto casino
a neon trading terminal
an AI chatbot dashboard
a game
an overly decorative analytics template
```

The interface should feel closer to:

```text
professional trading workstation
quant research dashboard
observability platform
risk-management console
```

Recommended visual direction:

```text
Flat Design
Minimal
Dense but readable
Professional
Data-first
Responsive
Low visual noise
```

---

# 58. Recommended UI Stack

Recommended web stack:

```text
Next.js
TypeScript
React
Tailwind CSS
shadcn/ui
TanStack Query
TanStack Table
Lightweight Charts / TradingView Lightweight Charts
Recharts for analytical charts
Lucide Icons
```

Optional:

```text
Zustand
```

for local UI state.

Avoid unnecessary heavy UI frameworks when the same result can be achieved with small reusable components.

---

# 59. Visual Design System

## 59.1 Theme

Recommended default:

```text
Dark mode
```

because the application is intended to remain open for long monitoring sessions.

Also support:

```text
Light mode
System mode
```

---

## 59.2 Color Philosophy

Colors should communicate status, not decorate the page.

Use semantic roles:

```text
Positive / Profit      → green
Negative / Loss        → red
Warning                → amber
Information            → blue
Neutral                → gray
Critical Risk          → strong red
Demo Environment       → blue / indigo badge
Live Environment       → strong warning treatment
```

Avoid:

```text
large gradients
neon glows
rainbow indicators
oversaturated crypto colors
```

---

## 59.3 Typography

Recommended:

```text
Primary:
Inter
Geist
IBM Plex Sans

Monospace:
JetBrains Mono
IBM Plex Mono
```

Use monospace selectively for:

```text
prices
PnL
order IDs
trade IDs
API state
strategy version
timestamps
raw metrics
```

---

## 59.4 Spacing

The interface should be compact but not cramped.

Recommended:

```text
Page padding desktop: 24–32 px
Card gap: 16–20 px
Card padding: 16–20 px
Section spacing: 24–32 px
```

Avoid oversized empty spaces commonly found in marketing dashboards.

This is an operational system.

---

# 60. Main Navigation

Recommended sidebar:

```text
EvoQuant

Dashboard
Markets
Trades
Strategies
Evolution
Memory
Risk
Logs

Settings
```

Possible icon mapping:

```text
Dashboard    → LayoutDashboard
Markets      → CandlestickChart
Trades       → ArrowLeftRight
Strategies   → GitBranch
Evolution    → Dna
Memory       → Brain
Risk         → ShieldAlert
Logs         → ScrollText
Settings     → Settings
```

Navigation should remain simple.

Do not create separate pages unless the page represents a meaningful operational domain.

---

# 61. Global Header

The global header should show:

```text
Current Environment
Exchange
Connection State
Current Instrument
Current Timeframe
Bot State
Emergency Stop
```

Example:

```text
EvoQuant

OKX · DEMO
BTC-USDT-SWAP
15m

● Connected

BOT: RUNNING

[ PAUSE ] [ EMERGENCY STOP ]
```

The Demo badge must always remain visible.

For V1:

```text
LIVE trading UI should not exist,
or should remain disabled.
```

---

# 62. Dashboard Page

The Dashboard should answer:

```text
Is the bot healthy?
What is it doing?
Are we currently in a trade?
How is it performing?
What is the current risk?
What did the AI decide recently?
```

Recommended layout:

```text
┌───────────────────────────────────────────────────────────┐
│ Header                                                    │
├───────────────────────────────────────────────────────────┤
│ Equity │ Daily PnL │ Drawdown │ Win Rate │ Bot Status    │
├───────────────────────────────────────┬───────────────────┤
│                                       │ Current Position  │
│ Price Chart                           │                   │
│                                       │ Side              │
│                                       │ Entry             │
│                                       │ Mark              │
│                                       │ SL                │
│                                       │ TP                │
│                                       │ PnL               │
├───────────────────────────────────────┴───────────────────┤
│ Latest Decision                                           │
├───────────────────────────────────────────────────────────┤
│ Strategy Performance       │ Market Regime Performance    │
├───────────────────────────────────────────────────────────┤
│ Recent Trades                                             │
└───────────────────────────────────────────────────────────┘
```

---

# 63. Dashboard KPI Cards

Recommended top-level metrics:

```text
Demo Equity
Today PnL
Total PnL
Current Drawdown
Max Drawdown
Win Rate
Profit Factor
Open Position
```

Do not display every available metric at the top.

Secondary analytics belong on dedicated pages.

---

# 64. Trading Chart

The Dashboard primary chart should show:

```text
Candlestick chart
Entry
Exit
Stop Loss
Take Profit
Current price
EMA20
EMA50
```

Optional toggles:

```text
Volume
RSI
ADX
ATR
```

Entry marker:

```text
LONG
SHORT
```

Exit marker:

```text
TP
SL
MANUAL
AI_CLOSE
RISK_CLOSE
```

The chart must remain readable.

Do not enable all indicators by default.

---

# 65. Current Position Card

When no position exists:

```text
NO OPEN POSITION
```

Show:

```text
Last decision
Reason for HOLD
Next evaluation time
```

When position exists:

```text
BTC-USDT-SWAP

LONG
3x Isolated

Entry       68,450
Mark        68,920

Contracts   4
PnL         +0.63%
PnL         +0.42R

Stop        67,830
Take Profit 69,690

Duration    01:42:16
```

Also show:

```text
Strategy:
TREND_FOLLOWING_V3

Market Regime:
TRENDING_BULLISH
```

---

# 66. Latest Decision Panel

This is one of EvoQuant's most important UI components.

Example:

```text
Decision

LONG
Confidence 81%
Calibrated 74%

Strategy
TREND_FOLLOWING_V3

Regime
TRENDING_BULLISH
```

Reasoning:

```text
✓ EMA20 above EMA50
✓ ADX indicates strong trend
✓ Volume ratio above threshold

⚠ Entry distance slightly extended
```

Then:

```text
Risk Engine
APPROVED
```

or:

```text
Risk Engine
REJECTED

MAX_DAILY_LOSS_REACHED
```

The distinction between:

```text
AI Decision
```

and:

```text
Risk Engine Decision
```

must always be visually obvious.

---

# 67. Markets Page

Purpose:

```text
Inspect current market conditions
and the inputs used by EvoQuant.
```

V1 can contain only:

```text
BTC-USDT-SWAP
```

but architecture should support multiple instruments later.

Recommended content:

```text
Price
24h Change
Volume
Funding
Open Interest
Regime
Volatility
Trend Strength
```

Main sections:

```text
Market Chart
Feature Snapshot
Market Regime
Signal Scores
Raw Market Data
```

---

# 68. Feature Snapshot

Example:

```text
Trend

EMA20           68,130
EMA50           67,580
EMA Spread      +0.81%

Momentum

RSI             58.4
ADX             31.2

Volatility

ATR             620
ATR %           0.91%

Volume

Volume Ratio    1.38
```

Every feature can have:

```text
value
normalized score
signal direction
weight
```

Example:

```text
Trend

Raw Score       +0.82
Weight          1.24
Weighted Score  +1.02
```

This makes evolution transparent.

---

# 69. Trades Page

The Trades page should be a searchable and filterable table.

Columns:

```text
Trade ID
Time
Symbol
Side
Strategy
Regime
Entry
Exit
R
PnL
Duration
Result
Review
```

Filters:

```text
WIN
LOSS

LONG
SHORT

Strategy

Regime

Date range
```

Selecting a trade opens:

```text
Trade Detail
```

---

# 70. Trade Detail Page

Recommended layout:

```text
Trade Overview
Chart Replay
Decision Snapshot
Market Snapshot
Execution Details
Risk Details
Post-Trade Review
Lesson Candidates
```

Header example:

```text
TRD-000231

BTC-USDT-SWAP
SHORT

RESULT
+1.82R

STRATEGY
TREND_FOLLOWING_V3
```

---

# 71. Trade Replay

Trade Detail should optionally visualize:

```text
candles before entry
entry
price path while open
MFE point
MAE point
exit
```

This makes AI review auditable.

Example markers:

```text
ENTRY
MAE
MFE
EXIT
```

---

# 72. Post-Trade Review UI

Show structured factors.

Example:

```text
Why this trade won

Positive Contributors

Trend Alignment       Strong
Volume Confirmation   Strong
Open Interest         Moderate
Entry Timing          Good

Negative Contributors

Stop Width            Slightly Wide
Entry Delay           Minor
```

Then:

```text
Lesson Candidate

"Trend-following short setups appear stronger
when volume expands with open interest."

Status:
PROVISIONAL

Confidence:
42%
```

Do not present AI explanations as confirmed facts.

---

# 73. Strategies Page

Purpose:

```text
Understand what strategies exist,
their versions,
and how they perform.
```

Example cards:

```text
TREND_FOLLOWING

Champion
V3

Win Rate        58%
Expectancy      +0.31R
Profit Factor   1.62
Max DD          5.8%

Trades          84
```

Show performance by:

```text
regime
direction
instrument
timeframe
```

---

# 74. Strategy Detail

Example:

```text
TREND_FOLLOWING_V3

Status:
CHAMPION

Parent:
V2

Created:
2026-09-28
```

Parameters:

```text
ADX Min           27
Volume Ratio Min  1.10
RSI Min           48
RSI Max           68
Stop ATR          1.5
TP ATR            3.0
```

Also display:

```text
Version History
Change History
Promotion Evidence
Rejected Challengers
```

---

# 75. Evolution Page

This should be the unique feature of EvoQuant.

It should clearly answer:

```text
What is EvoQuant learning?
What changes are being proposed?
Why?
What evidence supports the change?
Was it promoted or rejected?
```

Recommended layout:

```text
Current Champion
↓
Evolution Runs
↓
Active Challenger
↓
Comparison
↓
Promotion History
```

---

# 76. Champion vs Challenger UI

Example:

```text
TREND_FOLLOWING

Champion V3
vs
Challenger V4
```

Comparison table:

```text
Metric             V3        V4

Trades             320       318
Win Rate           53%       57%
Expectancy         .24R      .36R
Profit Factor      1.43      1.69
Max Drawdown       8.7%      6.1%
```

Evidence:

```text
Proposed Change

ADX_MIN
22 → 27

Hypothesis

Weak-trend entries create
negative expectancy.
```

Result:

```text
PROMOTED
```

or:

```text
REJECTED
```

The UI should show **why**.

---

# 77. Evolution Timeline

Example:

```text
V1
│
├── V2
│   Increased ADX threshold
│
├── V3
│   Improved volume filter
│
└── V4 Challenger
    Testing...
```

Possible statuses:

```text
CHAMPION
CHALLENGER
PROMOTED
REJECTED
SUPERSEDED
TESTING
```

---

# 78. Memory Page

The Memory page represents accumulated trading knowledge.

Tabs:

```text
Lessons
Regimes
Signals
Confidence
```

---

# 79. Lessons View

Table:

```text
Lesson
Status
Scope
Observations
Win/Loss
Expectancy
Confidence
Last Validated
```

Example:

```text
Breakout trades underperform
when volume ratio < 1.15

REINFORCED

BREAKOUT
BTC-USDT-SWAP

Observations  31
Win / Loss    7 / 24
Expectancy    -0.41R
Confidence    82%
```

Status badges:

```text
PROVISIONAL
REINFORCED
VERIFIED
CONFLICTED
SUPERSEDED
REJECTED
```

---

# 80. Regime Memory View

Display strategy performance matrix.

Example:

| Strategy | Bull Trend | Bear Trend | Sideways | High Vol |
|---|---:|---:|---:|---:|
| Trend Following | +0.42R | +0.38R | -0.21R | +0.04R |
| Breakout | +0.31R | +0.27R | -0.09R | +0.33R |
| Mean Reversion | -0.13R | -0.18R | +0.29R | -0.07R |

This gives a fast view of where each strategy performs best.

---

# 81. Signal Weight View

Example:

```text
Signal          Weight      Change

Trend           1.24        +4%
Volume          1.31        +8%
Momentum        0.91        -3%
Volatility      0.86        -4%
```

Show:

```text
previous weight
current weight
historical contribution
last update
evidence sample size
```

---

# 82. Confidence Calibration View

Recommended visualization:

```text
AI Confidence vs Actual Outcome
```

Buckets:

```text
50–60%
60–70%
70–80%
80–90%
90–100%
```

Example:

```text
AI Confidence     Actual Win Rate

50–60%            51%
60–70%            56%
70–80%            61%
80–90%            67%
90–100%           59%
```

This makes overconfidence obvious.

---

# 83. Risk Page

The Risk page must be easy to scan.

Top cards:

```text
Current Drawdown
Daily Loss
Open Exposure
Current Risk
Available Equity
Bot Risk State
```

Hard Limits:

```text
Risk / Trade        0.5%
Daily Loss Limit    3%
Max Drawdown        10%
Max Leverage        5x
Max Positions       1
```

Status:

```text
SAFE
WARNING
HALTED
```

---

# 84. Risk Events

Maintain a timeline:

```text
19:15
Order rejected:
MINIMUM_SIZE

18:32
Risk Engine rejected entry:
MAX_DAILY_LOSS_REACHED

16:45
Position reconciliation recovered.

14:00
Clock drift detected:
+420ms
```

Risk events should never be hidden inside generic application logs.

---

# 85. Logs Page

Tabs:

```text
System
Trading
AI
Risk
Exchange
Evolution
```

Fields:

```text
Timestamp
Level
Subsystem
Event
Trade ID
Decision ID
Order ID
```

Support:

```text
Search
Filters
Auto-scroll
Pause
Export
```

Sensitive authentication values must be redacted.

---

# 86. Settings Page

Sections:

```text
Exchange
Trading
Risk
AI Provider
Learning
Evolution
Notifications
Appearance
```

V1 exchange section:

```text
Exchange:
OKX

Environment:
DEMO
```

`DEMO` must be visibly locked for V1.

---

# 87. AI Provider Settings

Possible fields:

```text
Provider
Base URL
Model
Temperature
Timeout
Max Retries
```

Different roles may use different models:

```text
Decision Agent
Reviewer Agent
Evolution Agent
```

API keys should never be returned to the frontend after being saved.

Display:

```text
••••••••••••
```

---

# 88. Learning Settings

Example:

```text
Post-Trade Review
Enabled

Signal Evolution
Every 20 trades

Strategy Evolution
Every 50 trades

Minimum Validation Sample
30 trades

Maximum Weight Change
10%

Maximum Strategy Parameter Changes
2
```

Hard safety controls should not be mixed with learning controls.

---

# 89. Bot State Controls

Supported bot states:

```text
STOPPED
STARTING
RUNNING
PAUSED
RISK_HALTED
ERROR
```

Primary controls:

```text
START
PAUSE
STOP
```

Separate emergency action:

```text
EMERGENCY STOP
```

Emergency Stop must:

```text
disable new entries immediately
cancel pending entry orders where appropriate
preserve existing protective orders
set bot state to RISK_HALTED
write an audit event
```

Closing an existing position automatically should be a separate explicit policy.

---

# 90. Responsive Layout

## Desktop

Primary target.

Recommended width:

```text
1280 px and above
```

Use:

```text
persistent sidebar
multi-column dashboard
full trading chart
dense analytics tables
```

---

## Tablet

```text
768–1279 px
```

Use:

```text
collapsible sidebar
2-column → 1-column sections
horizontal scroll for dense tables
```

---

## Mobile

Mobile is primarily:

```text
monitoring
risk visibility
position status
emergency controls
```

Do not attempt to reproduce the entire desktop quant workstation on mobile.

Prioritize:

```text
Bot Status
Open Position
PnL
Risk
Latest Decision
Emergency Stop
Recent Trades
```

---

# 91. Responsive Dashboard Example

Desktop:

```text
KPI KPI KPI KPI KPI

Chart               Position

Latest Decision     Risk

Performance         Regime

Recent Trades
```

Mobile:

```text
Bot Status

Position

PnL / Risk

Latest Decision

Chart

Recent Trades
```

---

# 92. Loading and Empty States

Avoid generic spinners everywhere.

Examples:

```text
Waiting for first confirmed candle...
```

```text
No position currently open.
Latest decision: HOLD
```

```text
Not enough trades to calculate
confidence calibration.

17 / 30 required observations.
```

This is especially important for a self-learning system because many features require a minimum sample size.

---

# 93. Data Confidence UI

Whenever statistics have insufficient evidence, show it.

Example:

```text
Win Rate
75%

Sample:
4 trades

LOW CONFIDENCE
```

instead of making:

```text
75%
```

look definitive.

Recommended evidence labels:

```text
INSUFFICIENT
LOW
MODERATE
HIGH
```

---

# 94. Auditability

Every important UI object should be traceable.

From a trade:

```text
Trade
↓
Decision
↓
Market Snapshot
↓
Strategy Version
↓
Risk Decision
↓
Orders / Fills
↓
Review
↓
Lessons
```

From a lesson:

```text
Lesson
↓
Evidence Trades
↓
Evolution Run
↓
Candidate Strategy
```

This makes EvoQuant debuggable.

---

# 95. UI Safety Rules

Never make these actions one-click without confirmation:

```text
Reset trading memory
Delete historical trades
Reset strategy versions
Change exchange environment
Disable hard risk limits
Clear risk halt
```

However, routine actions should remain fast.

Do not add confirmation dialogs for harmless navigation or filtering.

---

# 96. UX Rule for Demo Trading

The interface must always show that it is simulated.

Examples:

```text
DEMO
SIMULATED TRADING
NO REAL FUNDS
```

At least one indicator should remain permanently visible in the global header.

This avoids confusing demo performance with live performance.

---

# 97. Dashboard Status Hierarchy

The visual hierarchy should prioritize:

```text
1. Critical Risk State
2. Open Position
3. Current PnL
4. Bot State
5. Latest Decision
6. Market Regime
7. Strategy
8. Historical Performance
9. Learning / Evolution
```

Do not make AI-generated narrative more visually prominent than risk or current position state.

---

# 98. Recommended UI Components

Reusable components:

```text
AppShell
Sidebar
Topbar
EnvironmentBadge
BotStatusBadge
ConnectionStatus
MetricCard
RiskMetric
PriceChart
PositionCard
DecisionCard
RiskDecisionCard
RegimeBadge
StrategyBadge
ConfidenceMeter
TradeTable
TradeReplay
ReviewPanel
LessonCard
LessonStatusBadge
SignalWeightTable
StrategyVersionCard
ChampionChallengerCompare
EvolutionTimeline
RiskEventTimeline
LogViewer
EmptyState
EvidenceBadge
```

Keep components domain-oriented rather than creating excessive tiny abstraction layers.

---

# 99. Performance Requirements

Target:

```text
Dashboard initial load:
fast enough for operational use

UI updates:
without full-page reload

Price updates:
WebSocket-driven

Tables:
virtualize only when necessary

Charts:
avoid unnecessary re-rendering
```

Use:

```text
server state caching
incremental updates
memoized derived metrics
```

Avoid polling rapidly when WebSocket data is available.

---

# 100. Accessibility

Minimum:

```text
keyboard-accessible navigation
visible focus states
sufficient contrast
non-color-only status communication
tooltips for abbreviations
semantic tables
responsive text
```

Example:

Do not use only:

```text
green
red
```

Use:

```text
WIN + green
LOSS + red
```

---

# 101. UI Acceptance Criteria

The UI is acceptable when a user can answer the following within a few seconds:

```text
Is EvoQuant running?

Is it connected to OKX Demo?

Is there an open position?

How much risk is currently active?

What was the latest AI decision?

Did the Risk Engine approve or reject it?

Which strategy is currently Champion?

What is EvoQuant learning?

Is a Challenger currently being tested?

Why was a strategy promoted or rejected?

Can I trace a lesson back to its evidence trades?
```

The UI should prioritize these operational questions over decoration.

---

# 102. Final Product Identity

Product name:

```text
EvoQuant
```

Descriptor:

```text
Self-Evolving AI Quant Trading System
```

Short product description:

```text
EvoQuant is an experimental AI-assisted quantitative trading system
that executes on OKX Demo Trading, evaluates every trade, builds
evidence-backed trading memory, and evolves strategies through
controlled Champion-vs-Challenger validation.
```

Recommended repository name:

```text
evoquant
```

Recommended application title:

```text
EvoQuant
```

Recommended subtitle:

```text
Adaptive Quant Intelligence
```
