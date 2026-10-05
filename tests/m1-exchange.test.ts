// M1 unit tests — deterministic, NO network (fetch injected everywhere).

import { test } from "node:test";
import assert from "node:assert/strict";

import { buildPrehash, signPayload, buildAuthHeaders } from "../src/exchange/okx/auth.ts";
import { normalizeContractSize } from "../src/exchange/okx/sizing.ts";
import { OkxClient, OkxApiError, OkxConfigError, resolveBaseUrl, DEMO_BASE_URL, buildQuery } from "../src/exchange/okx/client.ts";
import { getCandles } from "../src/exchange/okx/market.ts";
import { placeOrder, getOrder, closePosition, waitForOrderTerminal, OrderRejectedError, OrderTimeoutError, prepareOrderSize } from "../src/exchange/okx/orders.ts";
import { createDemoExchange } from "../src/exchange/okx/index.ts";
import { amendConditionalStop, getAlgoOrder } from "../src/exchange/okx/algo.ts";
import { redact } from "../src/core/logger.ts";
import { assertDemo, loadRiskConfig, loadTradingConfig, ABSOLUTE_MAX } from "../src/core/config.ts";

// ---------- auth (spec §6) ----------
test("signing vector: deterministic prehash + base64 HMAC", () => {
  const ts = "2026-10-01T00:00:00.000Z";
  const prehash = buildPrehash(ts, "post", "/api/v5/trade/order", '{"instId":"BTC-USDT-SWAP"}');
  assert.equal(prehash, `2026-10-01T00:00:00.000ZPOST/api/v5/trade/order{"instId":"BTC-USDT-SWAP"}`);
  const expected = "LTm/6cwGKj2rGPenotX7APLd7dgD3MNdmbiLgT2aJZA="; // computed externally via openssl dgst -hmac
  assert.equal(signPayload(prehash, "test-secret"), expected);
  assert.match(signPayload("abc", "k"), /^[A-Za-z0-9+/=]+$/);
});

test("buildAuthHeaders carries all OK-ACCESS-* headers", () => {
  const h = buildAuthHeaders({ apiKey: "KEY", secret: "SEC", passphrase: "PASS" }, "GET", "/api/v5/account/balance", "");
  assert.equal(h["OK-ACCESS-KEY"], "KEY");
  assert.equal(h["OK-ACCESS-PASSPHRASE"], "PASS");
  assert.ok((h["OK-ACCESS-SIGN"] ?? "").length > 20);
  assert.match(h["OK-ACCESS-TIMESTAMP"] ?? "", /^\d{4}-\d{2}-\d{2}T/);
});

// ---------- sizing (spec §24, §7.2 sz=contracts) ----------
test("normalizeContractSize floors to lotSz, never rounds up", () => {
  const inst = { lotSz: "0.1", minSz: "0.1" };
  assert.equal(normalizeContractSize("0.35", inst), "0.3"); // floor, not nearest
  assert.equal(normalizeContractSize("1", inst), "1.0"); // padded to lotSz decimals
});

test("normalizeContractSize rejects below minSz (§24)", () => {
  assert.throws(() => normalizeContractSize("0.005", { lotSz: "0.01", minSz: "0.01" }));
  assert.throws(() => normalizeContractSize("0", { lotSz: "1", minSz: "1" }));
  assert.throws(() => normalizeContractSize("-2", { lotSz: "1", minSz: "1" }));
});

test("sz=1 means 1 CONTRACT not 1 BTC (§7.2 doc test)", () => {
  // ctVal 0.01 BTC: one contract is 0.01 BTC. Normalization must keep 1
  // contract (as lotSz-aligned string "1.00"), not reinterpret as coin qty.
  assert.equal(prepareOrderSize("1", { lotSz: "0.01", minSz: "0.01" }), "1.00");
});

test("float noise handled by decimal math: 0.2999999 -> 0.29 at lotSz 0.01", () => {
  assert.equal(normalizeContractSize("0.2999999", { lotSz: "0.01", minSz: "0.01" }), "0.29");
});

// ---------- demo-only hard guard (spec §44) ----------
test("client constructor refuses non-demo environment", () => {
  assert.throws(() => new OkxClient({ environment: "live" as unknown as "demo" }), OkxConfigError);
});

test("createDemoExchange aborts unless OKX_ENV=demo (§44)", () => {
  assert.throws(() => createDemoExchange({ OKX_ENV: "production" }), OkxConfigError);
  assert.throws(() => createDemoExchange({}), OkxConfigError);
  assert.throws(() => createDemoExchange({ OKX_ENV: "demo" }), OkxConfigError); // missing creds
  const ex = createDemoExchange({ OKX_ENV: "demo", OKX_API_KEY: "k", OKX_API_SECRET: "s", OKX_PASSPHRASE: "p" });
  assert.equal(ex.client.environment, "demo");
});

test("resolveBaseUrl: production abort path is unreachable by config; unknown URL throws", () => {
  assert.equal(resolveBaseUrl(undefined), DEMO_BASE_URL);
  assert.throws(() => resolveBaseUrl("https://evil.example.com"), OkxConfigError);
});

