// M1 scope item 10 — smoke test against OKX PUBLIC demo endpoints.
// No credentials, no orders — read-only (spec §8 steps 1–2 minus private).
// Exits non-zero on any failure. Run: npm run smoke:public

import { createDemoMarketOnly } from "../exchange/okx/index.ts";
import { getServerTime, getInstruments, getTicker, getCandles, latestClosedCandle } from "../exchange/okx/market.ts";

const INST_ID = "BTC-USDT-SWAP";

async function main(): Promise<number> {
  const { client } = createDemoMarketOnly({ OKX_ENV: "demo" });

  const time = await getServerTime(client); // §7.1
  console.log(`server time: ${new Date(time).toISOString()} (drift vs local: ${Date.now() - time}ms)`);

  const [inst] = await getInstruments(client, "SWAP", INST_ID); // §7.2
  if (!inst) throw new Error(`instrument ${INST_ID} not found`);
  console.log(`instrument: tickSz=${inst.tickSz} lotSz=${inst.lotSz} minSz=${inst.minSz} ctVal=${inst.ctVal} ${inst.ctValCcy}`);

  const ticker = await getTicker(client, INST_ID); // §7.5
  console.log(`ticker last=${ticker.last}`);

  const candles = await getCandles(client, INST_ID, "15m", 300); // §7.3
  const closed = candles.filter((c) => c.confirm === "1").length;
  console.log(`candles fetched=${candles.length} closed=${closed}`);
  if (candles.length === 0) throw new Error("no candles returned");

  const lastClosed = await latestClosedCandle(client, INST_ID, "15m");
  console.log(`last closed 15m: ts=${new Date(lastClosed.ts).toISOString()} o=${lastClosed.o} c=${lastClosed.c} confirm=${lastClosed.confirm}`);
  if (lastClosed.confirm !== "1") throw new Error("latestClosedCandle returned unconfirmed candle");

  console.log("SMOKE_PUBLIC_OK");
  return 0;
}

main().then((code) => process.exit(code)).catch((err) => {
  console.error("SMOKE_PUBLIC_FAIL:", err instanceof Error ? err.message : err);
  process.exit(1);
});
