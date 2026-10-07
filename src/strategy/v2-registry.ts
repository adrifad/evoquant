import type { Store } from "../memory/db.ts";
import {
  DEFAULT_V2_PARAMS, StrategyV2ParamsSchema, type StrategyV2Id, type StrategyV2Params,
} from "./core-v2.ts";
import { familyForV2 } from "./identity.ts";

export type V2VersionStatus = "CHAMPION" | "CHALLENGER" | "SHADOW" | "PROMOTED" | "REJECTED" | "SUPERSEDED";
export interface V2StrategyVersion {
  strategy: StrategyV2Id;
  version: number;
  parent_version: number | null;
  params: StrategyV2Params[StrategyV2Id];
  status: V2VersionStatus;
  changed_parameter: string | null;
  old_value: number | null;
  new_value: number | null;
  hypothesis: string | null;
  evidence: string | null;
  created_ts: string;
  updated_ts: string;
  status_reason: string | null;
  shadow_started_ts: string | null;
}

export const V2_STRATEGIES: readonly StrategyV2Id[] = [
  "TREND_FOLLOWING_V2", "BREAKOUT_V2", "MEAN_REVERSION_V2",
];

function familyParams<K extends StrategyV2Id>(strategy: K, input: unknown): StrategyV2Params[K] {
  const merged = StrategyV2ParamsSchema.parse({ ...DEFAULT_V2_PARAMS, [strategy]: input });
  return merged[strategy] as StrategyV2Params[K];
}

export function completeV2Params(strategy: StrategyV2Id, params: unknown): StrategyV2Params {
  return StrategyV2ParamsSchema.parse({ ...DEFAULT_V2_PARAMS, [strategy]: params });
}

/** Seeds a dedicated V2 registry, importing only valid historical V2 rows; V1 registry stays untouched. */
export function ensureV2Registry(store: Store, configured: StrategyV2Params = DEFAULT_V2_PARAMS): void {
  const insert = store.db.prepare(`INSERT OR IGNORE INTO strategy_v2_versions
    (strategy,version,parent_version,params,status,hypothesis,created_ts,updated_ts)
    VALUES(?,2,NULL,?,'CHAMPION',?,?,?)`);
  for (const strategy of V2_STRATEGIES) {
    const family = familyForV2(strategy);
    const legacy = store.db.prepare(`SELECT params,status,hypothesis,created_ts FROM strategy_versions
      WHERE name=? AND version=2`).get(family) as { params: string; status: string; hypothesis: string | null; created_ts: string | null } | undefined;
    if (legacy) {
      try {
        const parsed = familyParams(strategy, JSON.parse(legacy.params) as unknown);
        const status: V2VersionStatus = legacy.status === "TESTING" || legacy.status === "CHAMPION" ? "CHAMPION"
          : legacy.status === "REJECTED" || legacy.status === "SUPERSEDED" ? legacy.status : "CHALLENGER";
        store.db.prepare(`INSERT OR IGNORE INTO strategy_v2_versions
          (strategy,version,parent_version,params,status,hypothesis,created_ts,updated_ts)
          VALUES(?,2,NULL,?,?,?, ?,?)`).run(strategy, JSON.stringify(parsed), status,
          legacy.hypothesis ?? "Imported immutable V2 definition", legacy.created_ts ?? new Date().toISOString(), new Date().toISOString());
      } catch { /* V1-shaped version rows are intentionally not imported. */ }
    }
    insert.run(strategy, JSON.stringify(configured[strategy]),
      "Strategy Core V2 deterministic baseline", new Date().toISOString(), new Date().toISOString());
    const champion = store.db.prepare("SELECT 1 AS ok FROM strategy_v2_versions WHERE strategy=? AND status='CHAMPION' LIMIT 1")
      .get(strategy) as { ok: number } | undefined;
    if (!champion) throw new Error(`V2 strategy ${strategy} has no Champion; refusing to run without a validated active version`);
  }
}

export function listV2Versions(store: Store, strategy?: StrategyV2Id): V2StrategyVersion[] {
  const rows = store.db.prepare(`SELECT * FROM strategy_v2_versions ${strategy ? "WHERE strategy=?" : ""} ORDER BY strategy,version`)
    .all(...(strategy ? [strategy] : [])) as V2StrategyVersion[];
  return rows.map((row) => ({ ...row, params: familyParams(row.strategy, JSON.parse(String(row.params)) as unknown) }));
}

export function getV2Champions(store: Store): Record<StrategyV2Id, V2StrategyVersion> {
  const out = {} as Record<StrategyV2Id, V2StrategyVersion>;
  for (const strategy of V2_STRATEGIES) {
    const row = listV2Versions(store, strategy).find((version) => version.status === "CHAMPION");
    if (!row) throw new Error(`V2 strategy ${strategy} has no Champion`);
    out[strategy] = row;
  }
  return out;
}

