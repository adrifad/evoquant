// M2 (§40/§41/§45/§51) — SQLite persistence. Tables cover spec §40 subset
// actually used by M2-M7; every decision (incl. HOLD) is stored (§41).
// NOTE: no secrets are ever written here.

import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import path from "node:path";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS decisions (
  decision_id TEXT PRIMARY KEY,
  ts TEXT NOT NULL,
  instrument TEXT NOT NULL,
  decision TEXT NOT NULL,
  strategy TEXT,
  regime TEXT,
  raw_confidence REAL,
  calibrated_confidence REAL,
  thesis TEXT,           -- JSON array
  risk_verdict TEXT      -- JSON {approved,reason,checks}
);
CREATE TABLE IF NOT EXISTS market_snapshots (
  ts TEXT NOT NULL,
  instrument TEXT NOT NULL,
  features TEXT NOT NULL, -- JSON FeatureSnapshot
  PRIMARY KEY (ts, instrument)
);
CREATE TABLE IF NOT EXISTS trades (
  trade_id TEXT PRIMARY KEY,
  status TEXT NOT NULL,            -- OPEN | CLOSED
  instrument TEXT NOT NULL,
  timeframe TEXT NOT NULL,
  side TEXT NOT NULL,              -- LONG | SHORT
  strategy TEXT NOT NULL,
  strategy_version INTEGER NOT NULL,
  regime TEXT NOT NULL,
  contracts TEXT NOT NULL,
  entry_px REAL, entry_ts TEXT,
  stop_px REAL, initial_stop_px REAL, take_profit_px REAL,
  exit_px REAL, exit_ts TEXT,
  exit_reason TEXT,                -- TP | SL | AI_CLOSE | RISK_CLOSE | MANUAL
  cl_open_id TEXT, cl_close_id TEXT,
  ord_open_id TEXT, ord_close_id TEXT,
  fees REAL, funding REAL,
  pnl REAL, pnl_pct REAL, result_r REAL,
  mfe REAL, mae REAL, duration_s INTEGER,
  raw_confidence REAL, calibrated_confidence REAL,
  planned_risk_pct REAL, leverage REAL,
  entry_features TEXT,             -- JSON snapshot at entry (§26)
  decision_id TEXT REFERENCES decisions(decision_id),
  algo_id TEXT,                    -- §16 Layer A conditional order id
  fees_paid REAL DEFAULT 0         -- §27 accumulated fill fees
);
CREATE TABLE IF NOT EXISTS trade_reviews (
  trade_id TEXT PRIMARY KEY REFERENCES trades(trade_id),
  ts TEXT NOT NULL,
  outcome TEXT, result_r REAL,
  observations TEXT,               -- JSON (§28)
  lesson_candidates TEXT           -- JSON array (§28)
);
CREATE TABLE IF NOT EXISTS lessons (
  lesson_id TEXT PRIMARY KEY,
  statement TEXT NOT NULL,
  status TEXT NOT NULL,            -- §29 states
  scope_strategy TEXT, scope_instrument TEXT, scope_regime TEXT,
  confidence REAL,
  observations INTEGER, wins INTEGER, losses INTEGER, expectancy_r REAL,
  created_ts TEXT, updated_ts TEXT,
  first_evidence_ts TEXT
);
CREATE TABLE IF NOT EXISTS lesson_evidence (
  lesson_id TEXT REFERENCES lessons(lesson_id),
  trade_id TEXT REFERENCES trades(trade_id),
  aligned INTEGER NOT NULL,        -- 1 trade supported, 0 contradicted
  ts TEXT NOT NULL,
  PRIMARY KEY (lesson_id, trade_id)
);
CREATE TABLE IF NOT EXISTS strategy_versions (
  name TEXT NOT NULL,
  version INTEGER NOT NULL,
  parent_version INTEGER,
  params TEXT NOT NULL,            -- JSON (§20)
  status TEXT NOT NULL,            -- CHAMPION|CHALLENGER|PROMOTED|REJECTED|SUPERSEDED|TESTING (§77)
  created_ts TEXT,
  hypothesis TEXT, evidence TEXT,
  PRIMARY KEY (name, version)
);
CREATE TABLE IF NOT EXISTS signal_weights (
  updated_ts TEXT PRIMARY KEY,
  weights TEXT NOT NULL,           -- JSON {trend,momentum,volume,volatility}
  evidence_sample INTEGER
);
CREATE TABLE IF NOT EXISTS system_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  kind TEXT NOT NULL,              -- RISK_EVENT|STATE|PROMOTION|REJECTION|ERROR
  payload TEXT NOT NULL            -- JSON
);
CREATE TABLE IF NOT EXISTS instruments (
  instId TEXT PRIMARY KEY, instType TEXT, tickSz TEXT, lotSz TEXT, minSz TEXT,
  ctVal TEXT, ctValCcy TEXT, cached_ts TEXT
);
CREATE TABLE IF NOT EXISTS candles (
  instId TEXT NOT NULL, bar TEXT NOT NULL, ts INTEGER NOT NULL,
  o REAL, h REAL, l REAL, c REAL, vol REAL, volCcy REAL, confirm TEXT,
  PRIMARY KEY (instId, bar, ts)
);
CREATE TABLE IF NOT EXISTS orders (
  ordId TEXT PRIMARY KEY, clOrdId TEXT, instId TEXT, side TEXT, posSide TEXT,
  ordType TEXT, sz TEXT, state TEXT, avgPx TEXT, cTime TEXT, uTime TEXT,
  trade_id TEXT, kind TEXT  -- OPEN|CLOSE|ALGO (§15 mapping to internal ids)
);
CREATE TABLE IF NOT EXISTS fills (
  tradeId TEXT NOT NULL, ordId TEXT NOT NULL, clOrdId TEXT, instId TEXT,
  fillPx TEXT, fillSz TEXT, fee TEXT, feeCcy TEXT, side TEXT, posSide TEXT, ts TEXT,
  PRIMARY KEY (tradeId, ordId, ts)
);
CREATE TABLE IF NOT EXISTS evolution_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT, trades_at_run INTEGER,
  proposals INTEGER, created_challengers INTEGER, note TEXT
);
CREATE TABLE IF NOT EXISTS evolution_comparisons (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  champion TEXT NOT NULL,
  challenger TEXT NOT NULL,
  promoted INTEGER NOT NULL,
  reasons TEXT NOT NULL,
  champion_metrics TEXT NOT NULL,
  challenger_metrics TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

export interface Store {
  db: Database.Database;
  close(): void;
}

export function openStore(root: string): Store {
  const dir = path.join(root, "data");
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "trader.db");
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA);
  // lightweight column migration for pre-existing DBs
  const cols = new Set((db.prepare("PRAGMA table_info(trades)").all() as Array<{ name: string }>).map((c) => c.name));
  if (!cols.has("algo_id")) db.exec("ALTER TABLE trades ADD COLUMN algo_id TEXT");
  if (!cols.has("fees_paid")) db.exec("ALTER TABLE trades ADD COLUMN fees_paid REAL DEFAULT 0");
  if (!cols.has("decision_id")) db.exec("ALTER TABLE trades ADD COLUMN decision_id TEXT");
  if (!cols.has("initial_stop_px")) db.exec("ALTER TABLE trades ADD COLUMN initial_stop_px REAL");
  db.exec("UPDATE trades SET initial_stop_px=stop_px WHERE initial_stop_px IS NULL AND stop_px IS NOT NULL");
  migrateFills(db);
  migrateMarketSnapshots(db);
  return {
    db,
    close: () => db.close(),
  };
}

