Backlog metadata — Priority: P1 · Size: L · Product area: Recommendations · Target release: v1.0-internal · Parent capability: {{ISSUE:project-v1}} [Project] Studio Parallel Instagram content intelligence v1

## Outcome

Strategy recommendations become evidence-linked actionable video briefs with multiple hooks, structure, filming/editing/CTA guidance, experiments, lifecycle status and an optional resulting-post link.

## Context

This capability coordinates a coherent v1 delivery area and rolls up its implementation issues.

Relevant documentation:

* `docs/technical/strategy-generation.md`
* `docs/design/screen-map.md`

## Scope

* Recommendation/evidence persistence and duplicate fingerprints.
* Actionable accessible recommendation detail.
* Proposed/selected/completed/dismissed workflow and resulting-post link.

Child issues:

- [ ] {{ISSUE:recommendation-model}} {{TITLE:recommendation-model}}
- [ ] {{ISSUE:recommendation-ui}} {{TITLE:recommendation-ui}}
- [ ] {{ISSUE:recommendation-workflow}} {{TITLE:recommendation-workflow}}

## Acceptance criteria

- [ ] Every child issue is complete with its automated tests and relevant documentation updates.
- [ ] Cross-child success, missing-data/failure and server-authorisation paths behave consistently.
- [ ] User-facing work meets responsive and accessibility requirements where applicable.
- [ ] Integration/background work exposes structured diagnostics without sensitive content.
- [ ] No child exceeds v1 scope or weakens the documented evidence/data-integrity boundaries.

## Out of scope

Automatic video generation/editing/publishing and claims that completion caused performance.

## Implementation notes

Child issues own implementation detail. Shared contracts, state machines, versioning, idempotency and evidence references must follow the linked documentation.

## Data and permissions

Workspace ownership is enforced server-side. Sensitive fields, retention/deletion effects and crafted-identifier negative cases are defined in child issues and remain capability acceptance gates.

## Test notes

Capability closure requires integrated child tests plus the relevant critical journey or operational proof; test-only work does not substitute for outcome acceptance.

## Dependencies

Blocked by:

* {{ISSUE:cap-strategy}} [Capability] Automated content strategy
* {{ISSUE:cap-instagram-sync}} [Capability] Instagram post and metric synchronisation

Blocks:

* {{ISSUE:cap-launch}} [Capability] Testing, deployment and launch readiness
