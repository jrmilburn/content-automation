Backlog metadata — Priority: P0 · Size: L · Product area: Product foundation · Target release: v1.0-internal · Parent capability: {{ISSUE:project-v1}} [Project] Studio Parallel Instagram content intelligence v1

## Outcome

The repository has an approved v1 product/architecture baseline and a runnable, typed, observable application/data/quality foundation on which all vertical capabilities can build.

## Context

This capability coordinates a coherent v1 delivery area and rolls up its implementation issues.

Relevant documentation:

* `docs/product/v1-product-definition.md`
* `docs/technical/architecture.md`
* `docs/technical/data-model.md`
* `docs/technical/testing-strategy.md`

## Scope

* Approve the planning baseline and open decisions that block build decisions.
* Create the TypeScript web/worker/shared-package structure and typed environment configuration.
* Establish PostgreSQL/Prisma workspace ownership, migrations and seed data.
* Establish CI, test harness, structured logging and error monitoring foundations.

Child issues:

- [ ] {{ISSUE:foundation-approval}} {{TITLE:foundation-approval}}
- [ ] {{ISSUE:foundation-scaffold}} {{TITLE:foundation-scaffold}}
- [ ] {{ISSUE:foundation-database}} {{TITLE:foundation-database}}
- [ ] {{ISSUE:foundation-ci}} {{TITLE:foundation-ci}}
- [ ] {{ISSUE:foundation-observability}} {{TITLE:foundation-observability}}

## Acceptance criteria

- [ ] Every child issue is complete with its automated tests and relevant documentation updates.
- [ ] Cross-child success, missing-data/failure and server-authorisation paths behave consistently.
- [ ] User-facing work meets responsive and accessibility requirements where applicable.
- [ ] Integration/background work exposes structured diagnostics without sensitive content.
- [ ] No child exceeds v1 scope or weakens the documented evidence/data-integrity boundaries.

## Out of scope

Product feature workflows, production deployment and provider-specific behaviour.

## Implementation notes

Child issues own implementation detail. Shared contracts, state machines, versioning, idempotency and evidence references must follow the linked documentation.

## Data and permissions

Workspace ownership is enforced server-side. Sensitive fields, retention/deletion effects and crafted-identifier negative cases are defined in child issues and remain capability acceptance gates.

## Test notes

Capability closure requires integrated child tests plus the relevant critical journey or operational proof; test-only work does not substitute for outcome acceptance.

## Dependencies

Blocked by:

* None

Blocks:

* {{ISSUE:cap-access}} [Capability] Internal access and application shell
* {{ISSUE:cap-instagram-connection}} [Capability] Instagram account integration
* {{ISSUE:cap-content-ingestion}} [Capability] Video upload and transcript management
* {{ISSUE:cap-background-jobs}} [Capability] Background processing and job reliability