test("every request carries x-simulated-trading: 1 (§5.2/§44) and private gets OK-ACCESS-*", async () => {
  const captured: { url: string; init?: RequestInit | undefined }[] = [];
  const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
    captured.push({ url: String(url), init });
    return new Response(JSON.stringify({ code: "0", msg: "", data: [] }), { status: 200 });
  }) as unknown as typeof fetch;
  const client = new OkxClient({
    environment: "demo",
    credentials: { apiKey: "k", secret: "s", passphrase: "p" },
    fetchImpl: fakeFetch,
  });
  await client.get("/api/v5/account/positions", { instId: "BTC-USDT-SWAP" }, true);
  const headers = captured[0]!.init!.headers as Record<string, string>;
  assert.equal(headers["x-simulated-trading"], "1");
  assert.ok(headers["OK-ACCESS-SIGN"]);
  assert.ok(captured[0]!.url.startsWith("https://openapi.okx.com"));
});

// ---------- envelope & errors ----------
test("code !== 0 raises OkxApiError (§8/§14)", async () => {
  const fakeFetch = (async () =>
    new Response(JSON.stringify({ code: "51001", msg: "Instrument ID does not exist", data: [] }), { status: 200 })) as unknown as typeof fetch;
  const client = new OkxClient({ environment: "demo", fetchImpl: fakeFetch });
  await assert.rejects(() => client.get("/api/v5/market/ticker", { instId: "NOPE" }), (e: unknown) => e instanceof OkxApiError && (e as OkxApiError).code === "51001");
});

test("buildQuery preserves order for signing and skips undefined", () => {
  assert.equal(buildQuery({ b: "2", a: "1", c: undefined }), "b=2&a=1");
});

// ---------- candles (spec §7.3) ----------
test("candle mapping keeps confirm flag as raw string", async () => {
  const raw = [
    ["1759334400000", "84132.4", "84300", "84000", "84284.28", "100", "1", "8428.428", "1"],
    ["1759335300000", "84284.28", "84400", "84284.28", "84350", "50", "0.5", "4217.5", "0"],
  ];
  const fakeFetch = (async () => new Response(JSON.stringify({ code: "0", msg: "", data: raw }), { status: 200 })) as unknown as typeof fetch;
  const client = new OkxClient({ environment: "demo", fetchImpl: fakeFetch });
  const candles = await getCandles(client, "BTC-USDT-SWAP", "15m", 2);
  assert.equal(candles.length, 2);
  assert.equal(candles[0]!.confirm, "1");
  assert.equal(candles[1]!.confirm, "0");
  assert.equal(candles[0]!.c, 84284.28);
});

// ---------- orders (spec §9–§15) ----------
test("placeOrder requires sCode 0 else OrderRejectedError (§14)", async () => {
  const make = (data: unknown) =>
    new OkxClient({
      environment: "demo",
      credentials: { apiKey: "k", secret: "s", passphrase: "p" },
      fetchImpl: (async () => new Response(JSON.stringify({ code: "0", msg: "", data }), { status: 200 })) as unknown as typeof fetch,
    });
  const ok = await placeOrder(make([{ sCode: "0", sMsg: "ok", ordId: "O1", clOrdId: "C1" }]), {
    instId: "BTC-USDT-SWAP", tdMode: "isolated", side: "buy", posSide: "long", ordType: "market", sz: "1", clOrdId: "C1",
  });
  assert.equal(ok.ordId, "O1");
  await assert.rejects(
    () => placeOrder(make([{ sCode: "51001", sMsg: "bad inst" }]), {
      instId: "X", tdMode: "isolated", side: "buy", posSide: "long", ordType: "market", sz: "1", clOrdId: "C2",
    }),
    OrderRejectedError,
  );
});

test("closePosition flips order side per posSide (§4.2) and normalizes sz", async () => {
  let sentBody: Record<string, string> | undefined;
  const client = new OkxClient({
    environment: "demo",
    credentials: { apiKey: "k", secret: "s", passphrase: "p" },
    fetchImpl: (async (_u: unknown, init?: RequestInit) => {
      sentBody = JSON.parse(String(init!.body));
      return new Response(JSON.stringify({ code: "0", msg: "", data: [{ sCode: "0", ordId: "O2", clOrdId: sentBody!.clOrdId }] }), { status: 200 });
    }) as unknown as typeof fetch,
  });
  await closePosition(client, { instId: "BTC-USDT-SWAP", posSide: "long", contracts: "2", clOrdId: "CLOSE-1", lotSz: "0.01", minSz: "0.01" });
  assert.equal(sentBody!.side, "sell"); // close long = sell long (§4.2)
  assert.equal(sentBody!.posSide, "long");
  assert.equal(sentBody!.sz, "2.00"); // normalized to lotSz decimals
  await closePosition(client, { instId: "BTC-USDT-SWAP", posSide: "short", contracts: "3", clOrdId: "CLOSE-2", lotSz: "0.01", minSz: "0.01" });
  assert.equal(sentBody!.side, "buy"); // close short = buy short
  assert.equal(sentBody!.sz, "3.00");
});

