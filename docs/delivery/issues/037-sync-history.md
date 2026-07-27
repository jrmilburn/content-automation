Backlog metadata — Priority: P1 · Size: M · Product area: Internal operations · Target release: v1.0-internal · Parent capability: {{ISSUE:cap-instagram-sync}} [Capability] Instagram post and metric synchronisation

## Outcome

Users can inspect each import/snapshot run's trigger, checkpoint, counts, rate-limit/token context and safe retry/reconnect action.

## Context

This issue delivers one implementation outcome within [Capability] Instagram post and metric synchronisation and follows the versioned product/technical contracts.

Relevant documentation:

* `docs/design/screen-map.md`
* `docs/technical/instagram-integration.md`

## Scope

* Build sync-run list/detail queries/screens under account and operations navigation.
* Show state/stage, trigger, API version, time/cursor progress, item counts, usage summary, attempts and redacted error/correlation ID.
* Wire authorised resume/retry or reconnect link according to failure class.
* Support partial-success and stale-run reconciliation indicators.

## Acceptance criteria

- [ ] Running, partial, retry-scheduled, failed-attention, succeeded, cancelled/stale and empty states are clear.
- [ ] Opaque cursor and tokens/raw URLs are never displayed; safe progress/counts are.
- [ ] Retry/resume is idempotent, server-eligible and double-click safe.
- [ ] Permission/revoked token failure links to reconnect rather than blind retry.
- [ ] A run with individual failures exposes count/reason classes without sensitive payloads.
- [ ] Mobile and keyboard layouts preserve labels/actions; meaningful state changes are announced.
- [ ] Queries/actions and failure-state UI are tested.

## Out of scope

Raw provider payload/log explorer and bulk retry.

## UI and content notes

Lead with outcome/required action, then counts/progress, timing/API version and technical correlation detail. Say “Some posts were imported” for partial success.

## Implementation notes

Read SyncRun/domain state, not queue internals. Item diagnostics are aggregated by safe error class.

## Data and permissions

Account/workspace scoped; no credentials, captions or raw provider errors in UI.

## Test notes

* Run query/action authorisation and retry tests.
* Component/Playwright partial/token/rate-limit states.
* Mobile/axe checks.

## Dependencies

Blocked by:

* {{ISSUE:sync-orchestration}} Deliver manual, incremental and scheduled sync orchestration
* {{ISSUE:access-shell}} Build the responsive accessible internal application shell

Blocks:

* {{ISSUE:operations-dashboard}} Deliver the manual-attention operations dashboard
* {{ISSUE:e2e-import}} Prove end-to-end Instagram connection, import and sync recovery
