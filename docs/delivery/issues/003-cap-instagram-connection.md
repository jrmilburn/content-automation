Backlog metadata — Priority: P0 · Size: L · Product area: Instagram integration · Target release: v1.0-internal · Parent capability: {{ISSUE:project-v1}} [Project] Studio Parallel Instagram content intelligence v1

## Outcome

An authorised internal user can connect, inspect, maintain, reconnect and disconnect an eligible Studio Parallel Instagram professional account using least-privilege official Meta access.

## Context

This capability coordinates a coherent v1 delivery area and rolls up its implementation issues.

Relevant documentation:

* `docs/technical/instagram-integration.md`
* `docs/technical/security-and-privacy.md`

## Scope

* Meta app/account contract proof and launch prerequisites.
* OAuth callback and encrypted credential storage.
* Token/scope/expiry health and refresh/reconnect handling.
* Account configuration and safe disconnect experience.

Child issues:

- [ ] {{ISSUE:instagram-contract}} {{TITLE:instagram-contract}}
- [ ] {{ISSUE:instagram-oauth}} {{TITLE:instagram-oauth}}
- [ ] {{ISSUE:instagram-token-health}} {{TITLE:instagram-token-health}}
- [ ] {{ISSUE:instagram-account-ui}} {{TITLE:instagram-account-ui}}

## Acceptance criteria

- [ ] Every child issue is complete with its automated tests and relevant documentation updates.
- [ ] Cross-child success, missing-data/failure and server-authorisation paths behave consistently.
- [ ] User-facing work meets responsive and accessibility requirements where applicable.
- [ ] Integration/background work exposes structured diagnostics without sensitive content.
- [ ] No child exceeds v1 scope or weakens the documented evidence/data-integrity boundaries.

## Out of scope

Publishing, comments, messages, ads, personal accounts and third-party client onboarding.

## Implementation notes

Child issues own implementation detail. Shared contracts, state machines, versioning, idempotency and evidence references must follow the linked documentation.

## Data and permissions

Workspace ownership is enforced server-side. Sensitive fields, retention/deletion effects and crafted-identifier negative cases are defined in child issues and remain capability acceptance gates.

## Test notes

Capability closure requires integrated child tests plus the relevant critical journey or operational proof; test-only work does not substitute for outcome acceptance.

## Dependencies

Blocked by:

* {{ISSUE:cap-foundation}} [Capability] Product foundation and technical architecture
* {{ISSUE:cap-access}} [Capability] Internal access and application shell

Blocks:

* {{ISSUE:cap-instagram-sync}} [Capability] Instagram post and metric synchronisation
* {{ISSUE:cap-security}} [Capability] Security, privacy and data lifecycle