test("waitForOrderTerminal: filled returns detail; timeout throws OrderTimeoutError (§14)", async () => {
  const detail = (state: string) => ({
    instId: "BTC-USDT-SWAP",
    ordId: "O3",
    tdMode: "isolated",
    side: "buy",
    posSide: "long",
    ordType: "market",
    sz: "1",
    accFillSz: state === "filled" ? "1" : "0",
    state,
    lever: "3",
    cTime: "1",
    uTime: "2",
  });
  let calls = 0;
  const client = new OkxClient({
    environment: "demo",
    credentials: { apiKey: "k", secret: "s", passphrase: "p" },
    fetchImpl: (async () => {
      calls += 1;
      return new Response(JSON.stringify({ code: "0", msg: "", data: [detail(calls >= 2 ? "filled" : "live")] }), { status: 200 });
    }) as unknown as typeof fetch,
  });
  const res = await waitForOrderTerminal(client, "BTC-USDT-SWAP", "O3", { pollMs: 1, timeoutMs: 5000, sleep: async () => {} });
  assert.equal(res.state, "filled");

  const never = new OkxClient({
    environment: "demo",
    credentials: { apiKey: "k", secret: "s", passphrase: "p" },
    fetchImpl: (async () => new Response(JSON.stringify({ code: "0", msg: "", data: [detail("live")] }), { status: 200 })) as unknown as typeof fetch,
  });
  await assert.rejects(
    () => waitForOrderTerminal(never, "BTC-USDT-SWAP", "O4", { timeoutMs: 5, pollMs: 1, now: (() => { let t = 0; return () => (t += 1); })(), sleep: async () => {} }),
    OrderTimeoutError,
  );
});

test("getOrder maps raw detail incl. state", async () => {
  const client = new OkxClient({
    environment: "demo",
    credentials: { apiKey: "k", secret: "s", passphrase: "p" },
    fetchImpl: (async () => new Response(JSON.stringify({ code: "0", msg: "", data: [{ ordId: "O5", state: "canceled", instId: "BTC-USDT-SWAP", sz: "1", accFillSz: "0" }] }), { status: 200 })) as unknown as typeof fetch,
  });
  const d = await getOrder(client, "BTC-USDT-SWAP", "O5");
  assert.equal(d.state, "canceled");
});

test("conditional SL amendment preserves the algo and confirms its live trigger", async () => {
  const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
  const client = new OkxClient({
    environment: "demo",
    credentials: { apiKey: "k", secret: "s", passphrase: "p" },
    fetchImpl: (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, init });
      const body = url.includes("amend-algos")
        ? { code: "0", msg: "", data: [{ sCode: "0", algoId: "A1" }] }
        : { code: "0", msg: "", data: [{ algoId: "A1", state: "live", slTriggerPx: "100.2" }] };
      return new Response(JSON.stringify(body), { status: 200 });
    }) as unknown as typeof fetch,
  });
  await amendConditionalStop(client, { instId: "BTC-USDT-SWAP", algoId: "A1", stopPrice: 100.2 });
  const amended = JSON.parse(String(requests[0]!.init?.body)) as Record<string, unknown>;
  assert.equal(amended.algoId, "A1");
  assert.equal(amended.newSlTriggerPx, "100.2");
  assert.equal(amended.newSlOrdPx, "-1");
  assert.equal(amended.newSlTriggerPxType, "mark");
  assert.equal(amended.cxlOnFail, false);
  const confirmed = await getAlgoOrder(client, "BTC-USDT-SWAP", "A1");
  assert.equal(confirmed.state, "live");
  assert.equal(confirmed.slTriggerPx, "100.2");
});

// ---------- logger redaction (spec §51) ----------
test("redact masks secret-shaped keys at any depth", () => {
  const out = redact({ event: "x", creds: { apiKey: "secret", passphrase: "p", sign: "s" }, nested: [{ Authorization: "Bearer z" }], safe: 1 }) as Record<string, unknown>;
  assert.equal((out.creds as Record<string, unknown>).apiKey, "***REDACTED***");
  assert.equal((out.creds as Record<string, unknown>).passphrase, "***REDACTED***");
  assert.equal(((out.nested as Record<string, unknown>[])[0]!).Authorization, "***REDACTED***");
  assert.equal(out.safe, 1);
});

// ---------- config (spec §43/§44/§48) ----------
test("assertDemo only passes OKX_ENV=demo (§44)", () => {
  assert.throws(() => assertDemo({}));
  assert.throws(() => assertDemo({ OKX_ENV: "prod" }));
  assert.doesNotThrow(() => assertDemo({ OKX_ENV: "demo" }));
});

test("shipped configs parse and stay within absolute maxes", () => {
  const t = loadTradingConfig();
  const r = loadRiskConfig();
  assert.equal(t.environment, "demo");
  assert.ok(t.leverage.hard_max <= ABSOLUTE_MAX.leverage);
  assert.ok(r.hard_limits.risk_per_trade_pct <= ABSOLUTE_MAX.riskPerTradePct);
});
