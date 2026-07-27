Backlog metadata — Priority: P0 · Size: L · Product area: Instagram integration · Target release: v1.0-internal · Parent capability: {{ISSUE:cap-instagram-sync}} [Capability] Instagram post and metric synchronisation

## Outcome

Bootstrap and incremental workers can cursor-page the authorised account's owned media and idempotently persist normalised posts, including correct Reel classification and raw provenance.

## Context

This issue delivers one implementation outcome within [Capability] Instagram post and metric synchronisation and follows the versioned product/technical contracts.

Relevant documentation:

* `docs/technical/instagram-integration.md`
* `docs/technical/data-model.md`

## Scope

* Implement typed Meta client/auth headers, timeouts, cursor pagination and error/usage-header mapping.
* Add InstagramPost schema/repository and normalise documented metadata fields/API version/raw payload hash.
* Classify Reels using media_product_type while retaining unknown/unsupported media.
* Persist page checkpoints and item-level outcomes under a SyncRun.

## Acceptance criteria

- [ ] Bootstrap imports all media in configured horizon across multiple cursors without duplicates.
- [ ] Repeated/overlapping pages update the same provider media ID and preserve immutable identity.
- [ ] A VIDEO with media_product_type REELS is classified as a Reel; unknown values remain inspectable.
- [ ] Cursor commits only after page records commit, permitting safe resume.
- [ ] Ephemeral media URLs are labelled/non-durable and never become source assets.
- [ ] One invalid item is isolated and counted without losing committed pages.
- [ ] 429/5xx/auth/permanent errors are classified, correlated and tested.

## Out of scope

Insights, post list UI and downloading Instagram video.

## UI and content notes

There is no dedicated screen. Any surfaced state or error uses the canonical terminology and safe redacted detail defined by the parent capability.

## Implementation notes

Use official API only and pinned API version. Store raw payload in restricted JSONB but expose normalised fields.

## Data and permissions

Account credential decrypts only in adapter; posts belong to account/workspace. Raw captions/payloads are not logged.

## Test notes

* Paginated adapter fixtures including duplicate/unknown/deleted media.
* Real-PostgreSQL idempotent upsert/checkpoint/crash tests.
* Credential/cross-account negative tests.

## Dependencies

Blocked by:

* {{ISSUE:instagram-oauth}} Implement Instagram connection callback and encrypted credential storage
* {{ISSUE:jobs-policy}} Implement logical job states, leases, retries and idempotent handler framework

Blocks:

* {{ISSUE:sync-insights}} Import supported insights as immutable metric snapshots
* {{ISSUE:sync-orchestration}} Deliver manual, incremental and scheduled sync orchestration
* {{ISSUE:posts-list}} Deliver the imported posts triage list