export function getV2ChampionParams(store: Store): StrategyV2Params {
  const champions = getV2Champions(store);
  return {
    TREND_FOLLOWING_V2: familyParams("TREND_FOLLOWING_V2", champions.TREND_FOLLOWING_V2.params),
    BREAKOUT_V2: familyParams("BREAKOUT_V2", champions.BREAKOUT_V2.params),
    MEAN_REVERSION_V2: familyParams("MEAN_REVERSION_V2", champions.MEAN_REVERSION_V2.params),
  };
}

export function getV2ChampionVersions(store: Store): Record<StrategyV2Id, number> {
  const champions = getV2Champions(store);
  return {
    TREND_FOLLOWING_V2: champions.TREND_FOLLOWING_V2.version,
    BREAKOUT_V2: champions.BREAKOUT_V2.version,
    MEAN_REVERSION_V2: champions.MEAN_REVERSION_V2.version,
  };
}

export function createV2Challenger(store: Store, input: {
  strategy: StrategyV2Id; parentVersion: number; params: unknown; changedParameter: string;
  oldValue: number; newValue: number; hypothesis: string; evidence: unknown;
}): number {
  const params = familyParams(input.strategy, input.params);
  const active = store.db.prepare(`SELECT version FROM strategy_v2_versions WHERE strategy=?
    AND status IN ('CHALLENGER','SHADOW') LIMIT 1`).get(input.strategy);
  if (active) throw new Error(`${input.strategy} already has an active V2 Challenger`);
  const parent = store.db.prepare(`SELECT version FROM strategy_v2_versions WHERE strategy=? AND version=? AND status='CHAMPION'`)
    .get(input.strategy, input.parentVersion);
  if (!parent) throw new Error(`${input.strategy} parent version is not the current Champion`);
  const maxVersion = store.db.prepare("SELECT COALESCE(MAX(version),0) AS version FROM strategy_v2_versions WHERE strategy=?")
    .get(input.strategy) as { version: number };
  const version = maxVersion.version + 1;
  const now = new Date().toISOString();
  store.db.prepare(`INSERT INTO strategy_v2_versions
    (strategy,version,parent_version,params,status,changed_parameter,old_value,new_value,hypothesis,evidence,created_ts,updated_ts)
    VALUES(?,?,?,?, 'CHALLENGER',?,?,?,?,?,?,?)`).run(input.strategy, version, input.parentVersion,
    JSON.stringify(params), input.changedParameter, input.oldValue, input.newValue, input.hypothesis,
    JSON.stringify(input.evidence), now, now);
  return version;
}

export function transitionV2Version(store: Store, strategy: StrategyV2Id, version: number,
  status: V2VersionStatus, reason: string, evidence?: unknown): void {
  const current = store.db.prepare("SELECT status FROM strategy_v2_versions WHERE strategy=? AND version=?")
    .get(strategy, version) as { status: V2VersionStatus } | undefined;
  if (!current) throw new Error(`unknown V2 version ${strategy} v${version}`);
  const allowed: Record<V2VersionStatus, readonly V2VersionStatus[]> = {
    CHAMPION: ["SUPERSEDED"], CHALLENGER: ["SHADOW", "REJECTED"], SHADOW: ["PROMOTED", "REJECTED"],
    PROMOTED: ["CHAMPION"], REJECTED: [], SUPERSEDED: [],
  };
  if (current.status === status) return;
  if (!allowed[current.status].includes(status)) throw new Error(`invalid V2 lifecycle transition ${current.status} -> ${status}`);
  const update = store.db.prepare(`UPDATE strategy_v2_versions SET status=?,status_reason=?,evidence=COALESCE(?,evidence),updated_ts=?
    ,shadow_started_ts=CASE WHEN ?='SHADOW' THEN COALESCE(shadow_started_ts,?) ELSE shadow_started_ts END
    WHERE strategy=? AND version=? AND status=?`);
  if (status === "PROMOTED") {
    const promote = store.db.transaction(() => {
      update.run("SUPERSEDED", "replaced by validated Challenger", null, new Date().toISOString(), "SUPERSEDED", new Date().toISOString(), strategy, inputParentVersion(store, strategy, version), "CHAMPION");
      update.run("PROMOTED", reason, evidence === undefined ? null : JSON.stringify(evidence), new Date().toISOString(), "PROMOTED", new Date().toISOString(), strategy, version, current.status);
      store.db.prepare("UPDATE strategy_v2_versions SET status='CHAMPION',status_reason=?,updated_ts=? WHERE strategy=? AND version=? AND status='PROMOTED'")
        .run(reason, new Date().toISOString(), strategy, version);
    });
    promote();
    return;
  }
  const now = new Date().toISOString();
  update.run(status, reason, evidence === undefined ? null : JSON.stringify(evidence), now, status, now, strategy, version, current.status);
}

function inputParentVersion(store: Store, strategy: StrategyV2Id, version: number): number {
  const row = store.db.prepare("SELECT parent_version FROM strategy_v2_versions WHERE strategy=? AND version=?")
    .get(strategy, version) as { parent_version: number | null } | undefined;
  if (row?.parent_version === null || row?.parent_version === undefined) throw new Error("V2 Challenger has no parent version");
  return row.parent_version;
}
