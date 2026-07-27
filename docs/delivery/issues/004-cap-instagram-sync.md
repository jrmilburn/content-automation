Backlog metadata — Priority: P0 · Size: L · Product area: Instagram integration · Target release: v1.0-internal · Parent capability: {{ISSUE:project-v1}} [Project] Studio Parallel Instagram content intelligence v1

## Outcome

The system imports owned Reels and repeated supported insight snapshots idempotently, exposes missing/unavailable metrics honestly, and lets users monitor and recover incremental/manual syncs.

## Context

This capability coordinates a coherent v1 delivery area and rolls up its implementation issues.

Relevant documentation:

* `docs/technical/instagram-integration.md`
* `docs/technical/analytics-and-metrics.md`
* `docs/design/screen-map.md`

## Scope

* Cursor-paginated media import and Reel classification.
* Versioned insight capability map and immutable metric snapshots.
* Manual, incremental and scheduled sync with rate-limit handling.
* Post list triage and sync history/failure recovery.

Child issues:

- [ ] {{ISSUE:sync-media}} {{TITLE:sync-media}}
- [ ] {{ISSUE:sync-insights}} {{TITLE:sync-insights}}
- [ ] {{ISSUE:sync-orchestration}} {{TITLE:sync-orchestration}}
- [ ] {{ISSUE:posts-list}} {{TITLE:posts-list}}
- [ ] {{ISSUE:sync-history}} {{TITLE:sync-history}}

## Acceptance criteria

- [ ] Every child issue is complete with its automated tests and relevant documentation updates.
- [ ] Cross-child success, missing-data/failure and server-authorisation paths behave consistently.
- [ ] User-facing work meets responsive and accessibility requirements where applicable.
- [ ] Integration/background work exposes structured diagnostics without sensitive content.
- [ ] No child exceeds v1 scope or weakens the documented evidence/data-integrity boundaries.

## Out of scope

Scraping, competitor/global media, real-time guarantees and provider-incompatible metric merging.

## Implementation notes

Child issues own implementation detail. Shared contracts, state machines, versioning, idempotency and evidence references must follow the linked documentation.

## Data and permissions

Workspace ownership is enforced server-side. Sensitive fields, retention/deletion effects and crafted-identifier negative cases are defined in child issues and remain capability acceptance gates.

## Test notes

Capability closure requires integrated child tests plus the relevant critical journey or operational proof; test-only work does not substitute for outcome acceptance.

## Dependencies

Blocked by:

* {{ISSUE:cap-instagram-connection}} [Capability] Instagram account integration
* {{ISSUE:cap-background-jobs}} [Capability] Background processing and job reliability

Blocks:

* {{ISSUE:cap-content-ingestion}} [Capability] Video upload and transcript management
* {{ISSUE:cap-analysis-review}} [Capability] Analysis review and post detail
* {{ISSUE:cap-analytics}} [Capability] Account analytics and trend calculation
* {{ISSUE:cap-recommendations}} [Capability] Recommendation experience
* {{ISSUE:cap-operations}} [Capability] Internal operations and failure recovery
