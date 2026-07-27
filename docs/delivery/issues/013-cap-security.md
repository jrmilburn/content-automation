Backlog metadata — Priority: P0 · Size: L · Product area: Security and privacy · Target release: v1.0-internal · Parent capability: {{ISSUE:project-v1}} [Project] Studio Parallel Instagram content intelligence v1

## Outcome

The internal product enforces least privilege, encrypted secrets, private content, abuse resistance, dependency hygiene and verified retention/deletion across application, provider, object and backup boundaries.

## Context

This capability coordinates a coherent v1 delivery area and rolls up its implementation issues.

Relevant documentation:

* `docs/technical/security-and-privacy.md`
* `docs/technical/video-ingestion.md`
* `docs/technical/deployment-and-operations.md`

## Scope

* Secret/credential/logging hardening.
* Negative authorisation, rate-limit and crafted-identifier protection.
* Retention, deletion, provider cleanup and backup tombstone flow.
* Supply-chain/container controls and launch security review.

Child issues:

- [ ] {{ISSUE:security-secrets}} {{TITLE:security-secrets}}
- [ ] {{ISSUE:security-authz-abuse}} {{TITLE:security-authz-abuse}}
- [ ] {{ISSUE:security-deletion}} {{TITLE:security-deletion}}
- [ ] {{ISSUE:security-supply-chain}} {{TITLE:security-supply-chain}}
- [ ] {{ISSUE:security-review}} {{TITLE:security-review}}

## Acceptance criteria

- [ ] Every child issue is complete with its automated tests and relevant documentation updates.
- [ ] Cross-child success, missing-data/failure and server-authorisation paths behave consistently.
- [ ] User-facing work meets responsive and accessibility requirements where applicable.
- [ ] Integration/background work exposes structured diagnostics without sensitive content.
- [ ] No child exceeds v1 scope or weakens the documented evidence/data-integrity boundaries.

## Out of scope

Enterprise compliance certification, complex tenant roles and legal advice.

## Implementation notes

Child issues own implementation detail. Shared contracts, state machines, versioning, idempotency and evidence references must follow the linked documentation.

## Data and permissions

Workspace ownership is enforced server-side. Sensitive fields, retention/deletion effects and crafted-identifier negative cases are defined in child issues and remain capability acceptance gates.

## Test notes

Capability closure requires integrated child tests plus the relevant critical journey or operational proof; test-only work does not substitute for outcome acceptance.

## Dependencies

Blocked by:

* {{ISSUE:cap-access}} [Capability] Internal access and application shell
* {{ISSUE:cap-instagram-connection}} [Capability] Instagram account integration
* {{ISSUE:cap-content-ingestion}} [Capability] Video upload and transcript management
* {{ISSUE:cap-background-jobs}} [Capability] Background processing and job reliability

Blocks:

* {{ISSUE:cap-launch}} [Capability] Testing, deployment and launch readiness
