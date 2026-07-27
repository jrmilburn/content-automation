Backlog metadata — Priority: P0 · Size: M · Product area: Security and privacy · Target release: v1.0-internal · Parent capability: {{ISSUE:cap-security}} [Capability] Security, privacy and data lifecycle

## Outcome

Production secrets and credentials are least-privilege, environment-separated, rotatable and absent from client bundles, database plaintext, logs, error monitoring, CI artifacts and settings UI.

## Context

This issue delivers one implementation outcome within [Capability] Security, privacy and data lifecycle and follows the versioned product/technical contracts.

Relevant documentation:

* `docs/technical/security-and-privacy.md`

## Scope

* Configure deployment secret-manager contract and separate environment/provider identities.
* Complete envelope-encryption key version/rotation and restricted credential repository paths.
* Apply allowlist logging/error/request redaction across web, worker and adapters.
* Add secret scanning/push protection guidance and rotation/compromise procedure hooks.

## Acceptance criteria

- [ ] Repository/history/client bundles/test artifacts contain no real secrets and CI secret scan passes.
- [ ] Meta tokens are encrypted at rest and only adapter/service path can decrypt; key rotation is tested.
- [ ] Gemini/OIDC/storage/database secrets are environment-isolated and least-privilege.
- [ ] Canary token, cookie, Authorization, signed URL and nested provider error never reaches logs/monitoring.
- [ ] Settings/health expose status/fingerprint/dates only.
- [ ] Compromise rotation/revocation procedure is rehearsed without content loss.
- [ ] Automated redaction/encryption/secret-absence tests pass.

## Out of scope

Enterprise HSM certification and user-managed keys.

## UI and content notes

There is no dedicated screen. Any surfaced state or error uses the canonical terminology and safe redacted detail defined by the parent capability.

## Implementation notes

Allowlist log fields; secret redaction is defence in depth. Prefer workload identity/short-lived credentials where provider supports.

## Data and permissions

Credential material is highly sensitive; backup/database access does not imply encryption-key access.

## Test notes

* Encryption/key rotation/access-path integration tests.
* Log/error/client bundle canary scans.
* Environment separation and revoked credential smoke.

## Dependencies

Blocked by:

* {{ISSUE:foundation-observability}} Add structured logging, correlation and error-monitoring foundations
* {{ISSUE:instagram-oauth}} Implement Instagram connection callback and encrypted credential storage
* {{ISSUE:gemini-adapter}} Integrate paid Gemini video file and model APIs with usage controls
* {{ISSUE:upload-storage}} Implement private object storage and signed multipart video upload

Blocks:

* {{ISSUE:security-review}} Complete pre-launch security and privacy review
