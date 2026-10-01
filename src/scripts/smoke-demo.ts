// M1 scope item 11 — the spec §8–§13 live demo walkthrough.
// Requires OKX demo credentials in .env (spec §5.1). HARD DEMO GUARD (§44):
// aborts unless OKX_ENV=demo. Opens/closes LONG then SHORT with 1 contract,
// verifying via the exchange (source of truth, §7.8/§45) after every step.

import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

// load .env minimally (no deps)
function loadEnv(): Record<string, string | undefined> {
  const file = path.resolve(import.meta.dirname, "../../.env");
  if (!existsSync(file)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && m[1] && m[2] !== undefined) out[m[1]] = m[2];
  }
  return { ...out, ...process.env };
}

const env = loadEnv();

async function main(): Promise<void> {
  const { createDemoExchange } = await import("../exchange/okx/index.ts");
  const { getServerTime, getInstruments } = await import("../exchange/okx/market.ts");
  const { getBalance, getPositions, setLeverage } = await import("../exchange/okx/account.ts");
  const { placeOrder, getOrder, getFills, waitForOrderTerminal } = await import("../exchange/okx/orders.ts");

  // §43 step 1: environment must equal DEMO (guard inside factory too).
  if (!env.OKX_API_KEY || !env.OKX_API_SECRET || !env.OKX_PASSPHRASE) {
    console.error("Missing OKX demo credentials in .env — create them per spec §5.1");
    console.error("(OKX → Trade → Demo Trading → Personal Center → Demo Trading API)");
    process.exit(2);
  }
  const { client } = createDemoExchange(env);
  console.log("[guard] OKX_ENV=demo enforced (§44)");

  // §43 step 5: server time / clock drift
  const t0 = await getServerTime(client);
  const drift = Date.now() - t0;
  console.log(`[time] server=${new Date(t0).toISOString()} drift=${drift}ms`);
  if (Math.abs(drift) > 3000) throw new Error(`clock drift ${drift}ms too high (§23 kill switch)`);

  // §8 step 1: validate credentials
  const bal = await getBalance(client);
  console.log(`[balance] totalEq=${bal.totalEq} (creds OK, code=0) — §8.1`);

  // §8 step 2: instrument metadata
  const [inst] = await getInstruments(client, "SWAP", "BTC-USDT-SWAP");
  if (!inst) throw new Error("BTC-USDT-SWAP not found");
  console.log(`[instrument] tickSz=${inst.tickSz} lotSz=${inst.lotSz} minSz=${inst.minSz} ctVal=${inst.ctVal}${inst.ctValCcy}`);

  // §8 step 3: position mode — verify, do not blindly set (§7.9)
  const poss = await getPositions(client);
  console.log(`[positions] open=${poss.length} (reconciled with exchange — §45)`);
  if (poss.length > 0) throw new Error(`unexpected open positions from previous run: ${poss.map(p => p.posSide).join(",")} — close manually first (§23 unexpected_position)`);

  // §8 step 4: leverage 3x both sides (isolated long/short)
  const lev = await setLeverage(client, "BTC-USDT-SWAP", 3, 5);
  console.log(`[leverage] long=${lev.long.lever} short=${lev.short.lever} (hard_max 5)`);

  const day = new Date().toISOString().slice(0, 10).replaceAll("-", "");
  const seq = { n: 0 };
  const nextCl = (kind: string, side: string) =>
    `EVQ-BTC-${kind}-${side}-${day}-${String(++seq.n).padStart(6, "0")}`.slice(0, 32); // §15

  async function roundTrip(kind: "LONG" | "SHORT"): Promise<void> {
    const posSide = kind === "LONG" ? "long" : "short";
    const openSide = kind === "LONG" ? "buy" : "sell"; // §4.2
    const closeSide = kind === "LONG" ? "sell" : "buy";

    const clOpen = nextCl(kind === "LONG" ? "L" : "S", "OPEN");
    const placed = await placeOrder(client, {
      instId: "BTC-USDT-SWAP", tdMode: "isolated", side: openSide, posSide,
      ordType: "market", sz: "1", clOrdId: clOpen,
    });
    console.log(`[${kind}] opened ordId=${placed.ordId} clOrdId=${clOpen}`);

    const filled = await waitForOrderTerminal(client, "BTC-USDT-SWAP", placed.ordId, { timeoutMs: 30_000, pollMs: 1_000 });
    if (filled.state !== "filled") throw new Error(`open order ended ${filled.state} (§14)`);
    console.log(`[${kind}] fill avgPx=${filled.avgPx} accFillSz=${filled.accFillSz}`);

    const after = await getPositions(client, "BTC-USDT-SWAP");
    const pos = after.find(p => p.posSide === posSide);
    if (!pos || pos.pos === "0") throw new Error(`[${kind}] position not visible on exchange after fill (§7.8)`);
    console.log(`[${kind}] verified on exchange: pos=${pos.pos} avgPx=${pos.avgPx} markPx=${pos.markPx} lever=${pos.lever} upl=${pos.upl}`);

    const clClose = nextCl(kind === "LONG" ? "L" : "S", "CLOSE");
    const closed = await placeOrder(client, {
      instId: "BTC-USDT-SWAP", tdMode: "isolated", side: closeSide, posSide,
      ordType: "market", sz: "1", clOrdId: clClose,
    });
    const closedFill = await waitForOrderTerminal(client, "BTC-USDT-SWAP", closed.ordId, { timeoutMs: 30_000, pollMs: 1_000 });
    if (closedFill.state !== "filled") throw new Error(`close order ended ${closedFill.state} (§14)`);
    const fills = await getFills(client, "BTC-USDT-SWAP", closed.ordId);
    console.log(`[${kind}] closed avgPx=${closedFill.avgPx} fills=${fills.length}`);

    const final = await getPositions(client, "BTC-USDT-SWAP");
    const still = final.find(p => p.posSide === posSide);
    if (still && still.pos !== "0") throw new Error(`[${kind}] position still open after close: ${still.pos}`);
    console.log(`[${kind}] position zeroed on exchange ✓`);
  }

  // §9–§11 LONG, §12–§13 SHORT
  await roundTrip("LONG");
  await roundTrip("SHORT");

  console.log("SMOKE_DEMO_OK — §8–§13 walkthrough complete (demo only, §44)");
}

main().catch((err) => {
  console.error("SMOKE_DEMO_FAIL:", err instanceof Error ? err.message : err);
  process.exit(1);
});
