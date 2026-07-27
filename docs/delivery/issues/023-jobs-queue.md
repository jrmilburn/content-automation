Backlog metadata — Priority: P0 · Size: L · Product area: Internal operations · Target release: v1.0-internal · Parent capability: {{ISSUE:cap-background-jobs}} [Capability] Background processing and job reliability

## Outcome

Web commands and schedulers can durably enqueue typed work that survives process failure and is consumed by a separately deployable worker without lost or duplicate logical jobs.

## Context

This issue delivers one implementation outcome within [Capability] Background processing and job reliability and follows the versioned product/technical contracts.

Relevant documentation:

* `docs/technical/background-jobs.md`
* `docs/technical/architecture.md`

## Scope

* Integrate a pinned stable pg-boss version and migration/startup lifecycle.
* Define typed handler registry, queue names/versions and domain job/outbox dispatch pattern.
* Implement worker leasing, graceful shutdown and deploy compatibility checks.
* Provide fake/in-process test driver without changing handler contracts.

## Acceptance criteria

- [ ] Domain transaction plus outbox cannot leave committed work permanently undispatched.
- [ ] Repeated dispatch of one domain job produces one queue delivery/singleton outcome.
- [ ] Worker leases only supported handler versions and stops safely during deployment.
- [ ] Expired/failed dispatch is found by reconciliation hook.
- [ ] Web process never executes long handlers.
- [ ] Queue/database errors are structured, correlated and secret-safe.
- [ ] Concurrent integration tests prove deduplication and recovery.

## Out of scope

Business handlers, UI job detail and Redis/Kafka/multi-region orchestration.

## UI and content notes

There is no dedicated screen. Any surfaced state or error uses the canonical terminology and safe redacted detail defined by the parent capability.

## Implementation notes

Domain state is user-visible truth; queue rows are delivery mechanics. Keep queue behind a small adapter.

## Data and permissions

Payloads contain internal opaque IDs and safe version metadata only, not tokens/content/signed URLs.

## Test notes

* Real-PostgreSQL transaction/outbox/dedup tests.
* Worker lease/shutdown/unsupported-version tests.
* Crash between commit and dispatch test.

## Dependencies

Blocked by:

* {{ISSUE:foundation-database}} Establish PostgreSQL, Prisma and workspace ownership foundation
* {{ISSUE:foundation-observability}} Add structured logging, correlation and error-monitoring foundations

Blocks:

* {{ISSUE:jobs-policy}} Implement logical job states, leases, retries and idempotent handler framework
* {{ISSUE:deployment-pipeline}} Provision staging/production and implement the safe deployment pipeline
