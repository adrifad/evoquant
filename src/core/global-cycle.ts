import { kvGet, kvSet, type Store } from "../memory/db.ts";

/** Persisted idempotency gate so repeated per-symbol/overlapping ticks cannot rerun system-wide evolution. */
export async function runOncePerGlobalCycle(store: Store, timeframe: string, cycleTs: number, task: () => Promise<void>): Promise<boolean> {
  if (!Number.isFinite(cycleTs) || cycleTs <= 0) return false;
  const key = `global_evolution_cycle:${timeframe}`;
  const last = Number(kvGet(store, key) ?? "0");
  if (cycleTs <= last) return false;
  await task();
  kvSet(store, key, String(cycleTs));
  return true;
}
