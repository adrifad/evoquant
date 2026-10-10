# Risk Ceilings and LLM Role Reliability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Raise only the absolute operational risk ceilings while preserving current runtime limits, and make every role's OpenAI-compatible structured response reliable, observable, and fail-closed.

**Architecture:** `ABSOLUTE_MAX` remains the single source of server-side risk ceilings; runtime settings remain persisted independently. The LLM transport will normalize supported explicit final-content forms before strict Zod validation, while retaining failure reasons in the run ledger. UI derives ceilings and portfolio-risk warnings from API data.

**Tech Stack:** TypeScript, Zod, SQLite, Node test runner, React.

---

### Task 1: Preserve operational risk while raising hard ceilings

**Files:**
- Modify: `src/core/config.ts`, `tests/runtime-risk.test.ts`, `tests/m1-exchange.test.ts`

- [ ] **Step 1: Write failing assertions for 10%/10x ceilings and retained runtime defaults.**
- [ ] **Step 2: Set `ABSOLUTE_MAX` to leverage/risk/daily-loss/drawdown of 10 while retaining positions=5 and portfolio-risk=5.**
- [ ] **Step 3: Run `node --test --experimental-strip-types tests/runtime-risk.test.ts tests/m1-exchange.test.ts`.**

### Task 2: Make risk projection explain portfolio precedence

**Files:**
- Modify: `apps/console/src/components/RiskSettings.tsx`, `tests/workstation-api.test.ts`

- [ ] **Step 1: Add a warning test for a per-trade limit greater than the configured portfolio open-risk limit.**
- [ ] **Step 2: Render the warning from API values without modifying the portfolio gate.**
- [ ] **Step 3: Run workstation API and console type checks.**

### Task 3: Normalize explicit OpenAI-compatible final content

**Files:**
- Modify: `src/core/llm.ts`, `tests/llm-transport.test.ts`

- [ ] **Step 1: Add failing transport tests for fenced JSON, typed content arrays, explanatory JSON, reasoning-only output, and malformed arrays.**
- [ ] **Step 2: Extract only explicit `message.content`, accepting string and OpenAI-style text parts; parse balanced JSON objects and validate them with the supplied Zod schema.**
- [ ] **Step 3: Keep `reasoning_content` excluded and keep invalid/schema responses fail-closed.**
- [ ] **Step 4: Run the transport test file.**

### Task 4: Preserve role-specific failure diagnostics

**Files:**
- Modify: `src/core/llm-role-service.ts`, `tests/llm-role-service.test.ts`

- [ ] **Step 1: Add a failing test showing `EMPTY_CONTENT` and `SCHEMA_MISMATCH` remain distinguishable in `llm_runs` and role health.**
- [ ] **Step 2: Persist the safe transport failure reason when present, retaining status and retry accounting.**
- [ ] **Step 3: Verify all five role-specific endpoints, keys, models, and budgets remain isolated.**
- [ ] **Step 4: Run the role service test file.**

### Task 5: Verify and deliver

**Files:**
- Modify only intentional source/tests/docs files above.

- [ ] **Step 1: Run root typecheck and all tests.**
- [ ] **Step 2: Run console typecheck and production build.**
- [ ] **Step 3: Inspect `git diff --check` and status; commit and push the requested branch without merging.**

## Self-review

- Risk ceilings change only `ABSOLUTE_MAX`; `config/risk.yaml` continues at 2%/3%/10%/5x and portfolio ceiling remains 5%.
- No parser path uses reasoning as final output, and every accepted response passes the original role schema.
- LLM configuration resolution remains role-specific; legacy generic fallback remains Gate-only.
- No change permits an LLM to select trade side, risk, leverage, order geometry, execution, or promotion.
