import assert from "node:assert/strict";
import { createConnection } from "node:net";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { startDashboard } from "../src/core/dashboard.ts";
import { openStore } from "../src/memory/db.ts";

test("dashboard exposes current market data and authenticated websocket refresh", async () => {
  const store = openStore(mkdtempSync(path.join(os.tmpdir(), "evoq-dashboard-")));
  const dashboard = startDashboard({
    port: 0,
    auth: { user: "operator", password: "test-only" },
    trading: { instrument: { id: "BTC-USDT-SWAP" }, timeframe: "15m", leverage: { default: 3 } },
    risk: { hard_limits: { risk_per_trade_pct: 0.5 } },
    deps: () => ({ store, client: {} } as never),
    getLastTick: () => ({ features: { price: 100, rsi14: 55 }, regime: "SIDEWAYS", at: "2026-10-03T00:00:00.000Z" }),
    getKillReason: () => null,
    getScan: () => [{ instrument: "BTC-USDT-SWAP", regime: "SIDEWAYS", price: 100, score: 0, strategy: null, tradable: false }],
    evolution: { reviewEvery: true, signalInterval: 20, strategyInterval: 50, minSample: 30, maxWeightChangePct: 10, maxParamChanges: 2 },
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  const address = dashboard.address();
  assert.ok(address);
  const authorization = `Basic ${Buffer.from("operator:test-only").toString("base64")}`;
  const market = await fetch(`http://127.0.0.1:${address.port}/api/market`, { headers: { authorization } }).then((r) => r.json()) as { regime: string; scan: unknown[] };
  assert.equal(market.regime, "SIDEWAYS");
  assert.equal(market.scan.length, 1);
  const wsData = await new Promise<string>((resolve, reject) => {
    const socket = createConnection(address.port, "127.0.0.1");
    let received = "";
    const timer = setTimeout(() => reject(new Error("websocket refresh timeout")), 2_000);
    socket.on("connect", () => socket.write(`GET /ws HTTP/1.1\r\nHost: localhost\r\nAuthorization: ${authorization}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n`));
    socket.on("data", (chunk) => { received += chunk.toString("utf8"); if (received.includes("refresh")) { clearTimeout(timer); socket.destroy(); resolve(received); } });
    socket.on("error", reject);
  });
  assert.match(wsData, /101 Switching Protocols/);
  dashboard.close();
  store.close();
});
