import { loadRepoEnv } from "./env.ts";

/** Evaluated per gate invocation so a repository .env edit can disable memory without a rebuild. */
export function gateMemoryEnabled(root: string): boolean {
  try { return loadRepoEnv(root).GATE_MEMORY_ENABLED?.trim().toLowerCase() === "true"; }
  catch { return false; }
}
