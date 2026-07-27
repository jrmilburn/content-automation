Backlog metadata — Priority: P1 · Size: L · Product area: Analytics · Target release: v1.0-internal · Parent capability: {{ISSUE:cap-analytics}} [Capability] Account analytics and trend calculation

## Outcome

Users can explore what appears to work, weak patterns, outliers and data limitations by metric/period and inspect every trend's formula, cohort, sample, uncertainty and contributing posts.

## Context

This issue delivers one implementation outcome within [Capability] Account analytics and trend calculation and follows the versioned product/technical contracts.

Relevant documentation:

* `docs/design/screen-map.md`
* `docs/technical/analytics-and-metrics.md`

## Scope

* Build /trends filters for account/date/metric/feature/category and current calculation freshness.
* Group statistically supported/moderate, weak directional, outlier and insufficient/data-quality results.
* Build trend detail/table with formula/denominator, group/comparison medians/IQR, difference, period, sensitivity and linked posts.
* Provide textual/table equivalents for any chart and isolated loading/empty/error/stale states.

## Acceptance criteria

- [ ] Trend cards always show feature/value, metric, sample, baseline difference, period and confidence class.
- [ ] Confidence copy is non-causal/account-scoped and model confidence is not shown as statistical evidence.
- [ ] Unavailable/insufficient/incompatible data explains what is missing and useful next experiment.
- [ ] Outliers/counterexamples are inspectable and not hidden from a positive claim.
- [ ] Filters are URL-stable/server-bounded and stale calculation is visible.
- [ ] Charts have equivalent data tables; keyboard, contrast, zoom and 390px horizontal-table behaviour pass.
- [ ] Query/presenter/Playwright/axe tests cover all classifications.

## Out of scope

Global trends, causal claims, raw ad mixing and AI-calculated statistics.

## UI and content notes

Lead with supported associations, then directional signals, outliers and limitations. “In this account…” language is mandatory; evidence detail provides progressive disclosure.

## Implementation notes

Read materialised statistics and canonical presenters. Do not recompute/bootstrap in request or client.

## Data and permissions

Same-account/workspace only; post links route through authorised detail. No raw payload/content in exports (none in v1).

## Test notes

* Filter/query/authorisation integration tests.
* Presenter language/classification fixtures.
* Mobile/keyboard/chart-equivalent/axe Playwright.

## Dependencies

Blocked by:

* {{ISSUE:analytics-recalculation}} Publish versioned account analytics through a debounced recalculation job
* {{ISSUE:analysis-result-ui}} Present structured creative analysis with confidence and estimation labels
* {{ISSUE:access-shell}} Build the responsive accessible internal application shell

Blocks:

* {{ISSUE:strategy-ui}} Deliver evidence-first strategy generation and history experience
* {{ISSUE:e2e-strategy}} Prove end-to-end analytics, strategy and recommendation evidence flow
