// Setup helper: reads credentials from a local file and writes .env (mode 600).
// Usage: node --experimental-strip-types src/scripts/setup-env.ts <creds-file>
// creds-file lines: KEY / SECRET / PASSPHRASE (also reads OKX keys + LLM key).
// Keeps secrets out of chat history and shell history.

import { readFileSync, writeFileSync, chmodSync, existsSync } from "node:fs";
import path from "node:path";

const src = process.argv[2];
if (!src || !existsSync(src)) {
  console.error("usage: setup-env.ts <creds-file> (KEY, SECRET, PASSPHRASE, LLM key — 4 lines)");
  process.exit(2);
}
const lines = readFileSync(src, "utf8").split("\n").map((l) => l.trim()).filter(Boolean);
if (lines.length < 3) {
  console.error("creds file needs at least 3 lines: API_KEY, API_SECRET, PASSPHRASE");
  process.exit(2);
}
const [key, secret, pass, llmKey] = lines;
const root = path.resolve(import.meta.dirname, "../..");
const envPath = path.join(root, ".env");

// preserve existing non-secret lines (LLM_BASE_URL etc.) when present
const existing = existsSync(envPath)
  ? Object.fromEntries(
      readFileSync(envPath, "utf8")
        .split("\n")
        .map((l) => l.match(/^([A-Z_]+)=(.*)$/))
        .filter((m): m is RegExpMatchArray => m !== null)
        .map((m) => [m[1]!, m[2]!]),
    )
  : {};

const out = {
  ...existing,
  OKX_API_KEY: key,
  OKX_API_SECRET: secret,
  OKX_PASSPHRASE: pass,
  OKX_ENV: "demo",
  ...(llmKey ? { LLM_API_KEY: llmKey } : {}),
};
writeFileSync(envPath, Object.entries(out).map(([k, v]) => `${k}=${v}`).join("\n") + "\n");
chmodSync(envPath, 0o600);
console.log(`.env written (OKX key length ${key!.length}, passphrase set ${pass ? "yes" : "no"})`);
// shred the source file so secrets live in exactly one place
writeFileSync(src, "");
console.log("creds file cleared");