function migrateFills(db: Database.Database): void {
  const cols = db.prepare("PRAGMA table_info(fills)").all() as Array<{ name: string; pk: number }>;
  const isCompositeKey = cols.some((c) => c.name === "tradeId" && c.pk === 1)
    && cols.some((c) => c.name === "ordId" && c.pk === 2)
    && cols.some((c) => c.name === "ts" && c.pk === 3);
  if (isCompositeKey) return;
  const isLegacyKey = cols.some((c) => c.name === "tradeId" && c.pk === 1)
    && !cols.some((c) => c.pk > 1);
  if (!isLegacyKey) throw new Error("unsupported fills schema; manual migration required");
  db.exec(`BEGIN;
    ALTER TABLE fills RENAME TO fills_legacy;
    CREATE TABLE fills (
      tradeId TEXT NOT NULL, ordId TEXT NOT NULL, clOrdId TEXT, instId TEXT,
      fillPx TEXT, fillSz TEXT, fee TEXT, feeCcy TEXT, side TEXT, posSide TEXT, ts TEXT,
      PRIMARY KEY (tradeId, ordId, ts)
    );
    INSERT OR IGNORE INTO fills SELECT tradeId,ordId,clOrdId,instId,fillPx,fillSz,fee,feeCcy,side,posSide,ts FROM fills_legacy;
    DROP TABLE fills_legacy;
    COMMIT;`);
}

function migrateMarketSnapshots(db: Database.Database): void {
  const cols = db.prepare("PRAGMA table_info(market_snapshots)").all() as Array<{ name: string; pk: number }>;
  const isCompositeKey = cols.some((c) => c.name === "ts" && c.pk === 1)
    && cols.some((c) => c.name === "instrument" && c.pk === 2);
  if (isCompositeKey) return;
  const isLegacyKey = cols.some((c) => c.name === "ts" && c.pk === 1) && !cols.some((c) => c.pk > 1);
  if (!isLegacyKey) throw new Error("unsupported market_snapshots schema; manual migration required");
  db.exec(`BEGIN;
    ALTER TABLE market_snapshots RENAME TO market_snapshots_legacy;
    CREATE TABLE market_snapshots (
      ts TEXT NOT NULL, instrument TEXT NOT NULL, features TEXT NOT NULL,
      PRIMARY KEY (ts, instrument)
    );
    INSERT OR IGNORE INTO market_snapshots SELECT ts,instrument,features FROM market_snapshots_legacy;
    DROP TABLE market_snapshots_legacy;
    COMMIT;`);
}

export function persistMarketSnapshot(store: Store, ts: string, instrument: string, features: unknown): void {
  store.db.prepare(`INSERT INTO market_snapshots(ts,instrument,features) VALUES(?,?,?)
    ON CONFLICT(ts,instrument) DO UPDATE SET features=excluded.features`).run(ts, instrument, JSON.stringify(features));
}

export function kvGet(store: Store, key: string): string | null {
  const row = store.db.prepare("SELECT value FROM kv WHERE key=?").get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function kvSet(store: Store, key: string, value: string): void {
  store.db.prepare("INSERT INTO kv(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, value);
}

export function logSystemEvent(store: Store, kind: string, payload: unknown): void {
  store.db
    .prepare("INSERT INTO system_events(ts,kind,payload) VALUES(?,?,?)")
    .run(new Date().toISOString(), kind, JSON.stringify(payload));
}
