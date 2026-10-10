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
  engine TEXT NOT NULL DEFAULT 'SWING_15M', -- SWING_15M | SCALP_5M; legacy rows backfilled below
  result_r_basis TEXT NOT NULL DEFAULT 'NET',
  status TEXT NOT NULL,            -- OPEN | RECONCILIATION_PENDING | CLOSED
  evidence_state TEXT NOT NULL DEFAULT 'OPEN', -- OPEN | RECONCILIATION_PENDING | VALID | ACCOUNTING_INCOMPLETE
  evolution_evidence_eligible INTEGER NOT NULL DEFAULT 1,
  accounting_quality TEXT NOT NULL DEFAULT 'PENDING', -- PENDING | FUNDING_UNAVAILABLE | COMPLETE
  instrument TEXT NOT NULL,
  timeframe TEXT NOT NULL,
  side TEXT NOT NULL,              -- LONG | SHORT
  strategy TEXT NOT NULL,
  strategy_core_version INTEGER NOT NULL DEFAULT 1,
  strategy_version INTEGER NOT NULL,
  regime TEXT NOT NULL,
  regime_axes TEXT,
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
  planned_risk_pct REAL, leverage REAL, max_hold_bars INTEGER,
  entry_features TEXT,             -- JSON snapshot at entry (§26)
  entry_conditions TEXT,
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
  scope_engine TEXT, scope_strategy_version INTEGER, scope_direction TEXT, scope_regime_axes TEXT,
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
CREATE TABLE IF NOT EXISTS strategy_v2_versions (
  strategy TEXT NOT NULL,
  version INTEGER NOT NULL,
  parent_version INTEGER,
  params TEXT NOT NULL,
  status TEXT NOT NULL,             -- CHAMPION | CHALLENGER | SHADOW | PROMOTED | REJECTED | SUPERSEDED
  changed_parameter TEXT,
  old_value REAL,
  new_value REAL,
  hypothesis TEXT,
  evidence TEXT,
  created_ts TEXT NOT NULL,
  updated_ts TEXT NOT NULL,
  status_reason TEXT,
  shadow_started_ts TEXT,
  PRIMARY KEY(strategy,version)
);
CREATE INDEX IF NOT EXISTS idx_strategy_v2_lifecycle ON strategy_v2_versions(status,strategy,version);
CREATE TRIGGER IF NOT EXISTS strategy_v2_definition_immutable
BEFORE UPDATE OF strategy,version,parent_version,params,changed_parameter,old_value,new_value,hypothesis,created_ts
ON strategy_v2_versions
BEGIN
  SELECT RAISE(ABORT, 'V2 strategy definitions are immutable');
