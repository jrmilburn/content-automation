Backlog metadata — Priority: P1 · Size: L · Product area: Video analysis · Target release: v1.0-internal · Parent capability: {{ISSUE:cap-analysis-review}} [Capability] Analysis review and post detail

## Outcome

A user can open one imported post and understand its provider metadata, comparable metric observation, source inputs, analysis eligibility/current job and the next safe action.

## Context

This issue delivers one implementation outcome within [Capability] Analysis review and post detail and follows the versioned product/technical contracts.

Relevant documentation:

* `docs/design/screen-map.md`
* `docs/product/user-journeys.md`
* `docs/technical/analytics-and-metrics.md`

## Scope

* Create workspace-scoped post detail query and /posts/:postId page sections for identity/permalink/caption, snapshot metrics, source/transcript summary and processing status.
* Select/display a named comparable/latest snapshot without mixing definitions and expose snapshot age/capture time.
* Wire upload/edit/analyse or job/retry links based on state.
* Handle tombstoned provider media, ephemeral preview failure and partial data independently.

## Acceptance criteria

- [ ] No source, validating/rejected source, eligible, queued/processing/retry/failed, completed and stale analysis states each show correct next action.
- [ ] Every metric names canonical definition/denominator and snapshot time; unavailable differs from zero.
- [ ] Page remains useful if thumbnail, one metric group or job-status refresh fails.
- [ ] Permalink is safe external navigation and does not substitute as stored source.
- [ ] Crafted/cross-workspace post/job/snapshot IDs do not leak data.
- [ ] Semantic headings/tables, keyboard actions, focus after mutations and 390px layout pass.
- [ ] Query/state/component/Playwright tests cover edge paths.

## Out of scope

Full structured analysis rendering, trends and editing provider metadata.

## UI and content notes

Lead with post identity and attention state, then comparable performance, source inputs and analysis. Use clear “Upload source video,” “Analyse video,” “Retry” actions.

## Implementation notes

Server query composes canonical presenters; no client metric calculation. Status polling uses domain job state.

## Data and permissions

Caption/source/transcript summaries are private. Signed playback/download obtained separately after authorisation.

## Test notes

* Query snapshot-selection/ownership integration tests.
* Component partial/unavailable/job-state tests.
* Desktop/mobile keyboard/axe Playwright.

## Dependencies

Blocked by:

* {{ISSUE:sync-insights}} Import supported insights as immutable metric snapshots
* {{ISSUE:source-editor}} Deliver source video association and transcript/context editor
* {{ISSUE:jobs-operations-ui}} Provide job list and diagnostic detail experience
* {{ISSUE:access-shell}} Build the responsive accessible internal application shell

Blocks:

* {{ISSUE:analysis-result-ui}} Present structured creative analysis with confidence and estimation labels
