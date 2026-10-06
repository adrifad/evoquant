import test from "node:test";
import assert from "node:assert/strict";
import { getHistoryCandlesPaged } from "../src/exchange/okx/market.ts";
import type { OkxClient } from "../src/exchange/okx/client.ts";

test("historical candle pagination walks backward, deduplicates cursors, and respects cutoff", async () => {
  const calls: Array<number | undefined> = [];
  const pages: Record<string, string[][]> = {
    first: [["5000","5","6","4","5","1","1","1","1"],["4000","4","5","3","4","1","1","1","1"]],
    "4000": [["4000","4","5","3","4","1","1","1","1"],["3000","3","4","2","3","1","1","1","1"]],
    "3000": [["3000","3","4","2","3","1","1","1","1"],["1000","1","2","0","1","1","1","1","1"]],
  };
  const fake = { get: async <T>(_url: string, query?: Record<string, unknown>): Promise<T> => {
    const after = query?.after === undefined ? undefined : Number(query.after);
    calls.push(after);
    const key = after === undefined ? "first" : String(after);
    return (pages[key] ?? []) as T;
  } } as unknown as OkxClient;
  const candles = await getHistoryCandlesPaged(fake, "BTC-USDT-SWAP", "15m", 2000, { pageSize: 2, requestDelayMs: 0 });
  assert.deepEqual(calls, [undefined, 4000, 3000]);
  assert.deepEqual(candles.map((c) => c.ts), [3000, 4000, 5000]);
  assert.equal(new Set(candles.map((c) => c.ts)).size, 3);
});