END;
CREATE TABLE IF NOT EXISTS shadow_trades (
  shadow_trade_id TEXT PRIMARY KEY,
  engine TEXT NOT NULL,
  strategy TEXT NOT NULL,
  strategy_core_version INTEGER NOT NULL DEFAULT 2,
  strategy_version INTEGER NOT NULL,
  shadow_role TEXT NOT NULL DEFAULT 'CHALLENGER', -- CHAMPION | CHALLENGER
  shadow_experiment_id TEXT NOT NULL DEFAULT 'LEGACY',
  instrument TEXT NOT NULL,
  side TEXT NOT NULL,
  status TEXT NOT NULL,             -- PENDING | OPEN | CLOSED
  signal_ts INTEGER NOT NULL,
  last_processed_ts INTEGER NOT NULL,
  entry_ts INTEGER,
  exit_ts INTEGER,
  signal_price REAL NOT NULL,
  entry_price REAL,
  exit_price REAL,
  stop_price REAL,
  initial_stop_price REAL,
  take_profit_price REAL,
  stop_atr REAL NOT NULL,
  target_r REAL NOT NULL,
  max_hold_bars INTEGER NOT NULL,
  bars_held INTEGER NOT NULL DEFAULT 0,
  risk_distance REAL,
  active_stop REAL,
  regime TEXT,
  regime_axes TEXT NOT NULL,
  entry_conditions TEXT NOT NULL,
  exit_reason TEXT,
  gross_r REAL,
  net_r REAL,
  fees_r REAL,
  mfe_r REAL NOT NULL DEFAULT 0,
  mae_r REAL NOT NULL DEFAULT 0,
  costs_json TEXT NOT NULL,
  tick_size REAL NOT NULL DEFAULT 0.00000001,
  UNIQUE(strategy,strategy_core_version,strategy_version,shadow_role,instrument,signal_ts)
);
CREATE INDEX IF NOT EXISTS idx_shadow_trades_evidence ON shadow_trades(strategy,strategy_version,status,instrument,exit_ts);
CREATE TABLE IF NOT EXISTS strategy_v2_evaluations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  strategy TEXT NOT NULL,
  champion_version INTEGER NOT NULL,
  challenger_version INTEGER NOT NULL,
  stage TEXT NOT NULL,
  metrics TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_strategy_v2_evaluations ON strategy_v2_evaluations(strategy,id DESC);
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
CREATE TABLE IF NOT EXISTS llm_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  role TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  status TEXT NOT NULL,
  latency_ms INTEGER NOT NULL,
  input_tokens INTEGER,
  output_tokens INTEGER,
  error_class TEXT,
  context_ref TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_llm_runs_role_ts ON llm_runs(role,ts DESC);
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
  const hadEngine = cols.has("engine");
  if (!hadEngine) db.exec("ALTER TABLE trades ADD COLUMN engine TEXT NOT NULL DEFAULT 'SWING_15M'");
  if (!cols.has("result_r_basis")) db.exec("ALTER TABLE trades ADD COLUMN result_r_basis TEXT NOT NULL DEFAULT 'LEGACY_GROSS'");
  if (!cols.has("algo_id")) db.exec("ALTER TABLE trades ADD COLUMN algo_id TEXT");
  if (!cols.has("fees_paid")) db.exec("ALTER TABLE trades ADD COLUMN fees_paid REAL DEFAULT 0");
  if (!cols.has("decision_id")) db.exec("ALTER TABLE trades ADD COLUMN decision_id TEXT");
  if (!cols.has("initial_stop_px")) db.exec("ALTER TABLE trades ADD COLUMN initial_stop_px REAL");
  if (!cols.has("max_hold_bars")) db.exec("ALTER TABLE trades ADD COLUMN max_hold_bars INTEGER");
  if (!cols.has("regime_axes")) db.exec("ALTER TABLE trades ADD COLUMN regime_axes TEXT");
  if (!cols.has("entry_conditions")) db.exec("ALTER TABLE trades ADD COLUMN entry_conditions TEXT");
  if (!cols.has("evidence_state")) db.exec("ALTER TABLE trades ADD COLUMN evidence_state TEXT NOT NULL DEFAULT 'OPEN'");
  if (!cols.has("evolution_evidence_eligible")) db.exec("ALTER TABLE trades ADD COLUMN evolution_evidence_eligible INTEGER NOT NULL DEFAULT 0");
  if (!cols.has("accounting_quality")) db.exec("ALTER TABLE trades ADD COLUMN accounting_quality TEXT NOT NULL DEFAULT 'PENDING'");
  // Historical records are Core 1 unless a future migration has explicit evidence.
  if (!cols.has("strategy_core_version")) db.exec("ALTER TABLE trades ADD COLUMN strategy_core_version INTEGER NOT NULL DEFAULT 1");
  db.exec(`UPDATE trades SET engine=CASE WHEN lower(timeframe)='scalp' THEN 'SCALP_5M' ELSE 'SWING_15M' END
    WHERE ${hadEngine ? "engine IS NULL OR engine NOT IN ('SWING_15M','SCALP_5M')" : "1=1"}`);
  db.exec("DROP INDEX IF EXISTS idx_trades_learning_scope");
  db.exec("CREATE INDEX IF NOT EXISTS idx_trades_learning_scope ON trades(engine,strategy_core_version,status,strategy,strategy_version,instrument,regime,side)");
  db.exec("UPDATE trades SET initial_stop_px=stop_px WHERE initial_stop_px IS NULL AND stop_px IS NOT NULL");
  db.exec(`UPDATE trades SET evidence_state=CASE WHEN status='CLOSED' THEN 'ACCOUNTING_INCOMPLETE' ELSE 'OPEN' END
    WHERE evidence_state IS NULL OR evidence_state=''`);
  const lessonCols = new Set((db.prepare("PRAGMA table_info(lessons)").all() as Array<{ name: string }>).map((c) => c.name));
  if (!lessonCols.has("scope_engine")) db.exec("ALTER TABLE lessons ADD COLUMN scope_engine TEXT");
  if (!lessonCols.has("scope_strategy_version")) db.exec("ALTER TABLE lessons ADD COLUMN scope_strategy_version INTEGER");
  if (!lessonCols.has("scope_direction")) db.exec("ALTER TABLE lessons ADD COLUMN scope_direction TEXT");
  if (!lessonCols.has("scope_regime_axes")) db.exec("ALTER TABLE lessons ADD COLUMN scope_regime_axes TEXT");
  const v2VersionCols = new Set((db.prepare("PRAGMA table_info(strategy_v2_versions)").all() as Array<{ name: string }>).map((c) => c.name));
  if (!v2VersionCols.has("shadow_started_ts")) db.exec("ALTER TABLE strategy_v2_versions ADD COLUMN shadow_started_ts TEXT");
  const shadowCols = new Set((db.prepare("PRAGMA table_info(shadow_trades)").all() as Array<{ name: string }>).map((c) => c.name));
  if (!shadowCols.has("strategy_core_version")) db.exec("ALTER TABLE shadow_trades ADD COLUMN strategy_core_version INTEGER NOT NULL DEFAULT 2");
  if (!shadowCols.has("shadow_role")) db.exec("ALTER TABLE shadow_trades ADD COLUMN shadow_role TEXT NOT NULL DEFAULT 'CHALLENGER'");
  if (!shadowCols.has("shadow_experiment_id")) db.exec("ALTER TABLE shadow_trades ADD COLUMN shadow_experiment_id TEXT NOT NULL DEFAULT 'LEGACY'");
  if (!shadowCols.has("tick_size")) db.exec("ALTER TABLE shadow_trades ADD COLUMN tick_size REAL NOT NULL DEFAULT 0.00000001");
  // Preserve old Challenger-only rows but exclude them from matched experiments.
  db.exec(`UPDATE shadow_trades SET strategy=CASE strategy
      WHEN 'TREND_FOLLOWING_V2' THEN 'TREND_FOLLOWING'
      WHEN 'BREAKOUT_V2' THEN 'BREAKOUT'
      WHEN 'MEAN_REVERSION_V2' THEN 'MEAN_REVERSION' ELSE strategy END
    WHERE strategy IN ('TREND_FOLLOWING_V2','BREAKOUT_V2','MEAN_REVERSION_V2')`);
  db.exec("CREATE INDEX IF NOT EXISTS idx_shadow_experiment ON shadow_trades(strategy,strategy_core_version,strategy_version,shadow_experiment_id,shadow_role,status,instrument)");
  // Legacy lesson scope cannot reliably distinguish pre-isolation swing vs
  // scalp evidence. Keep it preserved but unassigned; consumers exclude NULL.
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
