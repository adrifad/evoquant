// live probe §16 Layer A on OKX demo: open minSz LONG → place conditional
// SL/TP algo → query → cancel algo → close position → verify zero.
import { loadRepoEnv, REPO_ROOT } from "../core/env.ts";
import { createDemoExchange } from "../exchange/okx/index.ts";
import { getInstruments } from "../exchange/okx/market.ts";
import { getPositions } from "../exchange/okx/account.ts";
import { placeOrder, waitForOrderTerminal, closePosition } from "../exchange/okx/orders.ts";
import { placeConditionalProtection, cancelAlgo } from "../exchange/okx/algo.ts";
import { getTicker } from "../exchange/okx/market.ts";

const env = loadRepoEnv(REPO_ROOT);
const { client } = createDemoExchange(env);
const [inst] = await getInstruments(client, "SWAP", "BTC-USDT-SWAP");
if (!inst) throw new Error("no instrument");

const open = await placeOrder(client, {
  instId: "BTC-USDT-SWAP", tdMode: "isolated", side: "buy", posSide: "long",
  ordType: "market", sz: inst.minSz, clOrdId: "EVQALGOPROBEOPEN1".slice(0, 32),
});
await waitForOrderTerminal(client, "BTC-USDT-SWAP", open.ordId, { timeoutMs: 30_000 });
console.log("position opened");

const px = (await getTicker(client, "BTC-USDT-SWAP")).last;
try {
  const algo = await placeConditionalProtection(client, {
    instId: "BTC-USDT-SWAP", posSide: "long", contracts: inst.minSz,
    stopPrice: Math.round(px * 0.985 * 100) / 100,
    takeProfitPrice: Math.round(px * 1.03 * 100) / 100,
    clAlgoId: "EVQALGOPROBEALGO1".slice(0, 32),
  });
  console.log("ALGO_OK algoId=", algo.algoId);
  await cancelAlgo(client, "BTC-USDT-SWAP", algo.algoId);
  console.log("ALGO_CANCELLED");
} catch (e) {
  console.log("ALGO_FAIL:", e instanceof Error ? e.message.slice(0, 200) : e);
}

await closePosition(client, {
  instId: "BTC-USDT-SWAP", posSide: "long", contracts: inst.minSz,
  clOrdId: "EVQALGOPROBECLOSE1".slice(0, 32), lotSz: inst.lotSz, minSz: inst.minSz,
}).then((c) => waitForOrderTerminal(client, "BTC-USDT-SWAP", c.ordId, { timeoutMs: 30_000 }));
const poss = await getPositions(client, "BTC-USDT-SWAP");
const still = poss.filter((p) => p.pos !== "0");
console.log(still.length === 0 ? "ALGO_PROBE_OK (position closed, clean)" : `WARN: ${still.length} positions remain`);
