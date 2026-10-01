// M1 scope item 7 — public surface of the OKX demo exchange module.
// createDemoExchange() is the ONLY way to obtain a client: it enforces the
// spec §44 demo guard from environment variables and wires market/account/
// orders modules onto one OkxClient.

import { OkxClient, OkxConfigError, type QueryParams } from "./client.ts";
import type { OkxCredentials } from "./auth.ts";
import * as market from "./market.ts";
import * as account from "./account.ts";
import * as orders from "./orders.ts";

export { market, account, orders, OkxClient, OkxConfigError };
export type { QueryParams, OkxCredentials };

export interface DemoExchange {
  client: OkxClient;
  market: typeof market;
  account: typeof account;
  orders: typeof orders;
}

// Env contract (spec §5.1): OKX_API_KEY / OKX_API_SECRET / OKX_PASSPHRASE.
// OKX_ENV must be exactly "demo" — anything else aborts before any request.
export function createDemoExchange(
  env: Record<string, string | undefined> = process.env,
  fetchImpl?: typeof fetch,
): DemoExchange {
  // spec §44 — DEMO ONLY hard guard.
  if (env.OKX_ENV !== "demo") {
    throw new OkxConfigError(
      `spec §44 DEMO ONLY: OKX_ENV must be "demo", got "${String(env.OKX_ENV)}"`,
    );
  }
  const apiKey = env.OKX_API_KEY ?? "";
  const secret = env.OKX_API_SECRET ?? "";
  const passphrase = env.OKX_PASSPHRASE ?? "";
  if (apiKey === "" || secret === "" || passphrase === "") {
    throw new OkxConfigError(
      "OKX demo credentials incomplete (OKX_API_KEY/OKX_API_SECRET/OKX_PASSPHRASE) — see spec §5.1; values never logged",
    );
  }
  const credentials: OkxCredentials = { apiKey, secret, passphrase };
  const client = new OkxClient({ environment: "demo", credentials, ...(fetchImpl ? { fetchImpl } : {}) });
  return { client, market, account, orders };
}

// Public, credential-free exchange view (smoke tests, data collection warm-up).
export function createDemoMarketOnly(
  env: Record<string, string | undefined> = process.env,
  fetchImpl?: typeof fetch,
): Pick<DemoExchange, "client" | "market"> {
  if (env.OKX_ENV !== "demo") {
    throw new OkxConfigError(`spec §44 DEMO ONLY: OKX_ENV must be "demo" (got "${String(env.OKX_ENV)}")`);
  }
  const client = new OkxClient({ environment: "demo", ...(fetchImpl ? { fetchImpl } : {}) });
  return { client, market };
}
