Backlog metadata — Priority: P0 · Size: L · Product area: Analytics · Target release: v1.0-internal · Parent capability: {{ISSUE:project-v1}} [Project] Studio Parallel Instagram content intelligence v1

## Outcome

Application code calculates versioned comparable account-level feature statistics and presents evidence-linked trends with robust baselines, sample rules, uncertainty, outlier sensitivity and limitations.

## Context

This capability coordinates a coherent v1 delivery area and rolls up its implementation issues.

Relevant documentation:

* `docs/technical/analytics-and-metrics.md`
* `docs/technical/data-model.md`

## Scope

* Canonical metric/formula layer and missing-denominator safety.
* Snapshot-age cohort and robust baseline selection.
* Feature statistics, confidence/outlier/multiple-test rules.
* Atomic recalculation and accessible trends/evidence screens.

Child issues:

- [ ] {{ISSUE:metrics-engine}} {{TITLE:metrics-engine}}
- [ ] {{ISSUE:analytics-cohorts}} {{TITLE:analytics-cohorts}}
- [ ] {{ISSUE:analytics-feature-stats}} {{TITLE:analytics-feature-stats}}
- [ ] {{ISSUE:analytics-recalculation}} {{TITLE:analytics-recalculation}}
- [ ] {{ISSUE:trends-ui}} {{TITLE:trends-ui}}

## Acceptance criteria

- [ ] Every child issue is complete with its automated tests and relevant documentation updates.
- [ ] Cross-child success, missing-data/failure and server-authorisation paths behave consistently.
- [ ] User-facing work meets responsive and accessibility requirements where applicable.
- [ ] Integration/background work exposes structured diagnostics without sensitive content.
- [ ] No child exceeds v1 scope or weakens the documented evidence/data-integrity boundaries.

## Out of scope

Causal inference, global Instagram trends and opaque composite performance scores.

## Implementation notes

Child issues own implementation detail. Shared contracts, state machines, versioning, idempotency and evidence references must follow the linked documentation.

## Data and permissions

Workspace ownership is enforced server-side. Sensitive fields, retention/deletion effects and crafted-identifier negative cases are defined in child issues and remain capability acceptance gates.

## Test notes

Capability closure requires integrated child tests plus the relevant critical journey or operational proof; test-only work does not substitute for outcome acceptance.

## Dependencies

Blocked by:

* {{ISSUE:cap-instagram-sync}} [Capability] Instagram post and metric synchronisation
* {{ISSUE:cap-video-analysis}} [Capability] Gemini per-video analysis
* {{ISSUE:cap-background-jobs}} [Capability] Background processing and job reliability

Blocks:

* {{ISSUE:cap-strategy}} [Capability] Automated content strategy
* {{ISSUE:cap-launch}} [Capability] Testing, deployment and launch readiness
