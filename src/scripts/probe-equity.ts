// probe: does opening an isolated position reduce USDT availEq (= false daily loss)?
// open 0.01 ct BTC long → read balance → close → read balance again.
import { loadRepoEnv, REPO_ROOT } from "../core/env.ts";
import { createDemoExchange } from "../exchange/okx/index.ts";
import { getBalance } from "../exchange/okx/account.ts";
import { getInstruments } from "../exchange/okx/market.ts";
import { placeOrder, waitForOrderTerminal, closePosition } from "../exchange/okx/orders.ts";

const env = loadRepoEnv(REPO_ROOT);
const { client } = createDemoExchange(env);
const [inst] = await getInstruments(client, "SWAP", "BTC-USDT-SWAP");

async function usdt(): Promise<string> {
  const b = await getBalance(client);
  const d = b.details.find((x) => x.ccy === "USDT");
  return `availBal=${d?.availBal} availEq=${d?.availEq} eq=${d?.eq} | totalEq=${b.totalEq}`;
}
console.log("BEFORE:", await usdt());

const o = await placeOrder(client, {
  instId: "BTC-USDT-SWAP", tdMode: "isolated", side: "buy", posSide: "long",
  ordType: "market", sz: "0.01", clOrdId: "EVQEQPROBEOPEN1",
});
await waitForOrderTerminal(client, "BTC-USDT-SWAP", o.ordId, { timeoutMs: 30_000 });
console.log("WITH POSITION OPEN:", await usdt());

const c = await closePosition(client, {
  instId: "BTC-USDT-SWAP", posSide: "long", contracts: "0.01",
  clOrdId: "EVQEQPROBECLOSE1", lotSz: inst!.lotSz, minSz: inst!.minSz,
});
await waitForOrderTerminal(client, "BTC-USDT-SWAP", c.ordId, { timeoutMs: 30_000 });
console.log("AFTER CLOSE:", await usdt());
