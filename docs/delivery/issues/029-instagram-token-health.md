Backlog metadata — Priority: P0 · Size: M · Product area: Instagram integration · Target release: v1.0-internal · Parent capability: {{ISSUE:cap-instagram-connection}} [Capability] Instagram account integration

## Outcome

The system monitors granted scopes and token expiry/revocation, refreshes safely when the selected Meta flow permits, and guides users to reconnect before sync data silently becomes stale.

## Context

This issue delivers one implementation outcome within [Capability] Instagram account integration and follows the versioned product/technical contracts.

Relevant documentation:

* `docs/technical/instagram-integration.md`
* `docs/technical/background-jobs.md`

## Scope

* Add token validation/refresh adapter and expiry-aware maintenance job.
* Serialize refresh per credential and atomically rotate encrypted value/metadata.
* Classify expired, revoked, permission-changed, transient and unsupported-refresh states.
* Expose safe health/reconnect signals and stop provider jobs when reauthorisation is required.

## Acceptance criteria

- [ ] Health uses returned expiry/debug/provider results, not an assumed permanent token.
- [ ] Two workers cannot refresh the same credential concurrently or overwrite a newer token.
- [ ] Transient refresh failures retry boundedly; revoked/invalid/missing-scope states stop sync and require reconnect.
- [ ] Reconnect replaces the active credential without losing imported history.
- [ ] Expiry warnings and last validation are observable without token display.
- [ ] Tokens/errors are redacted in logs and monitoring.
- [ ] Refresh/reconnect/revocation/fake-time tests pass.

## Out of scope

General secret management UI and unsupported manual token pasting.

## UI and content notes

There is no dedicated screen. Any surfaced state or error uses the canonical terminology and safe redacted detail defined by the parent capability.

## Implementation notes

The live contract issue defines the exact refresh endpoint/eligibility. Scheduled work uses domain jobs/idempotency.

## Data and permissions

Only service adapter can decrypt; UI sees status, scopes and dates. Purge superseded ciphertext per rotation policy.

## Test notes

* Adapter fixtures for success/429/5xx/revoked/scope downgrade.
* Concurrency/atomic rotation tests.
* Scheduled retry and reconnect integration tests.

## Dependencies

Blocked by:

* {{ISSUE:instagram-oauth}} Implement Instagram connection callback and encrypted credential storage
* {{ISSUE:jobs-policy}} Implement logical job states, leases, retries and idempotent handler framework

Blocks:

* {{ISSUE:instagram-account-ui}} Deliver Instagram account configuration and safe disconnection
* {{ISSUE:sync-orchestration}} Deliver manual, incremental and scheduled sync orchestration
* {{ISSUE:operations-dashboard}} Deliver the manual-attention operations dashboard
* {{ISSUE:operations-health}} Expose integration, storage and Gemini usage/cost health signals
