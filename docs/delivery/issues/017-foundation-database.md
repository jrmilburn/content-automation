Backlog metadata — Priority: P0 · Size: M · Product area: Product foundation · Target release: v1.0-internal · Parent capability: {{ISSUE:cap-foundation}} [Capability] Product foundation and technical architecture

## Outcome

The application has a migration-managed PostgreSQL foundation with one seeded Studio Parallel workspace, ownership-safe repository patterns and the core identity/audit primitives needed by vertical slices.

## Context

This issue delivers one implementation outcome within [Capability] Product foundation and technical architecture and follows the versioned product/technical contracts.

Relevant documentation:

* `docs/technical/data-model.md`
* `docs/technical/architecture.md`

## Scope

* Configure Prisma/PostgreSQL and migration/seed workflows.
* Create Workspace, InternalUser, AuditEvent and initial SystemSetting structures plus shared ID/timestamp conventions.
* Provide transaction/repository helpers that require workspace context.
* Document migration compatibility and test database setup.

## Acceptance criteria

- [ ] Fresh database creation and migration from an empty schema succeed reproducibly.
- [ ] Exactly one development/test workspace seed is created without production PII.
- [ ] Repository examples require workspace scope and reject cross-workspace lookups.
- [ ] Uniqueness, timestamps and audit actor/service references are enforced.
- [ ] Migration and schema drift checks run in CI.
- [ ] Database integration tests use real PostgreSQL.

## Out of scope

Full product entity schema, queue tables and production data migration.

## UI and content notes

There is no dedicated screen. Any surfaced state or error uses the canonical terminology and safe redacted detail defined by the parent capability.

## Implementation notes

Add product entities in vertical issues, following UUID/time/immutability/current-pointer conventions. Avoid a generic repository that makes unscoped reads easy.

## Data and permissions

Workspace/user metadata is access-controlled; audit events store identifiers/hashes, not secret/content bodies.

## Test notes

* Migration/seed integration tests.
* Cross-workspace and duplicate-identity negative tests.
* Transaction rollback test.

## Dependencies

Blocked by:

* {{ISSUE:foundation-scaffold}} Scaffold the TypeScript web and worker workspace

Blocks:

* {{ISSUE:foundation-ci}} Establish CI and automated test quality gates
* {{ISSUE:foundation-observability}} Add structured logging, correlation and error-monitoring foundations
* {{ISSUE:access-auth}} Implement Google Workspace sign-in and server-side workspace authorisation
* {{ISSUE:jobs-queue}} Implement the PostgreSQL-backed queue and transactional dispatch
* {{ISSUE:instagram-oauth}} Implement Instagram connection callback and encrypted credential storage
* {{ISSUE:upload-storage}} Implement private object storage and signed multipart video upload
* {{ISSUE:metrics-engine}} Implement canonical metric definitions and rate formula engine
* {{ISSUE:strategy-retrieval}} Build deterministic strategy evidence retrieval and frozen manifests
