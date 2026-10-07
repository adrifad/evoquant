import type { StrategyV2Id } from "./core-v2.ts";

export type StrategyFamily = "TREND_FOLLOWING" | "BREAKOUT" | "MEAN_REVERSION";
export type StrategyCoreVersion = 1 | 2;

export interface StrategyIdentity {
  family: StrategyFamily | "SCALP";
  coreVersion: StrategyCoreVersion;
  strategyVersion: number;
}

const V2_FAMILY: Record<StrategyV2Id, StrategyFamily> = {
  TREND_FOLLOWING_V2: "TREND_FOLLOWING",
  BREAKOUT_V2: "BREAKOUT",
  MEAN_REVERSION_V2: "MEAN_REVERSION",
};

export function identityForV2(strategy: StrategyV2Id, strategyVersion: number): StrategyIdentity {
  return { family: V2_FAMILY[strategy], coreVersion: 2, strategyVersion };
}

export function familyForV2(strategy: StrategyV2Id): StrategyFamily {
  return V2_FAMILY[strategy];
}

export function v2StrategyForFamily(family: StrategyFamily): StrategyV2Id {
  switch (family) {
    case "TREND_FOLLOWING": return "TREND_FOLLOWING_V2";
    case "BREAKOUT": return "BREAKOUT_V2";
    case "MEAN_REVERSION": return "MEAN_REVERSION_V2";
  }
}

export function legacyIdentity(family: StrategyFamily | "SCALP", strategyVersion: number): StrategyIdentity {
  return { family, coreVersion: 1, strategyVersion };
}
