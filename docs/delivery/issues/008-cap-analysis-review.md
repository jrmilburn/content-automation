Backlog metadata — Priority: P1 · Size: L · Product area: Video analysis · Target release: v1.0-internal · Parent capability: {{ISSUE:project-v1}} [Project] Studio Parallel Instagram content intelligence v1

## Outcome

A user can inspect one post's imported metrics, source context, processing state, structured analysis, confidence/estimation labels, versions and safe reanalysis/failure actions.

## Context

This capability coordinates a coherent v1 delivery area and rolls up its implementation issues.

Relevant documentation:

* `docs/design/screen-map.md`
* `docs/technical/ai-analysis-contract.md`
* `docs/product/user-journeys.md`

## Scope

* Unified post detail with comparable metrics/source/job status.
* Accessible structured creative-analysis presentation.
* Analysis history, stale/version states, reanalysis and failure recovery.

Child issues:

- [ ] {{ISSUE:post-detail}} {{TITLE:post-detail}}
- [ ] {{ISSUE:analysis-result-ui}} {{TITLE:analysis-result-ui}}
- [ ] {{ISSUE:analysis-history-ui}} {{TITLE:analysis-history-ui}}

## Acceptance criteria

- [ ] Every child issue is complete with its automated tests and relevant documentation updates.
- [ ] Cross-child success, missing-data/failure and server-authorisation paths behave consistently.
- [ ] User-facing work meets responsive and accessibility requirements where applicable.
- [ ] Integration/background work exposes structured diagnostics without sensitive content.
- [ ] No child exceeds v1 scope or weakens the documented evidence/data-integrity boundaries.

## Out of scope

Manual editing of model output as fact, public sharing and automatic publishing.

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

Blocks:

* {{ISSUE:cap-launch}} [Capability] Testing, deployment and launch readiness
