Backlog metadata — Priority: P1 · Size: L · Product area: Analytics · Target release: v1.0-internal · Parent capability: {{ISSUE:cap-analytics}} [Capability] Account analytics and trend calculation

## Outcome

For each eligible creative feature/value and canonical metric, the system produces an immutable, explainable statistic with sample, baseline, effect, uncertainty, multiple-test/outlier sensitivity, confidence and contributing evidence IDs.

## Context

This issue delivers one implementation outcome within [Capability] Account analytics and trend calculation and follows the versioned product/technical contracts.

Relevant documentation:

* `docs/technical/analytics-and-metrics.md`
* `docs/technical/data-model.md`

## Scope

* Add AccountFeatureStatistic/calculation membership schema and feature extraction eligibility.
* Implement group/comparison medians, seeded bootstrap intervals, leave-one-out/remove-best-worst, missingness/outlier and practical-effect rules.
* Implement insufficient, outlier, weak, moderate and statistically supported classifications plus BH q-control.
* Support categorical features and predefined duration bands; record formula/taxonomy/analysis versions.

## Acceptance criteria

- [ ] Classification exactly follows documented minimum samples/effect/uncertainty/sensitivity/missingness rules.
- [ ] A single dominating post is labelled outlier and cannot produce a general strong trend.
- [ ] Model field confidence gates feature eligibility but never upgrades statistical confidence.
- [ ] Multiple comparisons use deterministic family/q metadata when statistically supported is possible.
- [ ] Every record contains feature/value/metric/cohort/samples/baseline/difference/period/confidence/relevant IDs/input fingerprint.
- [ ] Results are reproducible with seeded fixtures and robust to row order.
- [ ] No output uses causal or algorithm-rule language.

## Out of scope

Strategy prose, causal inference, arbitrary cut-point mining and global trends.

## UI and content notes

There is no dedicated screen. Any surfaced state or error uses the canonical terminology and safe redacted detail defined by the parent capability.

## Implementation notes

Statistical code is application/domain code. Preserve full and sensitivity results rather than deleting outliers.

## Data and permissions

Uses same-account current eligible analyses and snapshots only; historical referenced versions are retained.

## Test notes

* Fixed datasets for every confidence/outlier/missingness/multiple-test branch.
* Seed reproducibility and leave-one-out tests.
* Cross-account/version incompatibility tests.

## Dependencies

Blocked by:

* {{ISSUE:analytics-cohorts}} Implement comparable snapshot cohorts and robust baselines
* {{ISSUE:analysis-handler}} Process and transactionally publish one validated post analysis

Blocks:

* {{ISSUE:analytics-recalculation}} Publish versioned account analytics through a debounced recalculation job
