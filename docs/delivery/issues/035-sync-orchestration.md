Backlog metadata — Priority: P1 · Size: L · Product area: Instagram integration · Target release: v1.0-internal · Parent capability: {{ISSUE:cap-instagram-sync}} [Capability] Instagram post and metric synchronisation

## Outcome

Users and schedules can start or resume idempotent account imports and due metric snapshots while respecting token health, account locks, post-age cadence and Meta rate limits.

## Context

This issue delivers one implementation outcome within [Capability] Instagram post and metric synchronisation and follows the versioned product/technical contracts.

Relevant documentation:

* `docs/technical/instagram-integration.md`
* `docs/technical/background-jobs.md`

## Scope

* Add SyncRun trigger/state/count/checkpoint model and handlers for bootstrap, manual, scheduled and reconcile runs.
* Implement recent-page overlap, due-snapshot cadence/tolerance selection and one-active-run locks.
* Add manual sync command/status and scheduler entries with adaptive provider throttling.
* Summarise partial completion, missed cadence and retry/manual-action reasons.

## Acceptance criteria

- [ ] Duplicate manual clicks/scheduler invocations return one active logical run per account/purpose window.
- [ ] Incremental sync overlaps recent pages and remains idempotent.
- [ ] Due snapshot selection records actual capture/post age and never backdates a missed target.
- [ ] Unhealthy credentials block provider work and surface reconnect action.
- [ ] Meta usage/429 reduces concurrency/reschedules without hot-looping or losing checkpoints.
- [ ] Partial run reports imported/updated/snapshotted/skipped/failed counts and safe errors.
- [ ] Manual sync is authorised/rate-limited; schedules and reconciliation are covered with fake time.

## Out of scope

Real-time guarantees, exact 1h/24h schedules and webhook-dependent correctness.

## UI and content notes

There is no dedicated screen. Any surfaced state or error uses the canonical terminology and safe redacted detail defined by the parent capability.

## Implementation notes

Initial production may guarantee daily/manual cadence; model supports finer targets. Use UTC schedules and provider response hints.

## Data and permissions

Run/job payloads use internal IDs; only same-workspace authorised users view/start manual runs.

## Test notes

* Fake-time cadence/overlap/lock/dedupe tests.
* Checkpoint crash/resume and 429 adaptive retry tests.
* Manual command authorisation/crafted-ID tests.

## Dependencies

Blocked by:

* {{ISSUE:sync-media}} Import Instagram media with pagination and Reel classification
* {{ISSUE:sync-insights}} Import supported insights as immutable metric snapshots
* {{ISSUE:jobs-reconcile}} Add cancellation, manual retry and background reconciliation
* {{ISSUE:instagram-token-health}} Implement Instagram token health, refresh and reconnect handling

Blocks:

* {{ISSUE:sync-history}} Deliver sync history, detail and failure recovery
* {{ISSUE:security-authz-abuse}} Complete negative authorisation, crafted-identifier and API-abuse controls
