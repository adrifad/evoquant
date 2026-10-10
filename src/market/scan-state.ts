import type { Store } from "../memory/db.ts";
import type { ScanRow } from "../strategy/scanner.ts";

export type ScanEngine = "SWING_15M" | "SCALP_5M";
export type ScanResult = "CANDIDATE" | "NO_SETUP" | "FETCH_FAILED" | "SIGNAL" | "SKIPPED";

export interface MarketScanState {
  engine: ScanEngine;
  instrument: string;
  last_scan_at: string;
  last_success_at: string | null;
  candle_ts: number | null;
  candle_timeframe: string | null;
  result: ScanResult;
  strategy: string | null;
  side: "LONG" | "SHORT" | null;
  setup_score: number | null;
  reason: string | null;
}

export interface ScanStateUpdate {
  engine: ScanEngine;
  instrument: string;
  scannedAt: string;
  candleTs?: number | null;
  candleTimeframe?: string | null;
  result: ScanResult;
  strategy?: string | null;
  side?: "LONG" | "SHORT" | null;
  setupScore?: number | null;
  reason?: string | null;
}

const SUCCESSFUL_RESULTS = new Set<ScanResult>(["CANDIDATE", "NO_SETUP", "SIGNAL"]);

/**
 * Upsert latest scanner state only. Failed and skipped attempts update the
 * attempt timestamp/result without moving the last successful evaluation.
 */
export function recordScanState(store: Store, update: ScanStateUpdate): void {
  const reason = update.reason?.trim().slice(0, 240) || null;
  const successful = SUCCESSFUL_RESULTS.has(update.result);
  store.db.prepare(`INSERT INTO market_scan_state(
      engine,instrument,last_scan_at,last_success_at,candle_ts,candle_timeframe,result,strategy,side,setup_score,reason
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(engine,instrument) DO UPDATE SET
      last_scan_at=excluded.last_scan_at,
      last_success_at=CASE WHEN excluded.result IN ('CANDIDATE','NO_SETUP','SIGNAL')
        THEN excluded.last_success_at ELSE market_scan_state.last_success_at END,
      candle_ts=excluded.candle_ts,
      candle_timeframe=excluded.candle_timeframe,
      result=excluded.result,
      strategy=excluded.strategy,
      side=excluded.side,
      setup_score=excluded.setup_score,
      reason=excluded.reason`).run(
    update.engine,
    update.instrument,
    update.scannedAt,
    successful ? update.scannedAt : null,
    finiteOrNull(update.candleTs),
    update.candleTimeframe ?? null,
    update.result,
    update.strategy ?? null,
    update.side ?? null,
    finiteOrNull(update.setupScore),
    reason,
  );
}

/** Persist Swing results against the exact confirmed feature candle evaluated by Strategy Core. */
export function recordSwingScanResults(
  store: Store,
  rows: readonly ScanRow[],
  candleTimestamps: ReadonlyMap<string, number>,
  scannedAt = new Date().toISOString(),
  candleTimeframe = "15m",
): void {
  for (const row of rows) {
    const candidate = row.candidate ?? null;
    const isCandidate = candidate !== null || row.tradable;
    const failedConditions = row.conditions?.flatMap((evaluation) => evaluation.conditions
      .filter((condition) => !condition.passed).map((condition) => condition.name)) ?? [];
    const uniqueFailures = [...new Set(failedConditions)].slice(0, 3);
    recordScanState(store, {
      engine: "SWING_15M",
      instrument: row.instrument,
      scannedAt,
      candleTs: candleTimestamps.get(row.instrument) ?? null,
      candleTimeframe,
      result: isCandidate ? "CANDIDATE" : "NO_SETUP",
      strategy: candidate?.strategy ?? (isCandidate ? row.strategy : null),
      side: candidate?.side ?? (isCandidate ? row.score >= 0 ? "LONG" : "SHORT" : null),
      setupScore: candidate?.setupScore ?? (isCandidate ? Math.abs(row.score) : null),
      reason: isCandidate ? null : uniqueFailures.length ? `failed_conditions:${uniqueFailures.join(",")}` : "no_tradable_setup",
    });
  }
}

export function recordScalpScanResult(
  store: Store,
  input: { instrument: string; scannedAt: string; candleTs: number | null; candleTimeframe: string; signal?: { direction: 1 | -1; score: number }; veto?: string },
): void {
  const signal = input.signal;
  recordScanState(store, {
    engine: "SCALP_5M",
    instrument: input.instrument,
    scannedAt: input.scannedAt,
    candleTs: input.candleTs,
    candleTimeframe: input.candleTimeframe,
    result: signal ? "SIGNAL" : "NO_SETUP",
    strategy: signal ? "SCALP" : null,
    side: signal ? signal.direction === 1 ? "LONG" : "SHORT" : null,
    setupScore: signal?.score ?? null,
    reason: signal ? null : input.veto ?? "no_setup",
  });
}

/** Return persisted latest states for requested symbols, keyed by engine + instrument. */
export function getLatestScanStates(store: Store, instruments: readonly string[]): Map<string, MarketScanState> {
  const symbols = [...new Set(instruments.filter(Boolean))];
  if (!symbols.length) return new Map();
  const placeholders = symbols.map(() => "?").join(",");
  const rows = store.db.prepare(`SELECT engine,instrument,last_scan_at,last_success_at,candle_ts,candle_timeframe,result,strategy,side,setup_score,reason
    FROM market_scan_state WHERE instrument IN (${placeholders})`).all(...symbols) as MarketScanState[];
  return new Map(rows.map((row) => [scanStateKey(row.engine, row.instrument), row]));
}

export function scanStateKey(engine: ScanEngine, instrument: string): string {
  return `${engine}:${instrument}`;
}

function finiteOrNull(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
