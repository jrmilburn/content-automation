Backlog metadata — Priority: P0 · Size: L · Product area: Instagram integration · Target release: v1.0-internal · Parent capability: {{ISSUE:cap-instagram-connection}} [Capability] Instagram account integration

## Outcome

An authorised admin can complete the selected Meta OAuth flow and the server activates exactly one verified professional account with encrypted, least-privilege credential material.

## Context

This issue delivers one implementation outcome within [Capability] Instagram account integration and follows the versioned product/technical contracts.

Relevant documentation:

* `docs/technical/instagram-integration.md`
* `docs/technical/security-and-privacy.md`
* `docs/technical/data-model.md`

## Scope

* Create connection initiation/callback with state, PKCE where supported, one-time expiry and exact redirect validation.
* Exchange/validate token server-side; retrieve identity/account type/scopes/expiry and reject ineligible or scope-downgraded results.
* Add InstagramAccount and envelope-encrypted IntegrationCredential schema/repositories.
* Audit activation/failure and queue a bootstrap sync hook without exposing token material.

## Acceptance criteria

- [ ] Valid authorised Business/Creator connection creates one account/active encrypted credential idempotently.
- [ ] State mismatch/replay/expiry, cancelled consent, wrong account type, missing scope and duplicate account fail safely.
- [ ] Plaintext tokens never persist, log, render or enter client code; key version is recorded.
- [ ] Account/credential uniqueness and transaction prevent partial active connections.
- [ ] Callback uses exact allowlisted return location and non-enumerating errors.
- [ ] Connection is restricted to authorised admin and rate-limited.
- [ ] OAuth/encryption/negative/cross-workspace tests pass.

## Out of scope

Token refresh, disconnect UI and post import.

## UI and content notes

There is no dedicated screen. Any surfaced state or error uses the canonical terminology and safe redacted detail defined by the parent capability.

## Implementation notes

Treat provider token response/debug data as authoritative; do not hard-code permanence. Use KMS/master-key envelope encryption.

## Data and permissions

Credential ciphertext is highly sensitive, excluded from default selects/backups without DB controls; account metadata belongs to workspace.

## Test notes

* OAuth contract fixtures and replay/security tests.
* Encryption round-trip/key-version and no-plaintext persistence test.
* Concurrent duplicate callback integration test.

## Dependencies

Blocked by:

* {{ISSUE:instagram-contract}} Prove Meta app, account, permissions and current API contract
* {{ISSUE:access-auth}} Implement Google Workspace sign-in and server-side workspace authorisation
* {{ISSUE:foundation-database}} Establish PostgreSQL, Prisma and workspace ownership foundation
* {{ISSUE:foundation-observability}} Add structured logging, correlation and error-monitoring foundations

Blocks:

* {{ISSUE:instagram-token-health}} Implement Instagram token health, refresh and reconnect handling
* {{ISSUE:instagram-account-ui}} Deliver Instagram account configuration and safe disconnection
* {{ISSUE:sync-media}} Import Instagram media with pagination and Reel classification
* {{ISSUE:security-secrets}} Harden secrets, credential encryption and logging redaction
