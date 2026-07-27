Backlog metadata — Priority: P1 · Size: L · Product area: Internal operations · Target release: v1.0-internal · Parent capability: {{ISSUE:project-v1}} [Project] Studio Parallel Instagram content intelligence v1

## Outcome

Internal operators can find integration, sync, upload, job, analysis, schema and strategy problems, inspect redacted diagnostics and take the safe recovery action without database intervention.

## Context

This capability coordinates a coherent v1 delivery area and rolls up its implementation issues.

Relevant documentation:

* `docs/design/screen-map.md`
* `docs/technical/background-jobs.md`
* `docs/technical/deployment-and-operations.md`

## Scope

* Operations dashboard and manual-attention queues.
* Safe runtime/version/retention settings visibility.
* Integration, storage and AI cost/usage health signals.
* Operational recovery runbooks and audited actions.

Child issues:

- [ ] {{ISSUE:operations-dashboard}} {{TITLE:operations-dashboard}}
- [ ] {{ISSUE:operations-settings}} {{TITLE:operations-settings}}
- [ ] {{ISSUE:operations-health}} {{TITLE:operations-health}}
- [ ] {{ISSUE:operations-runbooks}} {{TITLE:operations-runbooks}}

## Acceptance criteria

- [ ] Every child issue is complete with its automated tests and relevant documentation updates.
- [ ] Cross-child success, missing-data/failure and server-authorisation paths behave consistently.
- [ ] User-facing work meets responsive and accessibility requirements where applicable.
- [ ] Integration/background work exposes structured diagnostics without sensitive content.
- [ ] No child exceeds v1 scope or weakens the documented evidence/data-integrity boundaries.

## Out of scope

General-purpose admin console, secret display and arbitrary database/job manipulation.

## Implementation notes

Child issues own implementation detail. Shared contracts, state machines, versioning, idempotency and evidence references must follow the linked documentation.

## Data and permissions

Workspace ownership is enforced server-side. Sensitive fields, retention/deletion effects and crafted-identifier negative cases are defined in child issues and remain capability acceptance gates.

## Test notes

Capability closure requires integrated child tests plus the relevant critical journey or operational proof; test-only work does not substitute for outcome acceptance.

## Dependencies

Blocked by:

* {{ISSUE:cap-instagram-sync}} [Capability] Instagram post and metric synchronisation
* {{ISSUE:cap-content-ingestion}} [Capability] Video upload and transcript management
* {{ISSUE:cap-video-analysis}} [Capability] Gemini per-video analysis
* {{ISSUE:cap-strategy}} [Capability] Automated content strategy

Blocks:

* {{ISSUE:cap-launch}} [Capability] Testing, deployment and launch readiness
