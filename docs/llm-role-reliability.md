# LLM role reliability

Each role has its own endpoint, credential, model, timeout, retry limit, budget, and provider compatibility settings. The only legacy generic configuration path remains Gate-only for migration compatibility.

`Test connection` verifies a transport acknowledgement. `Validate role` uses the production Zod response schema but writes no decision, trade review, lesson, proposal, Challenger, or promotion record. The Scalp validation runs both `scalp_stance` and `scalp_candidate_gate`.

The transport always requires JSON validated by the production schema. A role can explicitly disable `response_format`, omit `temperature`, or use `max_completion_tokens`; this changes only the request body. It never relaxes JSON extraction or Zod validation. The configured timeout is the total logical-call deadline, covering every request, Retry-After delay, and backoff.

## Gate and Scalp budget analysis

Swing Gate runs only after a deterministic candidate reaches `candidate_gate`; it is never called for every scanned symbol. With a 15-minute Swing loop and at most 15 entry symbols, the theoretical all-symbol upper bound is 60 candidate calls per hour, while the configured 30 requests/hour budget deliberately caps abnormal candidate bursts. No local runtime ledger was available during this hardening pass to justify a budget increase.

Scalp refreshes `scalp_stance` every configured 15 minutes, which is four calls/hour. Its shared 12 requests/hour budget therefore reserves up to eight candidate-gate calls/hour. Candidate gates occur only after a deterministic signal and stance policy pass. The diagnostics endpoint exposes separate `scalp_stance` and `scalp_candidate_gate` context counts so an operator can decide, from actual usage, whether the limit is too tight.

Provider request counts mean logical calls from `RoleLlmService` to the configured transport. They do not claim to include opaque transport retries inside a provider SDK.
