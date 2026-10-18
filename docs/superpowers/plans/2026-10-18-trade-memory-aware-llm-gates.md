# Trade Memory-Aware LLM Decision Gates Implementation Plan

> **For agentic workers:** This plan is being executed inline in the current session, per the user's request for autonomous implementation.

**Goal:** Add bounded, read-only, correctly scoped 30-day trade statistics and verified lesson context to the existing Swing and Scalp veto calls behind a default-off runtime flag.

**Architecture:** A typed memory builder queries existing eligible trade and lesson evidence without writes. Gate adapters build one compact payload per existing call, derive a digest from the final serialized context, and validate memory citations against the supplied IDs. A per-invocation repository environment read controls the feature, so malformed or disabled configuration preserves legacy requests.

**Tech Stack:** TypeScript, Zod, SQLite SELECT queries, Node test runner, existing `loadRepoEnv()` and `RoleLlmService`.

---

### Task 1: Add deterministic read-only decision memory builder

**Files:** Create `src/memory/decision-context.ts`; test `tests/decision-context.test.ts`.

- [ ] Add scope and context types, 30-day NET-eligible S1/S2 statistics, semantic JSON regime-axis matching, qualifying scoped VERIFIED/REINFORCED lesson selection, deterministic ordering, a compact serializer capped at 2,400 characters, and SHA-256 context reference helper.
- [ ] Test eligibility boundaries, engine/strategy/version/side/regime isolation, lesson evidence thresholds and scopes, ordering, truncation, fingerprint determinism, and no writes.

### Task 2: Wire the Swing gate with a dynamic memory kill-switch

**Files:** Modify `src/agents/decision-agent.ts`, `src/core/main.ts`, `src/execution/executor.ts`; modify `prompts/candidate-gate.md`; modify `.env.example`; test gate integration.

- [ ] Resolve persisted strategy family with `identityForV2()`, pass categorical regime separately from regime axes, query memory only when `GATE_MEMORY_ENABLED=true`, and preserve the exact legacy request when disabled or retrieval fails.
- [ ] Extend the strict output schema with optional `cited_memory`, validate citations against supplied IDs, carry context reference/citations to existing decision and gate audit events, and use the actual context reference for failure telemetry.
- [ ] Add prompt policy for weak, exploratory, and stronger samples without changing deterministic authority.

### Task 3: Wire the Scalp gate without changing supervisor behavior

**Files:** Modify `src/agents/scalp-agent.ts`, `src/scalp/runner.ts`; test Scalp gate integration.

- [ ] Build a SCALP_5M / SCALP / core-1 / version-1 scope from the actual signal, pass the Store, attach memory only when enabled, and keep `fetchStance()` untouched.
- [ ] Preserve the legacy Scalp context reference when memory is disabled, return the actual context reference and validated citations, and use that reference for bounded failure telemetry and candidate-attempt diagnostics.

### Task 4: Verify compatibility and safety boundaries

**Files:** Review all changed files and existing gate/role tests.

- [ ] Confirm disabled payload/prompt and call counts are unchanged, no additional LLM calls or database writes exist, and no strategy, risk, execution, reviewer, or evolution code changed.
- [ ] Run root typecheck/tests and console typecheck/build; inspect `git diff --check`, repository status, and staged paths before commit.
- [ ] Commit and push the feature branch; do not deploy or enable the flag by default.
