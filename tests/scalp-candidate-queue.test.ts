import { test } from "node:test";
import assert from "node:assert/strict";
import { runScalpCandidateQueue, type ScalpEntryOutcome } from "../src/scalp/candidate-queue.ts";

test("Scalp queue continues after Gate DENY and opens the next candidate", async () => {
  const attempted: string[] = [];
  const result = await runScalpCandidateQueue(["BTC", "SOL", "ETH"], 3, async (symbol): Promise<ScalpEntryOutcome> => {
    attempted.push(symbol);
    return symbol === "BTC" ? { kind: "CANDIDATE_REJECT", reason: "GATE_DENY" } : { kind: "OPENED" };
  });
  assert.deepEqual(attempted, ["BTC", "SOL"]);
  assert.deepEqual(result, { result: "OPENED", attempted: 2 });
});

test("unsupported memory policy denial skips only the current Scalp candidate", async () => {
  const attempted: string[] = [];
  const result = await runScalpCandidateQueue(["BTC", "SOL"], 3, async (symbol): Promise<ScalpEntryOutcome> => {
    attempted.push(symbol);
    return symbol === "BTC"
      ? { kind: "CANDIDATE_REJECT", reason: "MEMORY_VETO_UNSUPPORTED" }
      : { kind: "OPENED" };
  });
  assert.deepEqual(attempted, ["BTC", "SOL"]);
  assert.deepEqual(result, { result: "OPENED", attempted: 2 });
});

test("Scalp queue continues after candidate-local sizing rejection", async () => {
  const attempted: string[] = [];
  const result = await runScalpCandidateQueue(["BTC", "SOL"], 3, async (symbol): Promise<ScalpEntryOutcome> => {
    attempted.push(symbol);
    return symbol === "BTC" ? { kind: "CANDIDATE_REJECT", reason: "SIZING_REJECTED" } : { kind: "OPENED" };
  });
  assert.deepEqual(attempted, ["BTC", "SOL"]);
  assert.equal(result.result, "OPENED");
});

test("Scalp queue stops after global risk/provider failure", async () => {
  const attempted: string[] = [];
  const result = await runScalpCandidateQueue(["BTC", "SOL"], 3, async (symbol): Promise<ScalpEntryOutcome> => {
    attempted.push(symbol);
    return { kind: "GLOBAL_STOP", reason: "PORTFOLIO_RISK" };
  });
  assert.deepEqual(attempted, ["BTC"]);
  assert.deepEqual(result, { result: "GLOBAL_STOP", attempted: 1, reason: "PORTFOLIO_RISK" });
});

test("Scalp queue does not make another provider call after the budget is exhausted", async () => {
  const attempted: string[] = [];
  const result = await runScalpCandidateQueue(["BTC", "SOL", "ETH"], 3, async (symbol): Promise<ScalpEntryOutcome> => {
    attempted.push(symbol);
    return { kind: "GLOBAL_STOP", reason: "BUDGET_EXHAUSTED" };
  });
  assert.deepEqual(attempted, ["BTC"]);
  assert.deepEqual(result, { result: "GLOBAL_STOP", attempted: 1, reason: "BUDGET_EXHAUSTED" });
});

test("Scalp queue stops after one open and handles exhausted local candidates", async () => {
  const attempted: string[] = [];
  const opened = await runScalpCandidateQueue(["BTC", "SOL"], 3, async (symbol): Promise<ScalpEntryOutcome> => {
    attempted.push(symbol); return { kind: "OPENED" };
  });
  assert.deepEqual(attempted, ["BTC"]);
  assert.equal(opened.attempted, 1);
  const exhausted = await runScalpCandidateQueue(["BTC", "SOL"], 3, async () => ({ kind: "CANDIDATE_REJECT", reason: "LOCAL" }));
  assert.deepEqual(exhausted, { result: "EXHAUSTED", attempted: 2 });
});

test("Scalp candidate queue caps ranked attempts at the configured maximum", async () => {
  const attempted: string[] = [];
  const result = await runScalpCandidateQueue(["A", "B", "C", "D", "E"], 3, async (symbol): Promise<ScalpEntryOutcome> => {
    attempted.push(symbol);
    return { kind: "CANDIDATE_REJECT", reason: "LOCAL" };
  });
  assert.deepEqual(attempted, ["A", "B", "C"]);
  assert.deepEqual(result, { result: "EXHAUSTED", attempted: 3 });
});

test("Scalp candidate queue stops after an open or global stop within the attempt cap", async () => {
  const openedAttempted: string[] = [];
  const opened = await runScalpCandidateQueue(["A", "B", "C", "D", "E"], 3, async (symbol): Promise<ScalpEntryOutcome> => {
    openedAttempted.push(symbol);
    return symbol === "B" ? { kind: "OPENED" } : { kind: "CANDIDATE_REJECT", reason: "LOCAL" };
  });
  assert.deepEqual(openedAttempted, ["A", "B"]);
  assert.deepEqual(opened, { result: "OPENED", attempted: 2 });

  const stoppedAttempted: string[] = [];
  const stopped = await runScalpCandidateQueue(["A", "B", "C", "D", "E"], 3, async (symbol): Promise<ScalpEntryOutcome> => {
    stoppedAttempted.push(symbol);
    return { kind: "GLOBAL_STOP", reason: "BUDGET_EXHAUSTED" };
  });
  assert.deepEqual(stoppedAttempted, ["A"]);
  assert.deepEqual(stopped, { result: "GLOBAL_STOP", attempted: 1, reason: "BUDGET_EXHAUSTED" });
});

test("Scalp candidate queue honors a one-attempt cap and attempts all candidates below the cap", async () => {
  const oneAttempted: string[] = [];
  const one = await runScalpCandidateQueue(["A", "B", "C"], 1, async (symbol): Promise<ScalpEntryOutcome> => {
    oneAttempted.push(symbol);
    return { kind: "CANDIDATE_REJECT", reason: "LOCAL" };
  });
  assert.deepEqual(oneAttempted, ["A"]);
  assert.deepEqual(one, { result: "EXHAUSTED", attempted: 1 });

  const twoAttempted: string[] = [];
  const two = await runScalpCandidateQueue(["A", "B"], 3, async (symbol): Promise<ScalpEntryOutcome> => {
    twoAttempted.push(symbol);
    return { kind: "CANDIDATE_REJECT", reason: "LOCAL" };
  });
  assert.deepEqual(twoAttempted, ["A", "B"]);
  assert.deepEqual(two, { result: "EXHAUSTED", attempted: 2 });
});
