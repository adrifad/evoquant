# Role-based AI configuration

EvoQuant routes five independent LLM roles through one OpenAI-compatible
transport. This is role routing, not model voting: the roles never vote on a
trade direction. Deterministic Strategy Core V2, global risk, execution,
proposal validation, and promotion remain authoritative.

| Role | Default model | Use | Failure behavior |
|---|---|---|---|
| Gate | `deepseek-v4.1-flash` | Contextual ALLOW/DENY on a deterministic candidate | Fail closed: DENY/HOLD |
| Scalp | `qwen3.8-flash` | Lightweight scalp context/veto | Skip the entry |
| Reviewer | `glm-5.3` | Hypothesis-only review after a closed Demo trade | Defer review; do not block trading |
| Evolution | `deepseek-v4-pro:cloudflare` | Propose at most one bounded V2 parameter change | Keep Champion; no Challenger |
| Critic | `qwen3.7-plus` | Challenge an Evolution proposal before validation | No Challenger |

The Critic can be configured independently, for example with
`kimi-k2.7-code`. It may ACCEPT, REJECT, or request one revision. The configured
revision limit is 0 or 1. A revision returns to Evolution once, then Critic
reviews the revised proposal once. A Critic ACCEPT is not sufficient to create
a Challenger: the deterministic V2 validator still checks parent identity,
family-specific parameter names, old value, bounds, delta, and the one-change
limit. No role can change side, geometry, sizing, leverage, risk, exchange mode,
or promotion state.

## Configuration and precedence

Non-secret defaults live in `config/llm-roles.yaml`. Each role has its own
enabled flag, provider label, base URL, model, temperature, timeout, output
token limit, retry count, budget, and (for Critic) revision limit. Defaults
contain no credentials and the base URL is intentionally unset: configure the
actual OpenAI-compatible endpoint before enabling calls.

Role-specific environment names follow `LLM_<ROLE>_<SETTING>`, with uppercase
role names. For example:

```dotenv
LLM_GATE_PROVIDER=FreGateway
LLM_GATE_BASE_URL=https://gate.example/v1
LLM_GATE_API_KEY=server-local-secret
LLM_GATE_MODEL=deepseek-v4.1-flash
LLM_GATE_TEMPERATURE=0.10
LLM_GATE_TIMEOUT_MS=20000
LLM_GATE_MAX_OUTPUT_TOKENS=250
LLM_GATE_RETRIES=1
LLM_GATE_MAX_CALLS_PER_HOUR=30

LLM_REVIEWER_PROVIDER=OpenRouter
LLM_REVIEWER_BASE_URL=https://review.example/v1
LLM_REVIEWER_API_KEY=another-server-local-secret
LLM_REVIEWER_MODEL=glm-5.3
```

The same setting names are available for `SCALP`, `REVIEWER`, `EVOLUTION`, and
`CRITIC`. Budget names are `MAX_CALLS_PER_HOUR` and `MAX_CALLS_PER_DAY`;
Critic additionally accepts `MAX_REVISION_ROUNDS` (0 or 1). The AI page
can configure every role independently. Saved role settings are persisted in
server-local `.env` with mode `0600` and hot-reloaded for the next request.
Existing open trades are not closed and Strategy Core is not restarted.

Resolution is per role:

1. Hot-reloaded runtime setting.
2. Role-specific process environment, then server-local `.env` setting. A
   deliberately blank role value saved by the dashboard is a clear marker and
   overrides a stale process value after restart.
3. That role's YAML default.
4. Legacy generic `LLM_*` setting for Gate only.

Generic `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL`, `LLM_TEMPERATURE`, and
related legacy fields remain a migration path for Gate. They are deliberately
not copied to Reviewer, Evolution, Scalp, or Critic: reusing a generic key for
all roles would defeat credential isolation. Existing single-provider
deployments should move their desired values to `LLM_GATE_*`, then configure
the other roles separately. A blank API-key field on Save keeps the existing
key; clearing it requires the explicit Clear API Key action and confirmation.

## Secrets, health, and budgets

Never commit `.env`, API keys, or credentials in YAML. Settings responses
return only `apiKeyConfigured` and a masked suffix; they never return the full
key. LLM events and the `llm_runs` ledger store role, provider, model, status,
latency, provider-reported token counts when available, safe error class, and a
short context reference. They do not store credentials, request bodies, full
prompts, or raw provider errors. The connection test uses only the selected
role's draft URL/key/model and returns sanitized status/latency.

Default internal request budgets are Gate 30/hour, Scalp 12/hour, Reviewer
10/hour, Evolution 8/day, and Critic 8/day. Each actual provider HTTP attempt,
including retries, reserves one budget unit transactionally before dispatch.
Concurrent calls cannot reserve the same remaining unit. Logical calls are
reported separately from provider requests and retries. Exhaustion is fail-safe: Gate denies, Scalp skips, Reviewer
defers, Evolution proposes nothing, and Critic permits no Challenger. Budgets
are operational safeguards, not provider billing estimates. Retries are
bounded to the configured 0–3 retries and use short bounded backoff.

The dispatch ledger survives restart and includes requests interrupted before
a logical run completed. Older logical runs without request accounting retain
conservative budget charges, displayed separately from actual provider requests.
Token totals are unavailable when usage is missing, retry usage is incomplete,
or dispatched requests lack completed accounting; missing tokens are never zero.

The dashboard reports each role's enabled/configured state, provider/model,
base URL hostname, status, recent success/failure/latency, logical calls,
provider requests, retries, token availability and budget consumption.
It does not display the key. Role settings endpoints are additive and do not
change existing trading or risk APIs.

## Role contracts

- Gate receives a compact deterministic candidate and returns only ALLOW or
  DENY. Timeout, malformed output, auth failure, missing configuration, or
  budget exhaustion all deny.
- Scalp is a contextual veto. Missing or failed role output cannot authorize a
  trade.
- Reviewer is non-blocking and hypothesis-only. Its natural-language findings
  remain provisional; it cannot mutate parameters or verify lessons.
- Evolution receives aggregated, strategy/version/engine-scoped evidence and
  may propose one existing family parameter. It cannot directly create a
  Champion or execute orders.
- Critic challenges sample sufficiency, causal claims, symbol/regime/side
  consistency, after-cost results, drawdown, and MFE/MAE. Failure or REJECT
  discards the proposal; ACCEPT still goes through deterministic validation.

The role transport is intentionally generic and OpenAI-compatible. Providers
with a genuinely different wire protocol will need an explicit adapter; no
provider-specific protocol is inferred from the provider label. No real
provider credentials, network trading, statistical significance, or
profitability are implied by unit tests.
