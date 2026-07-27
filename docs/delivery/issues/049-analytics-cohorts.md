Backlog metadata — Priority: P1 · Size: L · Product area: Analytics · Target release: v1.0-internal · Parent capability: {{ISSUE:cap-analytics}} [Capability] Account analytics and trend calculation

## Outcome

Analytics can select one compatible observation per post by post-age window and calculate transparent account, recent and category medians without silently mixing maturity or metric definitions.

## Context

This issue delivers one implementation outcome within [Capability] Account analytics and trend calculation and follows the versioned product/technical contracts.

Relevant documentation:

* `docs/technical/analytics-and-metrics.md`
* `docs/technical/data-model.md`

## Scope

* Implement versioned post-age buckets/tolerances and closest-snapshot selection.
* Build eligible account/recent/category comparison queries excluding focal post where appropriate.
* Calculate median, IQR, ratio/difference/percent difference and coverage/missingness.
* Record cohort definition, publication period, snapshot period and input fingerprint.

## Acceptance criteria

- [ ] Each eligible post contributes at most one snapshot inside the requested age tolerance.
- [ ] Late/mature snapshots are never backdated into earlier buckets; insufficient bucket stays insufficient.
- [ ] Account/recent/category baselines use identical canonical metric definition/source/unit and media policy.
- [ ] Median/IQR/ratio math matches fixed fixtures including ties/zero baseline/unavailable.
- [ ] Focal post is excluded where possible and comparison counts/coverage are explicit.
- [ ] Queries are account/workspace/date bounded and perform within test dataset budget.
- [ ] Deterministic cohort/integration tests cover all bucket boundaries.

## Out of scope

Feature-level comparisons, confidence classes and opaque performance score.

## UI and content notes

There is no dedicated screen. Any surfaced state or error uses the canonical terminology and safe redacted detail defined by the parent capability.

## Implementation notes

Date filter applies to publication time; capture/post-age window is separately displayed. Use SQL where useful with reviewed tests.

## Data and permissions

Cohort outputs expose post/snapshot IDs only to authorised account queries.

## Test notes

* Boundary/fake-time snapshot selection fixtures.
* Median/recent/category/missing coverage tests.
* Query plan/performance and cross-workspace tests.

## Dependencies

Blocked by:

* {{ISSUE:metrics-engine}} Implement canonical metric definitions and rate formula engine

Blocks:

* {{ISSUE:analytics-feature-stats}} Calculate feature statistics, confidence and outlier sensitivity
