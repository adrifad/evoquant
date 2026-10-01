// M2 (§42) — 15m candle-close scheduler. Tick fires a few seconds AFTER the
// boundary so OKX has confirmed the candle. Pure helpers for testability.
import type { Candle } from "../exchange/okx/types.ts";

export function msForBar(bar: string): number {
  const m = bar.match(/^(\d+)(m|h|d)$/);
  if (!m) throw new Error(`bad bar ${bar}`);
  const n = Number(m[1]);
  return n * (m[2] === "m" ? 60_000 : m[2] === "h" ? 3_600_000 : 86_400_000);
}

export function nextBoundaryMs(nowMs: number, barMs: number, offsetMs = 8_000): number {
  const k = Math.floor(nowMs / barMs) + 1;
  return k * barMs + offsetMs;
}

// the newest candle whose confirm==="1" (§7.3 — closed only)
export function newestClosed(candles: Candle[]): Candle | undefined {
  return candles.filter((c) => c.confirm === "1").sort((a, b) => b.ts - a.ts)[0];
}

export class CandleCloseScheduler {
  private timer: NodeJS.Timeout | undefined;
  private lastBarTs = 0;
  private arm: (() => void) | undefined;
  private readonly barMs: number;
  private readonly onTick: (expectedBarTs: number) => Promise<void>;
  constructor(barMs: number, onTick: (expectedBarTs: number) => Promise<void>) {
    this.barMs = barMs;
    this.onTick = onTick;
  }

  start(): void {
    const arm = (): void => {
      const due = nextBoundaryMs(Date.now(), this.barMs);
      this.timer = setTimeout(() => {
        void this.fireAndArm(due);
      }, Math.max(1_000, due - Date.now()));
    };
    // fire once shortly after start so the bot refreshes warm-up immediately
    this.fireAndArm(Math.floor(Date.now() / this.barMs) * this.barMs - 1).then(arm, arm);
    this.arm = arm;
  }


  private async fireAndArm(boundary: number): Promise<void> {
    const barTs = boundary - 8_000 - this.barMs; // candle that just closed
    if (barTs > this.lastBarTs) {
      this.lastBarTs = barTs;
      try { await this.onTick(barTs); } catch { /* logged upstream */ }
    }
    this.arm?.();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
  }
}
