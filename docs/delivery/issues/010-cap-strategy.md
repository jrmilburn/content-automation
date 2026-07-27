Backlog metadata — Priority: P1 · Size: L · Product area: Content strategy · Target release: v1.0-internal · Parent capability: {{ISSUE:project-v1}} [Project] Studio Parallel Instagram content intelligence v1

## Outcome

A user can generate and revisit an immutable account strategy from a bounded frozen evidence set, with structured claims, pillar allocation, tests, next videos, confidence and data limitations.

## Context

This capability coordinates a coherent v1 delivery area and rolls up its implementation issues.

Relevant documentation:

* `docs/technical/strategy-generation.md`
* `docs/technical/analytics-and-metrics.md`
* `docs/product/v1-product-definition.md`

## Scope

* Deterministic evidence retrieval and frozen manifests.
* Structured strategy schema/prompt and semantic validation.
* Queued generation, idempotency, history and usage metadata.
* Evidence-first strategy UI including insufficient/exploratory states.

Child issues:

- [ ] {{ISSUE:strategy-retrieval}} {{TITLE:strategy-retrieval}}
- [ ] {{ISSUE:strategy-contract}} {{TITLE:strategy-contract}}
- [ ] {{ISSUE:strategy-handler}} {{TITLE:strategy-handler}}
- [ ] {{ISSUE:strategy-ui}} {{TITLE:strategy-ui}}

## Acceptance criteria

- [ ] Every child issue is complete with its automated tests and relevant documentation updates.
- [ ] Cross-child success, missing-data/failure and server-authorisation paths behave consistently.
- [ ] User-facing work meets responsive and accessibility requirements where applicable.
- [ ] Integration/background work exposes structured diagnostics without sensitive content.
- [ ] No child exceeds v1 scope or weakens the documented evidence/data-integrity boundaries.

## Out of scope

Sending raw account videos, external trend grounding, autonomous agents and automatic publishing.

## Implementation notes

Child issues own implementation detail. Shared contracts, state machines, versioning, idempotency and evidence references must follow the linked documentation.

## Data and permissions

Workspace ownership is enforced server-side. Sensitive fields, retention/deletion effects and crafted-identifier negative cases are defined in child issues and remain capability acceptance gates.

## Test notes

Capability closure requires integrated child tests plus the relevant critical journey or operational proof; test-only work does not substitute for outcome acceptance.

## Dependencies

Blocked by:

* {{ISSUE:cap-analytics}} [Capability] Account analytics and trend calculation
* {{ISSUE:cap-video-analysis}} [Capability] Gemini per-video analysis
* {{ISSUE:cap-background-jobs}} [Capability] Background processing and job reliability

Blocks:

* {{ISSUE:cap-recommendations}} [Capability] Recommendation experience
* {{ISSUE:cap-operations}} [Capability] Internal operations and failure recovery
