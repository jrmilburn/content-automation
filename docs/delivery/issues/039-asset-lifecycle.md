Backlog metadata — Priority: P0 · Size: M · Product area: Security and privacy · Target release: v1.0-internal · Parent capability: {{ISSUE:cap-content-ingestion}} [Capability] Video upload and transcript management

## Outcome

Users can safely replace or delete source assets/transcripts with explicit downstream effects, immediate access revocation, provider/object cleanup and auditable recovery/retention handling.

## Context

This issue delivers one implementation outcome within [Capability] Video upload and transcript management and follows the versioned product/technical contracts.

Relevant documentation:

* `docs/technical/video-ingestion.md`
* `docs/technical/security-and-privacy.md`

## Scope

* Implement pending replacement that preserves current asset until new validation succeeds.
* Add admin-authorised delete requests for asset or transcript, block new access/jobs and clear current pointers safely.
* Delete object versions, abandoned multipart and known Gemini temporary copies through retryable cleanup.
* Apply approved superseded/rejected/abandoned retention and expose deletion status.

## Acceptance criteria

- [ ] Failed/cancelled replacement leaves the previous current asset and analysis usable but appropriately versioned.
- [ ] Successful replacement atomically switches current pointer and marks existing analysis stale.
- [ ] Delete immediately prevents signed access/new analysis and handles queued jobs at safe points.
- [ ] Object/provider cleanup is idempotent, retried and reconciled; tombstone/audit remains without content.
- [ ] Transcript body/script/notes purge follows policy while historical provenance hash remains only if approved.
- [ ] Confirmation states exact scope/derived-analysis effect and repeated submit is safe.
- [ ] Deletion, restore-window, cleanup failure and crafted-ID tests pass.

## Out of scope

Full post/account/workspace erase and bulk deletion.

## UI and content notes

Replacement warns about stale analysis; deletion names file/text/derived effects and recovery window. Show pending, completed and cleanup-required states without exposing object details.

## Implementation notes

Use DeletionRequest/audit and explicit dependency traversal; never rely on a DB cascade to delete object/provider data.

## Data and permissions

Admin-only destructive action; private content access revoked first. Logs store IDs/outcomes, not deleted content.

## Test notes

* Replacement atomicity and active-job interaction tests.
* Object/version/Gemini cleanup retry/reconciliation tests.
* Admin/non-admin/crafted-ID and UI confirmation tests.

## Dependencies

Blocked by:

* {{ISSUE:source-editor}} Deliver source video association and transcript/context editor
* {{ISSUE:jobs-reconcile}} Add cancellation, manual retry and background reconciliation

Blocks:

* {{ISSUE:operations-dashboard}} Deliver the manual-attention operations dashboard
* {{ISSUE:security-deletion}} Implement approved retention and full data-deletion workflows
