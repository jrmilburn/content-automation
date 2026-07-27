Backlog metadata — Priority: P0 · Size: L · Product area: Analytics · Target release: v1.0-internal · Parent capability: {{ISSUE:cap-analytics}} [Capability] Account analytics and trend calculation

## Outcome

Application code calculates named, versioned Instagram performance measures with exact denominators and safely returns unavailable for absent, zero or incompatible inputs.

## Context

This issue delivers one implementation outcome within [Capability] Account analytics and trend calculation and follows the versioned product/technical contracts.

Relevant documentation:

* `docs/technical/analytics-and-metrics.md`

## Scope

* Create canonical metric dictionary with provider source/unit/compatibility and analytics_version.
* Implement engagement/share/save/comment/like/profile visit/follow conversion/follow reach/average watch/completion proxy formulas.
* Return typed value plus formula/denominator/availability/limitation provenance.
* Add fixed reviewed datasets and expected outputs.

## Acceptance criteria

- [ ] Every documented formula matches expected fixed-dataset values and names its denominator.
- [ ] Missing or zero denominator returns unavailable, never Infinity/NaN/0 substitution.
- [ ] Engagement requires all defined components; partial sums are not mislabelled.
- [ ] Views and plays, metadata and insight counts, and incompatible units never combine.
- [ ] Average watch can exceed 100%; stored value is unbounded while completion proxy is explicitly bounded/limited.
- [ ] Analytics version and source snapshot IDs accompany derived values.
- [ ] Unit/property/database tests cover negative/impossible/missing/zero cases.

## Out of scope

Cohort selection, feature statistics, charts and AI calculations.

## UI and content notes

There is no dedicated screen. Any surfaced state or error uses the canonical terminology and safe redacted detail defined by the parent capability.

## Implementation notes

Use integer/decimal-safe arithmetic and central presenters; formulas never live in React or Gemini prompt.

## Data and permissions

Inputs are same-workspace immutable snapshots and validated asset duration; access handled by calling service.

## Test notes

* Reviewed table-driven formula tests.
* Property tests for finiteness/denominator safety.
* Provider-definition compatibility negative tests.

## Dependencies

Blocked by:

* {{ISSUE:sync-insights}} Import supported insights as immutable metric snapshots
* {{ISSUE:foundation-database}} Establish PostgreSQL, Prisma and workspace ownership foundation
* {{ISSUE:foundation-ci}} Establish CI and automated test quality gates

Blocks:

* {{ISSUE:analytics-cohorts}} Implement comparable snapshot cohorts and robust baselines
