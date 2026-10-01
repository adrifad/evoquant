// M7 (§35/§48) — deterministic Champion-vs-Challenger promotion. The
// Evolution Agent never runs this; only the evaluation pipeline does, and
// its CRITERIA are fixed in config (not evolveable, §48).
import type { Store } from "../memory/db.ts";
import { logSystemEvent } from "../memory/db.ts";
import { loadStrategies, saveStrategy, setStrategyStatus, type StrategyDef } from "../strategy/library.ts";
import type { Regime } from "../market/regime.ts";
import { summarize, type PerfSummary } from "./performance.ts";
import { backtest, walkForward } from "./backtest.ts";
import type { Candle } from "../exchange/okx/types.ts";

export interface PromotionCriteria {
  minSampleEachSide: number;
  requireOutOfSample: boolean;
  requireWalkForward: boolean;
  wfMinPositiveFolds: number;
}

export const DEFAULT_CRITERIA: PromotionCriteria = {
  minSampleEachSide: 30, requireOutOfSample: true, requireWalkForward: true, wfMinPositiveFolds: 2,
};

export interface Comparison {
  champion: string; challenger: string;
  champ: PerfSummary & { wfMean?: number | undefined };
  chal: PerfSummary & { wfMean?: number | undefined };
  promoted: boolean;
  reasons: string[];
}

export function compareAndMaybePromote(
  store: Store,
  candles: Candle[], // full price history used for BOTH sides (identical window)
  timeframe: string,
  criteria: PromotionCriteria = DEFAULT_CRITERIA,
): Comparison[] {
  const strategies = loadStrategies(store);
  const results: Comparison[] = [];
  for (const champ of strategies.filter((s) => s.status === "CHAMPION")) {
    const chal = strategies.find((s) => s.name === champ.name && s.status === "CHALLENGER");
    if (!chal) continue;
    const chrono = [...candles].sort((a, b) => a.ts - b.ts);
    const btC = backtest(champ, chrono, timeframe);
    const btX = backtest(chal, chrono, timeframe);
    const wfC = criteria.requireWalkForward ? walkForward(champ, chrono, timeframe) : undefined;
    const wfX = criteria.requireWalkForward ? walkForward(chal, chrono, timeframe) : undefined;
    const champR = tradeRs(store, champ);
    const chalR = tradeRs(store, chal);
    const liveC = summarize(champR);
    const liveX = summarize(chalR);
    const reasons: string[] = [];
    const promoted = (() => {
      if (btX.trades.length < criteria.minSampleEachSide) { reasons.push(`challenger OOS trades ${btX.trades.length} < ${criteria.minSampleEachSide}`); return false; }
      if (btX.summary.expectancy_r <= btC.summary.expectancy_r) reasons.push(`OOS expectancy ${btX.summary.expectancy_r} <= champion ${btC.summary.expectancy_r}`);
      if (wfX && wfC && (wfX.mean <= wfC.mean || wfX.positiveFolds < criteria.wfMinPositiveFolds)) reasons.push(`walk-forward challenger mean ${wfX?.mean} positiveFolds ${wfX?.positiveFolds}`);
      if (reasons.length > 0) return false;
      // live (demo-forward) evidence, when available, must not contradict
      if (liveC.trades >= criteria.minSampleEachSide && liveX.trades >= criteria.minSampleEachSide && liveX.expectancy_r <= liveC.expectancy_r) {
        reasons.push(`demo-forward expectancy ${liveX.expectancy_r} <= ${liveC.expectancy_r}`);
        return false;
      }
      return true;
    })();
    if (promoted) {
      setStrategyStatus(store, champ.name, champ.version, "SUPERSEDED");
      setStrategyStatus(store, chal.name, chal.version, "CHAMPION");
      logSystemEvent(store, "PROMOTION", { challenger: `${chal.name}_V${chal.version}`, champBt: btC.summary, chalBt: btX.summary });
    } else {
      setStrategyStatus(store, chal.name, chal.version, "REJECTED");
      logSystemEvent(store, "PROMOTION_REJECTED", { challenger: `${chal.name}_V${chal.version}`, reasons });
    }
    results.push({
      champion: `${champ.name}_V${champ.version}`, challenger: `${chal.name}_V${chal.version}`,
      champ: { ...btC.summary, wfMean: wfC?.mean }, chal: { ...btX.summary, wfMean: wfX?.mean },
      promoted, reasons,
    });
  }
  void saveStrategy;
  return results;
}

function tradeRs(store: Store, s: StrategyDef): number[] {
  return (store.db.prepare("SELECT result_r r FROM trades WHERE status='CLOSED' AND strategy=? AND strategy_version=? AND result_r IS NOT NULL")
    .all(s.name, s.version) as Array<{ r: number }>).map((x) => x.r);
}
