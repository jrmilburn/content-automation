Backlog metadata — Priority: P1 · Size: M · Product area: Internal operations · Target release: v1.0-internal · Parent capability: {{ISSUE:cap-background-jobs}} [Capability] Background processing and job reliability

## Outcome

Internal users can see queued, processing, retrying, failed and completed work with stage/attempt/timing/correlation context and the safe available action.

## Context

This issue delivers one implementation outcome within [Capability] Background processing and job reliability and follows the versioned product/technical contracts.

Relevant documentation:

* `docs/design/screen-map.md`
* `docs/technical/background-jobs.md`

## Scope

* Build filterable job list/detail queries and screens for all logical job kinds.
* Show attempts, stage, next retry, version metadata, usage summaries and redacted error class/detail.
* Wire safe cancel/retry commands as those capabilities land.
* Provide live/polling refresh, stale indication and deep links to the owned resource.

## Acceptance criteria

- [ ] Filters cover state, type, account/resource and manual-attention status.
- [ ] Detail never displays tokens, signed URLs, transcript/video, raw prompt/response or raw provider payload.
- [ ] Queued/processing/retry/failed/cancelled/empty/error states have distinct wording/actions.
- [ ] Retry/cancel buttons reflect server eligibility and handle duplicate clicks.
- [ ] Polling preserves focus/filter state and announces meaningful changes accessibly.
- [ ] Mobile detail stacks labels/values without clipping identifiers/actions.
- [ ] Queries/actions pass workspace/crafted-ID negative tests.

## Out of scope

Editing queue state, bulk destructive action and raw log viewer.

## UI and content notes

Lead with state and required action, then stage/timing/attempts, resource/version, correlation ID and safe technical detail. Error copy states whether existing data is safe.

## Implementation notes

The screen reads domain job records, not queue-internal rows, and uses stable links/correlation fields.

## Data and permissions

Server derives workspace and suppresses sensitive content. Audit retry/cancel actor and reason.

## Test notes

* Query/action integration and authorisation tests.
* Component states and duplicate-click tests.
* Playwright mobile/keyboard/axe flow.

## Dependencies

Blocked by:

* {{ISSUE:jobs-policy}} Implement logical job states, leases, retries and idempotent handler framework
* {{ISSUE:access-shell}} Build the responsive accessible internal application shell

Blocks:

* {{ISSUE:post-detail}} Build unified post detail with metrics, source and processing status
* {{ISSUE:analysis-history-ui}} Deliver analysis history, stale state, reanalysis and failure recovery UX
* {{ISSUE:operations-dashboard}} Deliver the manual-attention operations dashboard
