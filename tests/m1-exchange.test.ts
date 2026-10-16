// M1 unit tests — deterministic, NO network (fetch injected everywhere).

import { test } from "node:test";
import assert from "node:assert/strict";

import { buildPrehash, signPayload, buildAuthHeaders } from "../src/exchange/okx/auth.ts";
import { normalizeContractSize } from "../src/exchange/okx/sizing.ts";
import { OkxClient, OkxApiError, OkxConfigError, resolveBaseUrl, DEMO_BASE_URL, buildQuery } from "../src/exchange/okx/client.ts";
import { getCandles } from "../src/exchange/okx/market.ts";
import { placeOrder, getOrder, getOrderByClientId, closePosition, waitForOrderTerminal, OrderRejectedError, OrderTimeoutError, prepareOrderSize } from "../src/exchange/okx/orders.ts";
import { createDemoExchange } from "../src/exchange/okx/index.ts";
import { amendConditionalStop, getAlgoOrder, normalizePriceToTick, placeConditionalProtection } from "../src/exchange/okx/algo.ts";
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

test("submission rejection classification preserves transport evidence and fails closed", async () => {
  const order = { instId: "BTC-USDT-SWAP", tdMode: "isolated", side: "buy", posSide: "long",
    ordType: "market", sz: "1", clOrdId: "C1" } as const;
  const rejected = { sCode: "51008", sMsg: "Insufficient balance", ordId: "", clOrdId: "C1" };
  const cases: Array<{ name: string; code: string; data: unknown; definitive: boolean; status?: number }> = [
    ...["51000", "51008", "51121"].flatMap((sCode) => [
      { name: `item ${sCode}`, code: "0", data: [{ ...rejected, sCode }], definitive: true },
      { name: `envelope item ${sCode}`, code: "1", data: [{ ...rejected, sCode }], definitive: true },
      { name: `envelope ${sCode}`, code: sCode, data: [], definitive: true },
    ]),
    { name: "omitted rejected client ID", code: "1", data: [{ sCode: "51008", sMsg: "failure", ordId: "" }], definitive: false },
    { name: "blank rejected client ID", code: "1", data: [{ ...rejected, clOrdId: "" }], definitive: true },
    { name: "different client ID", code: "1", data: [{ ...rejected, clOrdId: "OTHER" }], definitive: false },
    { name: "already assigned order", code: "1", data: [{ ...rejected, ordId: "O1" }], definitive: false },
    { name: "missing code", code: "0", data: [{ ordId: "", clOrdId: "C1" }], definitive: false },
    { name: "missing order ID", code: "1", data: [{ sCode: "51008", sMsg: "failure", clOrdId: "C1" }], definitive: false },
    { name: "missing message", code: "1", data: [{ sCode: "51008", ordId: "", clOrdId: "C1" }], definitive: false },
    { name: "numeric status", code: "0", data: [{ ...rejected, sCode: 51008 }], definitive: false },
    { name: "duplicate ID", code: "1", data: [{ ...rejected, sCode: "51016" }], definitive: false },
    { name: "timeout", code: "50004", data: [], definitive: false },
    { name: "item timeout", code: "0", data: [{ ...rejected, sCode: "50004" }], definitive: false },
    { name: "unknown code", code: "1", data: [{ ...rejected, sCode: "59999" }], definitive: false },
    { name: "multiple items", code: "1", data: [rejected, rejected], definitive: false },
    { name: "conflicting envelope", code: "51008", data: [{ sCode: "0", ordId: "O1" }], definitive: false },
    { name: "null item", code: "0", data: [null], definitive: false },
    { name: "null data", code: "1", data: null, definitive: false },
    { name: "server failure", code: "1", data: [rejected], definitive: false, status: 503 },
    { name: "server failure with successful envelope", code: "0", data: [rejected], definitive: false, status: 503 },
  ];
  for (const c of cases) {
    const client = new OkxClient({ environment: "demo", credentials: { apiKey: "k", secret: "s", passphrase: "p" },
      fetchImpl: async () => new Response(JSON.stringify({ code: c.code, msg: "failed", data: c.data }), { status: c.status ?? 200 }) });
    await assert.rejects(() => placeOrder(client, order), (error: unknown) => {
      assert.equal(error instanceof OrderRejectedError && error.definitive, c.definitive, c.name);
      return true;
    });
  }
  const data = [{ ...rejected, sMsg: "long reason ".repeat(80) }];
  const client = new OkxClient({ environment: "demo",
    fetchImpl: async () => new Response(JSON.stringify({ code: "1", msg: "failed", data }), { status: 200 }) });
  await assert.rejects(() => client.post("/api/v5/trade/order", order), (error: unknown) => {
    assert.ok(error instanceof OkxApiError);
    assert.deepEqual(error.data, data);
    return true;
  });
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

test("client order lookup treats only OKX 51603 as absent and preserves other failures", async () => {
  const absent = new OkxClient({ environment: "demo", credentials: { apiKey: "k", secret: "s", passphrase: "p" },
    fetchImpl: (async () => new Response(JSON.stringify({ code: "51603", msg: "Order does not exist", data: [] }), { status: 200 })) as unknown as typeof fetch });
  assert.equal(await getOrderByClientId(absent, "BTC-USDT-SWAP", "CLIENT1"), null);

  const unavailable = new OkxClient({ environment: "demo", credentials: { apiKey: "k", secret: "s", passphrase: "p" },
    fetchImpl: (async () => new Response(JSON.stringify({ code: "50011", msg: "Rate limit", data: [] }), { status: 200 })) as unknown as typeof fetch });
  await assert.rejects(() => getOrderByClientId(unavailable, "BTC-USDT-SWAP", "CLIENT1"),
    (error: unknown) => error instanceof OkxApiError && error.code === "50011");
});

test("conditional SL amendment preserves safe tick rounding and confirms its live trigger", async () => {
  const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
  const client = new OkxClient({
    environment: "demo",
    credentials: { apiKey: "k", secret: "s", passphrase: "p" },
    fetchImpl: (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, init });
      const body = url.includes("amend-algos")
        ? { code: "0", msg: "", data: [{ sCode: "0", algoId: "A1" }] }
        : { code: "0", msg: "", data: [{ algoId: "A1", state: "live", instId: "BTC-USDT-SWAP", posSide: "long", sz: "1", slTriggerPx: "100.2" }] };
      return new Response(JSON.stringify(body), { status: 200 });
    }) as unknown as typeof fetch,
  });
  await amendConditionalStop(client, { instId: "BTC-USDT-SWAP", algoId: "A1", stopPrice: 100.2, tickSz: "0.1", posSide: "long" });
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

test("tick normalization supports small and varied OKX ticks with risk-safe direction", () => {
  assert.equal(normalizePriceToTick(0.001234, "0.0001", "up"), "0.0013");
  assert.equal(normalizePriceToTick(1.23456, "0.001", "up"), "1.235");
  assert.equal(normalizePriceToTick(12.3456, "0.01", "down"), "12.34");
  assert.equal(normalizePriceToTick(12.3456, "0.1", "up"), "12.4");
  assert.equal(normalizePriceToTick(100, "0.1", "down"), "100");
  assert.throws(() => normalizePriceToTick(0, "0.01", "up"), /invalid protection price/);
  assert.throws(() => normalizePriceToTick(1, "0", "up"), /invalid instrument tick/);
});

test("native protection uses two verified conditional legs with exact tick and algo client fields", async () => {
  const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
  const details = new Map<string, Record<string, string>>();
  let sequence = 0;
  const client = new OkxClient({ environment: "demo", credentials: { apiKey: "k", secret: "s", passphrase: "p" },
    fetchImpl: (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = String(input); requests.push({ url, init });
      if (url.includes("order-algo") && (!init?.method || init.method === "GET")) {
        const algoId = new URL(url).searchParams.get("algoId") ?? "";
        return new Response(JSON.stringify({ code: "0", msg: "", data: [details.get(algoId)] }), { status: 200 });
      }
      const body = JSON.parse(String(init?.body)) as Record<string, string>;
      const algoId = `A${++sequence}`;
      details.set(algoId, { algoId, instId: body.instId ?? "", tdMode: body.tdMode ?? "", side: body.side ?? "",
        ordType: body.ordType ?? "", posSide: body.posSide ?? "", sz: body.sz ?? "", state: "live",
        slTriggerPx: body.slTriggerPx ?? "", slTriggerPxType: body.slTriggerPxType ?? "",
        tpTriggerPx: body.tpTriggerPx ?? "", tpTriggerPxType: body.tpTriggerPxType ?? "" });
      return new Response(JSON.stringify({ code: "0", msg: "", data: [{ sCode: "0", algoId, algoClOrdId: body.algoClOrdId }] }), { status: 200 });
    }) as unknown as typeof fetch });
  const protection = await placeConditionalProtection(client, { instId: "SUI-USDT-SWAP", posSide: "long", contracts: "3", tickSz: "0.0001",
    stopPrice: 1.23456, takeProfitPrice: 1.45678, clAlgoId: "EVQ-ALGO-TEST" });
  assert.deepEqual([protection.stop.algoId, protection.takeProfit.algoId], ["A1", "A2"]);
  const bodies = requests.filter(request => request.url.endsWith("/order-algo") && request.init?.method === "POST")
    .map(request => JSON.parse(String(request.init?.body)) as Record<string, unknown>);
  assert.equal(bodies.length, 2);
  assert.equal(bodies[0]?.slTriggerPx, "1.2346");
  assert.equal(bodies[1]?.tpTriggerPx, "1.4567");
  assert.equal(bodies[0]?.side, "sell");
  assert.equal(bodies[0]?.posSide, "long");
  assert.equal(bodies[0]?.algoClOrdId, "EVQ-ALGO-TESTSL");
  assert.equal("clOrdId" in (bodies[0] ?? {}), false);
  assert.equal("tpTriggerPx" in (bodies[0] ?? {}), false);
  assert.equal(bodies[1]?.tpTriggerPx, "1.4567");
  assert.equal("slTriggerPx" in (bodies[1] ?? {}), false);
  assert.ok(requests.filter(request => request.url.includes("order-algo") && request.init?.method !== "POST").length === 2,
    "both exchange algo IDs were read back and verified");
});

