Backlog metadata — Priority: P0 · Size: L · Product area: Internal operations · Target release: v1.0-internal · Parent capability: {{ISSUE:cap-background-jobs}} [Capability] Background processing and job reliability

## Outcome

All asynchronous handlers share testable state transitions, heartbeat/lease recovery, provider-aware bounded retries and a one-result idempotency pattern.

## Context

This issue delivers one implementation outcome within [Capability] Background processing and job reliability and follows the versioned product/technical contracts.

Relevant documentation:

* `docs/technical/background-jobs.md`
* `docs/technical/data-model.md`

## Scope

* Add logical job/attempt records and queued/processing/retry/succeeded/failed-attention/cancelled transitions.
* Implement heartbeat, optimistic claims, retry classifier/backoff with jitter and error taxonomy.
* Provide handler wrapper that checks terminal result, records stages and commits result/state transactionally.
* Expose per-provider/global concurrency semaphore hooks.

## Acceptance criteria

- [ ] Invalid transitions and concurrent double claims are rejected.
- [ ] Transient, rate-limit, credential, invalid-input and semantic-output classes follow documented retry/terminal rules.
- [ ] Retry timing honours provider hints and is bounded; no infinite paid calls.
- [ ] Repeated delivery after result commit returns success without a duplicate result.
- [ ] Lease expiry makes abandoned work recoverable without stealing healthy work.
- [ ] Errors and attempts are correlated/redacted and include safe next-action metadata.
- [ ] State/retry/idempotency tests use fake time and crash injection.

## Out of scope

Specific Meta/Gemini handlers and user-facing operations screens.

## UI and content notes

There is no dedicated screen. Any surfaced state or error uses the canonical terminology and safe redacted detail defined by the parent capability.

## Implementation notes

Keep provider error mapping in adapters but centralise policy. Separate logical job from physical queue attempt.

## Data and permissions

Job records store resource IDs/version hashes and safe errors; sensitive inputs remain in owned domain tables/object storage.

## Test notes

* State-machine property/unit tests.
* Concurrent claim and repeated-delivery integration tests.
* Backoff/provider-hint/lease-expiry/crash-boundary tests.

## Dependencies

Blocked by:

* {{ISSUE:jobs-queue}} Implement the PostgreSQL-backed queue and transactional dispatch

Blocks:

* {{ISSUE:jobs-reconcile}} Add cancellation, manual retry and background reconciliation
* {{ISSUE:jobs-operations-ui}} Provide job list and diagnostic detail experience
* {{ISSUE:instagram-token-health}} Implement Instagram token health, refresh and reconnect handling
* {{ISSUE:upload-storage}} Implement private object storage and signed multipart video upload
* {{ISSUE:asset-validation}} Validate uploaded video assets in an isolated worker
* {{ISSUE:sync-media}} Import Instagram media with pagination and Reel classification
* {{ISSUE:gemini-adapter}} Integrate paid Gemini video file and model APIs with usage controls
* {{ISSUE:analysis-handler}} Process and transactionally publish one validated post analysis
* {{ISSUE:analytics-recalculation}} Publish versioned account analytics through a debounced recalculation job
* {{ISSUE:strategy-handler}} Generate, validate and preserve immutable strategy history
