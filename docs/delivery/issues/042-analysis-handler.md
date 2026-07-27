Backlog metadata — Priority: P0 · Size: L · Product area: Video analysis · Target release: v1.0-internal · Parent capability: {{ISSUE:cap-video-analysis}} [Capability] Gemini per-video analysis

## Outcome

Submitting an eligible post creates one idempotent analysis job whose worker validates Gemini output and atomically stores/activates one immutable analysis or a clear retry/manual-attention failure.

## Context

This issue delivers one implementation outcome within [Capability] Gemini per-video analysis and follows the versioned product/technical contracts.

Relevant documentation:

* `docs/technical/ai-analysis-contract.md`
* `docs/technical/background-jobs.md`
* `docs/technical/data-model.md`

## Scope

* Add AnalysisJob/PostAnalysis/current pointer schema and request-signature idempotency.
* Implement command eligibility and handler stages: load fixed inputs, file, request, Zod/semantic validate, bounded repair, commit, cleanup.
* Persist structured result/searchable features, provenance, validation warnings, model/usage metadata.
* Enqueue account analytics dirty/recalculation after successful activation.

## Acceptance criteria

- [ ] Duplicate submits for identical signature return existing active/succeeded job and do not call Gemini twice.
- [ ] Job captures exact post/asset/transcript/schema/prompt/model/config IDs/hashes.
- [ ] Only fully syntax- and semantic-valid output commits and becomes current in one transaction.
- [ ] One bounded repair follows documented policy; exhaustion publishes no partial analysis.
- [ ] Crash/retry at each provider/commit boundary yields at most one matching analysis and cleans/reuses provider file.
- [ ] Previous current analysis remains on failure; success marks analytics dirty once.
- [ ] Stages, usage and redacted failure are observable; automated handler/negative tests pass.

## Out of scope

Post result UI, account strategy and bulk reanalysis.

## UI and content notes

There is no dedicated screen. Any surfaced state or error uses the canonical terminology and safe redacted detail defined by the parent capability.

## Implementation notes

Model never writes DB/files/queue. Use unique request signature and result check before external call.

## Data and permissions

Worker service reads same-workspace fixed input IDs; structured result is internal derived content. Raw provider output is restricted/short-retention only if approved.

## Test notes

* Mock Gemini valid/schema-invalid/semantic-invalid/safety/429 matrix.
* Repeated delivery/concurrent submit/crash-boundary DB tests.
* Cross-post input and stale/deleted asset negative tests.

## Dependencies

Blocked by:

* {{ISSUE:gemini-adapter}} Integrate paid Gemini video file and model APIs with usage controls
* {{ISSUE:analysis-contract}} Define and evaluate the v1 analysis schema, taxonomy and prompt
* {{ISSUE:source-editor}} Deliver source video association and transcript/context editor
* {{ISSUE:jobs-policy}} Implement logical job states, leases, retries and idempotent handler framework

Blocks:

* {{ISSUE:analysis-reanalysis}} Support analysis version activation and safe reanalysis
* {{ISSUE:analysis-result-ui}} Present structured creative analysis with confidence and estimation labels
* {{ISSUE:analytics-feature-stats}} Calculate feature statistics, confidence and outlier sensitivity
* {{ISSUE:strategy-retrieval}} Build deterministic strategy evidence retrieval and frozen manifests
* {{ISSUE:security-authz-abuse}} Complete negative authorisation, crafted-identifier and API-abuse controls
