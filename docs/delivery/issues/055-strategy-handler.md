Backlog metadata — Priority: P1 · Size: L · Product area: Content strategy · Target release: v1.0-internal · Parent capability: {{ISSUE:cap-strategy}} [Capability] Automated content strategy

## Outcome

An eligible strategy request runs asynchronously against its frozen evidence, publishes one fully validated immutable strategy/current pointer and preserves failed attempts and prior generations.

## Context

This issue delivers one implementation outcome within [Capability] Automated content strategy and follows the versioned product/technical contracts.

Relevant documentation:

* `docs/technical/strategy-generation.md`
* `docs/technical/background-jobs.md`

## Scope

* Implement authorised request preview/command, idempotency signature and queued handler.
* Assemble bounded text evidence, call pinned Gemini model, validate schema/semantics/evidence refs and bounded repair.
* Persist structured StrategyGeneration and claim-level StrategyEvidence/usage/versions transactionally; activate current after validation.
* Support explicit regeneration as new evidence manifest/history and duplicate-idea context.

## Acceptance criteria

- [ ] Duplicate submit for same manifest/config returns one logical generation/provider call.
- [ ] Handler uses exactly the frozen manifest and never queries new evidence mid-retry.
- [ ] Only fully valid, evidence-resolving output publishes; failure leaves prior current strategy intact.
- [ ] One repair attempt is bounded and cannot fabricate evidence; terminal failure is recoverable/observable.
- [ ] Regeneration creates new immutable history/manifest and includes recent idea fingerprints.
- [ ] Provider/token/cost/version/latency and redacted failure metadata are recorded.
- [ ] Repeated delivery/crash/invalid-reference/insufficient-mode tests pass.

## Out of scope

Strategy UI, automatic periodic regeneration and external grounding/function calls.

## UI and content notes

There is no dedicated screen. Any surfaced state or error uses the canonical terminology and safe redacted detail defined by the parent capability.

## Implementation notes

Text-only Gemini request can use a separately evaluated pinned stable model, but record exact version. Model performs no tools/DB work.

## Data and permissions

Worker receives minimal frozen evidence from same account. Raw prompt/response is not normal log content.

## Test notes

* Mock valid/invalid/evidence-hallucination/429/safety matrix.
* Idempotent transaction/crash/current-pointer/history tests.
* Cross-account evidence and stale-manifest negative tests.

## Dependencies

Blocked by:

* {{ISSUE:strategy-retrieval}} Build deterministic strategy evidence retrieval and frozen manifests
* {{ISSUE:strategy-contract}} Define the structured strategy and recommendation prompt contract
* {{ISSUE:jobs-policy}} Implement logical job states, leases, retries and idempotent handler framework
* {{ISSUE:gemini-adapter}} Integrate paid Gemini video file and model APIs with usage controls

Blocks:

* {{ISSUE:strategy-ui}} Deliver evidence-first strategy generation and history experience
* {{ISSUE:recommendation-model}} Persist actionable recommendations, evidence and duplicate fingerprints
* {{ISSUE:operations-dashboard}} Deliver the manual-attention operations dashboard
* {{ISSUE:security-authz-abuse}} Complete negative authorisation, crafted-identifier and API-abuse controls
