import { test } from "node:test";
import assert from "node:assert/strict";
import { runScalpCandidateQueue, type ScalpEntryOutcome } from "../src/scalp/candidate-queue.ts";

test("Scalp queue continues after Gate DENY and opens the next candidate", async () => {
  const attempted: string[] = [];
  const result = await runScalpCandidateQueue(["BTC", "SOL", "ETH"], async (symbol): Promise<ScalpEntryOutcome> => {
    attempted.push(symbol);
    return symbol === "BTC" ? { kind: "CANDIDATE_REJECT", reason: "GATE_DENY" } : { kind: "OPENED" };
  });
  assert.deepEqual(attempted, ["BTC", "SOL"]);
  assert.deepEqual(result, { result: "OPENED", attempted: 2 });
});

test("Scalp queue continues after candidate-local sizing rejection", async () => {
  const attempted: string[] = [];
  const result = await runScalpCandidateQueue(["BTC", "SOL"], async (symbol): Promise<ScalpEntryOutcome> => {
    attempted.push(symbol);
    return symbol === "BTC" ? { kind: "CANDIDATE_REJECT", reason: "SIZING_REJECTED" } : { kind: "OPENED" };
  });
  assert.deepEqual(attempted, ["BTC", "SOL"]);
  assert.equal(result.result, "OPENED");
});

test("Scalp queue stops after global risk/provider failure", async () => {
  const attempted: string[] = [];
  const result = await runScalpCandidateQueue(["BTC", "SOL"], async (symbol): Promise<ScalpEntryOutcome> => {
    attempted.push(symbol);
    return { kind: "GLOBAL_STOP", reason: "PORTFOLIO_RISK" };
  });
  assert.deepEqual(attempted, ["BTC"]);
  assert.deepEqual(result, { result: "GLOBAL_STOP", attempted: 1, reason: "PORTFOLIO_RISK" });
});

test("Scalp queue does not make another provider call after the budget is exhausted", async () => {
  const attempted: string[] = [];
  const result = await runScalpCandidateQueue(["BTC", "SOL", "ETH"], async (symbol): Promise<ScalpEntryOutcome> => {
    attempted.push(symbol);
    return { kind: "GLOBAL_STOP", reason: "BUDGET_EXHAUSTED" };
  });
  assert.deepEqual(attempted, ["BTC"]);
  assert.deepEqual(result, { result: "GLOBAL_STOP", attempted: 1, reason: "BUDGET_EXHAUSTED" });
});

test("Scalp queue stops after one open and handles exhausted local candidates", async () => {
  const attempted: string[] = [];
  const opened = await runScalpCandidateQueue(["BTC", "SOL"], async (symbol): Promise<ScalpEntryOutcome> => {
    attempted.push(symbol); return { kind: "OPENED" };
  });
  assert.deepEqual(attempted, ["BTC"]);
  assert.equal(opened.attempted, 1);
  const exhausted = await runScalpCandidateQueue(["BTC", "SOL"], async () => ({ kind: "CANDIDATE_REJECT", reason: "LOCAL" }));
  assert.deepEqual(exhausted, { result: "EXHAUSTED", attempted: 2 });
});
