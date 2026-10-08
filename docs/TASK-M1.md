# TASK M1 — OKX Demo Exchange Adapter (Milestone 1, spec §7–§15, §43–§45)

Implement the deterministic OKX exchange layer in TypeScript ESM (strict).
Read `AGENTS.md` and `docs/EVOQUANT_SPEC.md` first. Spec section numbers MUST
appear as comments in code.

## Scope (files to create)

1. `src/exchange/okx/types.ts` — shared types: InstrumentInfo (tickSz, lotSz,
   minSz, ctVal, ctValCcy), Candle (ts, o, h, l, c, vol, volCcy, confirm flag),
   OrderRequest (instId, tdMode='isolated', side buy|sell, posSide long|short,
   ordType market|post_only|limit, sz string, clOrdId), OrderDetail, Fill,
   Position (posId, instId, posSide, pos, avgPx, markPx, lever, upl, mgnMode),
   OkxResponse<T> = {code, msg, data}.
2. `src/exchange/okx/auth.ts` — OK-ACCESS-* signing: prehash =
   timestamp + method(upper) + requestPath(+query) + body, HMAC-SHA256 base64
   (node:crypto). UTC ms timestamp. Pure function, injectable.
3. `src/exchange/okx/client.ts` — base client:
   - REST base: `https://openapi.okx.com` ONLY when demo (spec §5.2). Hard
     guard per spec §44: constructor throws unless env==='demo'; every PRIVATE
     request carries `x-simulated-trading: 1`. A constant
     `PRODUCTION_BASE_URL` exists ONLY behind a compile-time-not-configurable
     path and aborts() if ever selected.
   - fetch injectable for tests (default global fetch).
   - parse OkxResponse: code !== "0" → typed OkxApiError with code/msg.
   - GET/POST helpers, query building, JSON body.
4. `src/exchange/okx/market.ts` — public: getServerTime (§7.1),
   getInstruments(instType, instId?) (§7.2), getTicker (§7.5),
   getCandles(instId, bar, limit) (§7.3 — map strings→numbers, keep
   `confirm` flag; helper `latestClosedCandle` uses only confirm==="1"),
   getHistoryCandles (§7.4).
5. `src/exchange/okx/account.ts` — private: getBalance (§7.7),
   getPositions(instId?) (§7.8), setLeverage (§7.10 — both posSide long and
   short, mgnMode isolated; validate lever <= hard_max from config/risk.yaml —
   load via `src/core/config.ts`).
6. `src/exchange/okx/orders.ts` — private: placeOrder (§9–§13; sz MUST be
   contract count normalized by lotSz/minSz — implement
   `normalizeContractSize` in `src/exchange/okx/sizing.ts` pure math, §24),
   getOrder (§14), getPendingOrders, getFills, getFillsHistory,
   closePosition helper (opposite side/posSide market order, reuses
   normalizeContractSize), order-lifecycle waiter polling until
   filled|canceled with timeout (§14).
7. `src/exchange/okx/index.ts` — exports + `createDemoExchange(env)` factory
   enforcing demo-only.
8. `src/core/config.ts` — load config/trading.yaml + risk.yaml (yaml pkg),
   zod-validate, abort on environment!=demo or limits outside absolute max
   (absolute maxes hardcoded here: leverage<=10, risk/trade<=10%, daily<=5%,
   dd<=20% — outside = misconfiguration, refuse).
9. `src/core/logger.ts` — leveled JSON logger; REDACTS apiKey/passphrase/
   signature/secret fields always (§51) — implement redaction in one place.
10. `src/scripts/smoke-public.ts` — no credentials: server time, instruments
    metadata for BTC-USDT-SWAP, 3 closed 15m candles, ticker. Print summary;
    exit non-zero on failure.
11. `src/scripts/smoke-demo.ts` — the §8–§13 walkthrough exactly: validate
    creds via balance, read instruments, set position mode note (§7.9 —
    try GET account/config; if mode wrong print instruction and ABORT, do not
    call set-pos-mode blindly), set leverage 3x both sides, open LONG 1 ct w/
    clOrdId EVQ-BTC-L-<date>-000001, verify position via reconciliation query,
    close LONG, verify fill+zero position, same for SHORT. Guard: requires
    OKX_ENV=demo + creds present else abort. Every step logged with request/
    response IDs (never secrets).
12. `tests/*.test.ts` — node:test unit tests, NO network: signing vector
    (known input→known base64), normalizeContractSize (lotSz rounding, minSz
    rejection, sz=1 contracts≠1BTC doc test §7.2), demo hard guard (constructor
    throws on live; header present on private calls via injected fetch),
    candle mapping incl. confirm flag filter, OkxApiError on code!=0, redaction.

## Out of scope (do NOT build): agents, LLM, indicators, DB, scheduler, UI.

## Acceptance

- `npm run typecheck` clean, `npm test` all pass.
- grep shows NO hardcoded production trading path reachable by config.
- All sz sent to OKX are strings normalized to lotSz.
- Report files created + test names in final message.