test("native short protection uses buy close side and symmetric tick-safe trigger prices", async () => {
  const requests: Array<{ url: string; init: RequestInit | undefined }> = [];
  const details = new Map<string, Record<string, string>>();
  let sequence = 0;
  const client = new OkxClient({ environment: "demo", credentials: { apiKey: "k", secret: "s", passphrase: "p" },
    fetchImpl: (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = String(input); requests.push({ url, init });
      if (url.includes("order-algo") && (!init?.method || init.method === "GET")) {
        const id = new URL(url).searchParams.get("algoId") ?? "";
        return new Response(JSON.stringify({ code: "0", data: [details.get(id)] }), { status: 200 });
      }
      const body = JSON.parse(String(init?.body)) as Record<string, string>;
      const algoId = `S${++sequence}`;
      details.set(algoId, { algoId, instId: body.instId ?? "", tdMode: body.tdMode ?? "", side: body.side ?? "",
        ordType: body.ordType ?? "", posSide: body.posSide ?? "", sz: body.sz ?? "", state: "live",
        slTriggerPx: body.slTriggerPx ?? "", slTriggerPxType: body.slTriggerPxType ?? "",
        tpTriggerPx: body.tpTriggerPx ?? "", tpTriggerPxType: body.tpTriggerPxType ?? "" });
      return new Response(JSON.stringify({ code: "0", data: [{ sCode: "0", algoId }] }), { status: 200 });
    }) as unknown as typeof fetch });
  await placeConditionalProtection(client, { instId: "SUI-USDT-SWAP", posSide: "short", contracts: "2", tickSz: "0.001",
    stopPrice: 1.2341, takeProfitPrice: 1.1009 });
  const bodies = requests.filter(r => r.init?.method === "POST").map(r => JSON.parse(String(r.init?.body)) as Record<string, unknown>);
  assert.equal(bodies[0]?.side, "buy");
  assert.equal(bodies[0]?.posSide, "short");
  assert.equal(bodies[0]?.slTriggerPx, "1.234");
  assert.equal(bodies[1]?.side, "buy");
  assert.equal(bodies[1]?.tpTriggerPx, "1.101");
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
