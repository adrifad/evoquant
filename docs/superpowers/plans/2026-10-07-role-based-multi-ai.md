# Role-Based Multi-AI Implementation Plan

> **For agentic workers:** Execute inline in this session, task by task. Steps use checkbox syntax for tracking.

**Goal:** Route Gate, Scalp, Reviewer, Evolution, and Critic through isolated provider configurations, safe budgets, structured telemetry, and deterministic validation.

**Architecture:** A central role resolver loads non-secret YAML defaults, role-scoped environment settings, runtime overrides, and Gate-only legacy generic settings. A single OpenAI-compatible transport runs bounded requests; agents receive only the role service, while risk, setup, proposal validation, and promotion remain deterministic. Dashboard writes affect one role and reload without restarting the trading process.

**Tech Stack:** TypeScript strict mode, Zod, YAML, better-sqlite3, Node HTTP, React/Vite.

---

### Task 1: Role schemas and resolver

**Files:** Create `config/llm-roles.yaml`, `src/core/llm-roles.ts`, `tests/llm-roles.test.ts`; modify `src/core/env.ts` only if needed.

- [x] Add role defaults for the five requested model IDs, timeouts, token limits, retries, budgets, and Critic revision cap. Keep API keys out of YAML.
- [x] Implement `getLlmConfigForRole(role)` with strict per-role validation, runtime override > role environment > YAML > Gate-only legacy generic fallback, and role-local unavailable state.
- [x] Test default mapping, independent URLs/keys/models, role isolation, malformed one-role config, and generic legacy fallback.

```ts
type LlmRole = "gate" | "scalp" | "reviewer" | "evolution" | "critic";
function getLlmConfigForRole(role: LlmRole): RoleConfigResult;
```

Run `npm test -- --test-name-pattern="role resolver"`; expect each resolver case to pass without provider credentials.

### Task 2: Transport, budgets, health, and safe audit

**Files:** Modify `src/core/llm.ts` and `src/memory/db.ts`; create `src/core/llm-role-service.ts` and `tests/llm-role-service.test.ts`.

- [x] Add an idempotent `llm_runs` migration containing only role, provider, model, status, latency, token counts, error class, context reference, and timestamp.
- [x] Implement bounded retries, timeout classification, response token capture, per-role hourly/daily budget checks, role health, and sanitized `LLM_*` system events.
- [x] Ensure transport logs and persisted telemetry never contain request bodies, API keys, Authorization headers, raw provider errors, or full prompts.
- [x] Test fake-provider routing, retry/timeout behavior, budgets, telemetry redaction, and migration idempotency.

```ts
interface LlmRoleService {
  json<T>(role: LlmRole, system: string, user: string, schema: z.ZodType<T>, contextRef: string): Promise<T | null>;
}
```

Run `npm test -- --test-name-pattern="role service|llm runs"`; expect mocked requests and isolated role ledgers.

### Task 3: Agent routing and Critic lifecycle

**Files:** Modify `src/agents/decision-agent.ts`, `scalp-agent.ts`, `reviewer-agent.ts`, `v2-evolution.ts`, and `src/core/main.ts`; create `src/agents/critic-agent.ts`, `prompts/critic-v2.md`, and `tests/critic-agent.test.ts`.

- [x] Route candidate gating to Gate, Scalp stance/filter to Scalp, closed-trade review to Reviewer, and V2 proposals to Evolution through the role service.
- [x] Keep reviewer dispatch non-blocking and leave failed reviews pending.
- [x] Add strict Critic ACCEPT/REJECT/REVISE output; allow at most one Evolution revision, then run the existing deterministic V2 validator before creating a Challenger.
- [x] Record safe role/model/verdict/revision metadata; Critic failure, rejection, repeated revision, or invalid deterministic proposal creates no Challenger.
- [x] Test ACCEPT, REJECT, one REVISE then ACCEPT, invalid proposal despite ACCEPT, and fail-closed behavior without network access.

```ts
const critique = await roles.json("critic", prompt, proposalContext, CriticSchema, "v2_proposal");
if (critique?.verdict === "ACCEPT") validateV2ProposalBeforeCreate();
```

Run `npm test -- --test-name-pattern="critic|V2 proposal"`; expect only deterministic validator-approved challengers.

### Task 4: Settings API and compact role controls

**Files:** Modify `src/core/dashboard.ts`, `src/core/settings.ts`, `apps/console/src/pages/SettingsPage.tsx`, and `apps/console/src/styles.css`; update `tests/dashboard.test.ts` and add role-settings API tests.

- [x] Add GET role settings/health, role-scoped update, explicit confirmed key clear, and role-scoped test-connection endpoints.
- [x] Return `apiKeyConfigured` plus a masked suffix only; blank API-key updates preserve the saved key. Persist role settings server-side with restrictive file permissions and apply in-memory overrides for the next AI call.
- [x] Add five compact forms with enabled/provider/base URL/key/model/temperature/timeout/token/retry/budget fields, Critic revision cap, health, test connection, save, and confirmed clear.
- [x] Keep risk/exchange settings read-only. Provide loading, empty, error, success, keyboard, and responsive states.
- [x] Test that each endpoint changes or tests only its requested role and no response or event includes the full key.

```ts
PUT /api/settings/llm-roles/:role
POST /api/settings/llm-roles/:role/test
DELETE /api/settings/llm-roles/:role/api-key?confirm=yes
```

Run `npm test -- --test-name-pattern="dashboard role settings"` and `npm --prefix apps/console run typecheck`.

### Task 5: Documentation, verification, and delivery

**Files:** Update `README.md` and create/update `docs/ROLE_BASED_AI.md`.

- [x] Document role defaults, resolution order, environment names, legacy fallback, hot reload, key handling, budgets, health, failure policies, and Critic lifecycle.
- [x] Review `git diff`, secret-shaped strings, risk/execution files, tests, and staged paths. Keep unrelated existing worktree changes unstaged.
- [x] Run root typecheck/tests and console typecheck/build; fix introduced failures.
- [x] Commit only implementation/documentation files and push `feat/role-based-multi-ai` with upstream tracking.

Run `npm run typecheck`, `npm test`, `npm --prefix apps/console run typecheck`, and `npm --prefix apps/console run build`; expect all to pass before push.
