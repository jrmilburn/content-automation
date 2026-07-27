Backlog metadata — Priority: P0 · Size: L · Product area: Video analysis · Target release: v1.0-internal · Parent capability: {{ISSUE:cap-video-analysis}} [Capability] Gemini per-video analysis

## Outcome

The worker can securely upload one validated source video to the paid Gemini project, wait for readiness, make a pinned-model request and clean up while recording safe provider/usage metadata.

## Context

This issue delivers one implementation outcome within [Capability] Gemini per-video analysis and follows the versioned product/technical contracts.

Relevant documentation:

* `docs/technical/ai-analysis-contract.md`
* `docs/technical/security-and-privacy.md`

## Scope

* Implement Gemini client adapter, exact model/config, timeouts/error/safety/finish classification and project concurrency budget.
* Stream private object to Files API, poll ACTIVE/FAILED, record provider file name/expiry and explicitly delete terminal files.
* Expose structured-response request primitive without business-schema semantics.
* Record tokens, latency, request/model metadata and dated cost estimate where returned.

## Acceptance criteria

- [ ] One adapter call accepts exactly one validated video and never account history.
- [ ] Files API upload/poll/request/delete success is idempotent across worker retry/crash using recorded provider file ID.
- [ ] 429/5xx/file failure/safety/no-candidate/timeout are classified for job policy.
- [ ] Exact stable model ID/config and returned model/usage metadata are recorded; no latest alias.
- [ ] Paid project and no voluntary logging/dataset sharing are documented/verified for staging/production.
- [ ] API key, file URI, prompt/video and raw response do not appear in logs/errors.
- [ ] Mocked adapter contract and live rights-cleared smoke pass.

## Out of scope

Analysis taxonomy/prompt, semantic validation, Batch API, function calling, context cache and public file URLs.

## UI and content notes

There is no dedicated screen. Any surfaced state or error uses the canonical terminology and safe redacted detail defined by the parent capability.

## Implementation notes

Hide current Interactions/SDK details behind adapter. Provider file cleanup is a separate recoverable side effect.

## Data and permissions

Only selected video/required context goes to paid project; key is secret-manager only. File lifecycle follows provider and local retention policy.

## Test notes

* Full provider fake state/error matrix and retry/crash tests.
* Usage/cost metadata and redaction tests.
* Controlled staging live file lifecycle smoke.

## Dependencies

Blocked by:

* {{ISSUE:asset-validation}} Validate uploaded video assets in an isolated worker
* {{ISSUE:jobs-policy}} Implement logical job states, leases, retries and idempotent handler framework
* {{ISSUE:foundation-observability}} Add structured logging, correlation and error-monitoring foundations

Blocks:

* {{ISSUE:analysis-handler}} Process and transactionally publish one validated post analysis
* {{ISSUE:analysis-evaluation}} Create Gemini analysis fixtures, mocks and model acceptance evaluation
* {{ISSUE:strategy-handler}} Generate, validate and preserve immutable strategy history
* {{ISSUE:operations-health}} Expose integration, storage and Gemini usage/cost health signals
* {{ISSUE:security-secrets}} Harden secrets, credential encryption and logging redaction
