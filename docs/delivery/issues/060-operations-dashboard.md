Backlog metadata — Priority: P1 · Size: L · Product area: Internal operations · Target release: v1.0-internal · Parent capability: {{ISSUE:cap-operations}} [Capability] Internal operations and failure recovery

## Outcome

Operators can find failed syncs/jobs, expired credentials, missing assets/transcripts, stale analyses/statistics and incomplete associations in one prioritised, filterable place with the safe next action.

## Context

This issue delivers one implementation outcome within [Capability] Internal operations and failure recovery and follows the versioned product/technical contracts.

Relevant documentation:

* `docs/design/screen-map.md`
* `docs/technical/background-jobs.md`

## Scope

* Build authorised operations summary/query and /operations filters by attention type/account/state/age.
* Aggregate integration, sync, upload/association, job, analysis version, analytics freshness and strategy failures.
* Link each item to owning detail/reconnect/upload/retry/recalculate action; no arbitrary mutation.
* Show counts, oldest age, last checked and partial subsystem failure.

## Acceptance criteria

- [ ] Security/data-loss/reconnect blockers rank before ordinary incomplete content.
- [ ] Every row identifies resource, problem, age, safe action and correlation/detail link when available.
- [ ] One subsystem query failure does not hide other attention categories and is visibly partial.
- [ ] Empty state confirms checks/time rather than claiming permanent health.
- [ ] Filters/pagination remain stable and server-bounded; no raw logs/content/secrets render.
- [ ] Keyboard/table/mobile/zoom/axe and refresh state preservation pass.
- [ ] Workspace/crafted-ID and summary query tests pass.

## Out of scope

Generic admin/database console, bulk destructive actions and raw provider/model payload view.

## UI and content notes

Lead with required attention grouped by impact. Use verbs (Reconnect, Upload source, Retry analysis), not opaque internal state codes.

## Implementation notes

Read domain health projections and stable error taxonomy; actions remain in owning services.

## Data and permissions

Operational metadata only; same workspace. Sensitive error/content fields are excluded by query projection.

## Test notes

* Projection/priority/partial query tests.
* Authorisation/pagination/filter integration tests.
* Mobile/keyboard/axe Playwright.

## Dependencies

Blocked by:

* {{ISSUE:jobs-operations-ui}} Provide job list and diagnostic detail experience
* {{ISSUE:sync-history}} Deliver sync history, detail and failure recovery
* {{ISSUE:instagram-token-health}} Implement Instagram token health, refresh and reconnect handling
* {{ISSUE:asset-lifecycle}} Implement source asset replacement, transcript deletion and storage lifecycle
* {{ISSUE:analysis-reanalysis}} Support analysis version activation and safe reanalysis
* {{ISSUE:strategy-handler}} Generate, validate and preserve immutable strategy history
* {{ISSUE:access-shell}} Build the responsive accessible internal application shell

Blocks:

* {{ISSUE:operations-runbooks}} Create internal operating and failure-recovery runbooks
