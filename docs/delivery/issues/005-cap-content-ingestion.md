Backlog metadata — Priority: P0 · Size: L · Product area: Content ingestion · Target release: v1.0-internal · Parent capability: {{ISSUE:project-v1}} [Project] Studio Parallel Instagram content intelligence v1

## Outcome

A user can securely upload, validate, associate, replace and delete a durable source video and manage versioned transcript/script/context for an imported post.

## Context

This capability coordinates a coherent v1 delivery area and rolls up its implementation issues.

Relevant documentation:

* `docs/technical/video-ingestion.md`
* `docs/technical/security-and-privacy.md`
* `docs/product/user-journeys.md`

## Scope

* Private signed multipart upload and storage controls.
* Sandboxed file validation and analysis eligibility.
* Post association and versioned transcript/script/notes/tags UI.
* Atomic asset replacement and auditable deletion/retention.

Child issues:

- [ ] {{ISSUE:upload-storage}} {{TITLE:upload-storage}}
- [ ] {{ISSUE:asset-validation}} {{TITLE:asset-validation}}
- [ ] {{ISSUE:source-editor}} {{TITLE:source-editor}}
- [ ] {{ISSUE:asset-lifecycle}} {{TITLE:asset-lifecycle}}

## Acceptance criteria

- [ ] Every child issue is complete with its automated tests and relevant documentation updates.
- [ ] Cross-child success, missing-data/failure and server-authorisation paths behave consistently.
- [ ] User-facing work meets responsive and accessibility requirements where applicable.
- [ ] Integration/background work exposes structured diagnostics without sensitive content.
- [ ] No child exceeds v1 scope or weakens the documented evidence/data-integrity boundaries.

## Out of scope

Automatic post matching, Instagram CDN archival, video editing/generation and collaborative editing.

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
* {{ISSUE:cap-instagram-sync}} [Capability] Instagram post and metric synchronisation
* {{ISSUE:cap-background-jobs}} [Capability] Background processing and job reliability

Blocks:

* {{ISSUE:cap-video-analysis}} [Capability] Gemini per-video analysis
* {{ISSUE:cap-analysis-review}} [Capability] Analysis review and post detail
* {{ISSUE:cap-operations}} [Capability] Internal operations and failure recovery
* {{ISSUE:cap-security}} [Capability] Security, privacy and data lifecycle
