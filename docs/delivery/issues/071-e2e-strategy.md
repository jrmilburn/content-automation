Backlog metadata — Priority: P1 · Size: M · Product area: Launch readiness · Target release: v1.0-internal · Parent capability: {{ISSUE:cap-launch}} [Capability] Testing, deployment and launch readiness

## Outcome

A fixed account dataset produces reviewed trends, a validated evidence-linked strategy and actionable recommendations whose lifecycle/result links preserve exact evidence and limitations.

## Context

This issue delivers one implementation outcome within [Capability] Testing, deployment and launch readiness and follows the versioned product/technical contracts.

Relevant documentation:

* `docs/technical/testing-strategy.md`
* `docs/technical/analytics-and-metrics.md`
* `docs/technical/strategy-generation.md`

## Scope

* Create seeded fixed account data spanning supported, weak, outlier, insufficient and missing-metric cases.
* Run recalculation, trends/detail, standard/exploratory strategy, evidence navigation and recommendation status/result link in Playwright.
* Inject stale calculation, invalid/hallucinated evidence, duplicate idea and provider failure.
* Verify immutable history after recalculation/regeneration.

## Acceptance criteria

- [ ] Fixed dataset produces exact reviewed formulas/cohorts/confidence/outlier classifications.
- [ ] Every strategy claim/recommendation evidence link resolves to exact frozen record and unsupported ID is rejected.
- [ ] Insufficient dataset yields exploratory/data-gathering language, not strong claims.
- [ ] Regeneration preserves old strategy/evidence and incorporates recent recommendation fingerprints.
- [ ] Recommendation lifecycle/result link works without causal wording.
- [ ] Loading/empty/stale/error/mobile/keyboard/axe paths pass.
- [ ] No raw videos are sent during strategy generation.

## Out of scope

Editorial guarantee that every generated idea will perform and production auto-generation schedule.

## UI and content notes

There is no dedicated screen. Any surfaced state or error uses the canonical terminology and safe redacted detail defined by the parent capability.

## Implementation notes

Use deterministic model fake in CI and optional evaluated paid strategy smoke; assert semantic invariants.

## Data and permissions

Seed is synthetic; all queries/actions same-workspace. Evidence tombstones are explicitly tested.

## Test notes

* Fixed analytics unit/integration expectations.
* Playwright strategy/recommendation journey.
* Evidence hallucination/duplicate/current-history negative tests.

## Dependencies

Blocked by:

* {{ISSUE:recommendation-workflow}} Implement recommendation status and resulting-post learning loop
* {{ISSUE:trends-ui}} Deliver account trends dashboard and evidence detail
* {{ISSUE:strategy-ui}} Deliver evidence-first strategy generation and history experience

Blocks:

* {{ISSUE:acceptance-a11y}} Complete cross-browser, mobile, accessibility and Studio Parallel acceptance
