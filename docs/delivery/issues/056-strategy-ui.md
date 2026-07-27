Backlog metadata — Priority: P1 · Size: L · Product area: Content strategy · Target release: v1.0-internal · Parent capability: {{ISSUE:cap-strategy}} [Capability] Automated content strategy

## Outcome

Users can preview evidence sufficiency, request/generate a strategy, revisit history and consume working/weak patterns, tests, pillar allocation, next videos, evidence/confidence and limitations in the required hierarchy.

## Context

This issue delivers one implementation outcome within [Capability] Automated content strategy and follows the versioned product/technical contracts.

Relevant documentation:

* `docs/design/screen-map.md`
* `docs/technical/strategy-generation.md`

## Scope

* Build /strategy index/request preview and /strategy/:id detail/history.
* Render standard/exploratory, queued/processing/retry/failed, empty/no-analysis/stale-evidence and completed states.
* Present sections in required order and provide claim/recommendation evidence links to exact trends/posts/analyses.
* Implement explicit regeneration with prior-strategy preservation and duplicate-awareness note.

## Acceptance criteria

- [ ] Request preview shows period/metric, analysed/comparable counts and evidence-led versus exploratory mode before submit.
- [ ] Completed page order is working, not working, tests, recommended videos, evidence/confidence, limitations.
- [ ] Every empirical claim opens stored evidence; broken/deleted evidence shows tombstone limitation, not a replacement.
- [ ] Insufficient data language does not imply strong evidence and leads to experiments/data collection.
- [ ] Duplicate submit/regeneration states are refresh-safe and accessible; old current remains on failure.
- [ ] Mobile/keyboard/zoom/axe and loading/empty/error/history states pass.
- [ ] Queries/actions are account/workspace authorised with crafted-ID tests.

## Out of scope

Editing strategy prose as source evidence, public sharing/export and automatic publishing.

## UI and content notes

Lead with decisions, but keep sample/confidence adjacent. Use “appears associated in this account,” “directional signal,” “outlier” and “creative proposal.”

## Implementation notes

Use validated presenter and immutable evidence IDs. Client does not calculate confidence or infer state.

## Data and permissions

Strategy/evidence are internal; same-workspace only. Do not render raw prompt/provider response.

## Test notes

* Request/query/action authorisation tests.
* All mode/state/evidence-link component fixtures.
* Desktop/mobile/keyboard/axe Playwright.

## Dependencies

Blocked by:

* {{ISSUE:strategy-handler}} Generate, validate and preserve immutable strategy history
* {{ISSUE:trends-ui}} Deliver account trends dashboard and evidence detail
* {{ISSUE:access-shell}} Build the responsive accessible internal application shell

Blocks:

* {{ISSUE:recommendation-ui}} Deliver recommendation detail as an actionable evidence-linked video brief
* {{ISSUE:e2e-strategy}} Prove end-to-end analytics, strategy and recommendation evidence flow
