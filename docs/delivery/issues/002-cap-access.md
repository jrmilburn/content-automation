Backlog metadata — Priority: P0 · Size: L · Product area: Internal access · Target release: v1.0-internal · Parent capability: {{ISSUE:project-v1}} [Project] Studio Parallel Instagram content intelligence v1

## Outcome

Approved Studio Parallel staff can securely sign in and navigate a responsive internal shell that exposes setup, attention and safe failure states without leaking workspace data.

## Context

This capability coordinates a coherent v1 delivery area and rolls up its implementation issues.

Relevant documentation:

* `docs/product/user-journeys.md`
* `docs/design/screen-map.md`
* `docs/technical/security-and-privacy.md`

## Scope

* Google Workspace OIDC plus explicit user allowlisting.
* Server-side workspace/resource authorisation and session lifecycle.
* Responsive, accessible application navigation and shared states.
* Internal dashboard that prioritises setup and attention items.

Child issues:

- [ ] {{ISSUE:access-auth}} {{TITLE:access-auth}}
- [ ] {{ISSUE:access-shell}} {{TITLE:access-shell}}
- [ ] {{ISSUE:access-dashboard}} {{TITLE:access-dashboard}}

## Acceptance criteria

- [ ] Every child issue is complete with its automated tests and relevant documentation updates.
- [ ] Cross-child success, missing-data/failure and server-authorisation paths behave consistently.
- [ ] User-facing work meets responsive and accessibility requirements where applicable.
- [ ] Integration/background work exposes structured diagnostics without sensitive content.
- [ ] No child exceeds v1 scope or weakens the documented evidence/data-integrity boundaries.

## Out of scope

Public onboarding, client accounts and complex role/permission administration.

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

* {{ISSUE:cap-instagram-connection}} [Capability] Instagram account integration
* {{ISSUE:cap-content-ingestion}} [Capability] Video upload and transcript management
* {{ISSUE:cap-security}} [Capability] Security, privacy and data lifecycle
