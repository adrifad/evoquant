// dev probe: show demo balances (uses M1 modules)
import { readFileSync } from "node:fs";
import path from "node:path";
import { createDemoExchange } from "../exchange/okx/index.ts";
import { getBalance } from "../exchange/okx/account.ts";

const envPath = path.resolve(import.meta.dirname, "../../.env");
const env: Record<string, string> = {};
for (const l of readFileSync(envPath, "utf8").split("\n")) {
  const m = l.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
  if (m && m[1]) env[m[1]] = m[2] ?? "";
}
const { client } = createDemoExchange({ ...env, OKX_ENV: "demo" });
const bal = await getBalance(client);
console.log("totalEq(USD):", bal.totalEq);
for (const d of bal.details) {
  console.log(`${d.ccy}: availBal=${d.availBal} eq=${d.eq} availEq=${d.availEq}`);
}
