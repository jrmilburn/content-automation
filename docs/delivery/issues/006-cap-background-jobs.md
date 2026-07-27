Backlog metadata — Priority: P0 · Size: L · Product area: Internal operations · Target release: v1.0-internal · Parent capability: {{ISSUE:project-v1}} [Project] Studio Parallel Instagram content intelligence v1

## Outcome

Long-running provider, media, analytics and strategy work runs through durable, observable, independently retryable jobs with bounded concurrency and idempotent recovery.

## Context

This capability coordinates a coherent v1 delivery area and rolls up its implementation issues.

Relevant documentation:

* `docs/technical/background-jobs.md`
* `docs/technical/architecture.md`

## Scope

* PostgreSQL-backed queue and transactional/outbox dispatch.
* Logical job states, leases, retry classification and idempotent handlers.
* Cancellation at safe points, manual retry and reconciliation.
* Job detail/operations visibility with redacted structured diagnostics.

Child issues:

- [ ] {{ISSUE:jobs-queue}} {{TITLE:jobs-queue}}
- [ ] {{ISSUE:jobs-policy}} {{TITLE:jobs-policy}}
- [ ] {{ISSUE:jobs-reconcile}} {{TITLE:jobs-reconcile}}
- [ ] {{ISSUE:jobs-operations-ui}} {{TITLE:jobs-operations-ui}}

## Acceptance criteria

- [ ] Every child issue is complete with its automated tests and relevant documentation updates.
- [ ] Cross-child success, missing-data/failure and server-authorisation paths behave consistently.
- [ ] User-facing work meets responsive and accessibility requirements where applicable.
- [ ] Integration/background work exposes structured diagnostics without sensitive content.
- [ ] No child exceeds v1 scope or weakens the documented evidence/data-integrity boundaries.

## Out of scope

Autonomous agents, distributed orchestration, Kafka/Kubernetes and bulk destructive operations.

## Implementation notes

Child issues own implementation detail. Shared contracts, state machines, versioning, idempotency and evidence references must follow the linked documentation.

## Data and permissions

Workspace ownership is enforced server-side. Sensitive fields, retention/deletion effects and crafted-identifier negative cases are defined in child issues and remain capability acceptance gates.

## Test notes

Capability closure requires integrated child tests plus the relevant critical journey or operational proof; test-only work does not substitute for outcome acceptance.

## Dependencies

Blocked by:

* {{ISSUE:cap-foundation}} [Capability] Product foundation and technical architecture

Blocks:

* {{ISSUE:cap-instagram-sync}} [Capability] Instagram post and metric synchronisation
* {{ISSUE:cap-content-ingestion}} [Capability] Video upload and transcript management
* {{ISSUE:cap-video-analysis}} [Capability] Gemini per-video analysis
* {{ISSUE:cap-analytics}} [Capability] Account analytics and trend calculation
* {{ISSUE:cap-strategy}} [Capability] Automated content strategy
* {{ISSUE:cap-security}} [Capability] Security, privacy and data lifecycle
