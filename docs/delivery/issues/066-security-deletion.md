Backlog metadata — Priority: P0 · Size: L · Product area: Security and privacy · Target release: v1.0-internal · Parent capability: {{ISSUE:cap-security}} [Capability] Security, privacy and data lifecycle

## Outcome

Approved admins can delete transcript, post/account/workspace data according to a signed retention policy, with immediate access revocation, complete object/provider/credential/derived dependency handling and backup tombstone replay.

## Context

This issue delivers one implementation outcome within [Capability] Security, privacy and data lifecycle and follows the versioned product/technical contracts.

Relevant documentation:

* `docs/technical/security-and-privacy.md`
* `docs/technical/data-model.md`

## Scope

* Obtain approval for retention table and derived-analysis-on-asset-delete decision.
* Extend DeletionRequest planner/executor across posts, snapshots, assets, transcripts, analyses/statistics, strategies/recommendations, jobs, credentials and provider temporary files.
* Block access/work first, execute dependency-ordered idempotent purge/anonymisation, audit safe outcomes and reconcile failures.
* Create completed-deletion ledger reapplied after backup restore and admin confirmation/status UI.

## Acceptance criteria

- [ ] Policy names owner, duration and behaviour for every documented data class including backups/logs.
- [ ] Delete preview enumerates exact scope, irreversible effects and retained tombstones before confirmation.
- [ ] Full account/workspace erase purges credential, private objects, content and derived evidence without dangling current/evidence links.
- [ ] Transient external deletion retries; ambiguous/failed items remain inaccessible and visible to operations.
- [ ] Restored backup cannot reopen completed-deletion data before ledger replay.
- [ ] Non-admin/crafted/replayed deletion requests fail; duplicate execution is safe.
- [ ] End-to-end deletion/reconciliation/restore tests pass.

## Out of scope

Legal/compliance certification and bulk self-service customer deletion.

## UI and content notes

Use explicit resource names/counts, irreversible warning and typed/strong confirmation for broad erase. Show pending, partially complete, complete and action-required states.

## Implementation notes

Do not rely on ORM cascade for external objects/provider copies. Take locks and process evidence dependencies transactionally in phases.

## Data and permissions

Deletion audit contains IDs/hashes/status/actors, not deleted content. Backup retention and key access follow approved policy.

## Test notes

* Dependency graph/current-pointer/evidence integrity tests.
* Object/provider/credential transient and repeated execution tests.
* Admin/crafted-ID UI plus backup restore/tombstone rehearsal.

## Dependencies

Blocked by:

* {{ISSUE:asset-lifecycle}} Implement source asset replacement, transcript deletion and storage lifecycle
* {{ISSUE:instagram-account-ui}} Deliver Instagram account configuration and safe disconnection
* {{ISSUE:recommendation-workflow}} Implement recommendation status and resulting-post learning loop
* {{ISSUE:jobs-reconcile}} Add cancellation, manual retry and background reconciliation

Blocks:

* {{ISSUE:security-review}} Complete pre-launch security and privacy review
* {{ISSUE:backup-monitoring}} Verify backups, restore, monitoring and production alerts
