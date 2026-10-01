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
  ts TEXT PRIMARY KEY,
  instrument TEXT NOT NULL,
  features TEXT NOT NULL  -- JSON FeatureSnapshot
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
  stop_px REAL, take_profit_px REAL,
  exit_px REAL, exit_ts TEXT,
  exit_reason TEXT,                -- TP | SL | AI_CLOSE | RISK_CLOSE | MANUAL
  cl_open_id TEXT, cl_close_id TEXT,
  ord_open_id TEXT, ord_close_id TEXT,
  fees REAL, funding REAL,
  pnl REAL, pnl_pct REAL, result_r REAL,
  mfe REAL, mae REAL, duration_s INTEGER,
  raw_confidence REAL, calibrated_confidence REAL,
  planned_risk_pct REAL, leverage REAL,
  entry_features TEXT              -- JSON snapshot at entry (§26)
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
  return {
    db,
    close: () => db.close(),
  };
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
