// Shared .env loader (no deps). Used by scripts, bot, and server.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export function loadRepoEnv(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const file = path.join(root, ".env");
  if (existsSync(file)) {
    for (const line of readFileSync(file, "utf8").split("\n")) {
      const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
      if (m && m[1]) out[m[1]] = m[2] ?? "";
    }
  }
  for (const [k, v] of Object.entries(process.env)) if (typeof v === "string") out[k] = v;
  return out;
}

export const REPO_ROOT = path.resolve(import.meta.dirname, "../..");
