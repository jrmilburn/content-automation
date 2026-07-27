Backlog metadata — Priority: P0 · Size: M · Product area: Security and privacy · Target release: v1.0-internal · Parent capability: {{ISSUE:cap-security}} [Capability] Security, privacy and data lifecycle

## Outcome

A named owner verifies the implemented threat controls, provider data settings, retention/deletion, recovery and residual risks before production internal launch.

## Context

This issue delivers one implementation outcome within [Capability] Security, privacy and data lifecycle and follows the versioned product/technical contracts.

Relevant documentation:

* `docs/technical/security-and-privacy.md`
* `docs/technical/deployment-and-operations.md`

## Scope

* Review data flow/threat model against implementation and route/storage/provider inventory.
* Verify Meta/Gemini/OIDC/database/storage scopes, paid Gemini terms/logging, regions/DPA and secret controls.
* Review negative authorisation, media sandbox, abuse/idempotency, deletion/restore, scans and incident runbooks evidence.
* Record residual risks, owners/expiry and launch recommendation.

## Acceptance criteria

- [ ] Security checklist has evidence links and named reviewer/date.
- [ ] Paid Gemini project and no voluntary prompt sharing/logging setting are verified; Meta scopes are least privilege.
- [ ] No unaccepted critical/high auth, credential, deletion, media-parser or dependency finding remains.
- [ ] Retention/derived-data/backups and deletion rehearsal are formally approved.
- [ ] Credential compromise and provider outage runbooks are exercised.
- [ ] Residual risks have explicit severity/owner/expiry and product wording where relevant.
- [ ] Launch recommendation is recorded and blocks launch on failed P0 items.

## Out of scope

External penetration-test certification and enterprise compliance attestation.

## UI and content notes

There is no dedicated screen. Any surfaced state or error uses the canonical terminology and safe redacted detail defined by the parent capability.

## Implementation notes

Review is evidence-based and cannot be self-satisfied solely by documentation. Material findings become linked implementation issues.

## Data and permissions

Review artifacts minimise secrets/content and remain internal; never publish test tokens or private video.

## Test notes

* Manual review plus rerun automated security/deletion/restore suites.
* Production-like header/storage/provider setting verification.

## Dependencies

Blocked by:

* {{ISSUE:security-secrets}} Harden secrets, credential encryption and logging redaction
* {{ISSUE:security-authz-abuse}} Complete negative authorisation, crafted-identifier and API-abuse controls
* {{ISSUE:security-deletion}} Implement approved retention and full data-deletion workflows
* {{ISSUE:security-supply-chain}} Add dependency, action, container and media-tool supply-chain controls
* {{ISSUE:operations-runbooks}} Create internal operating and failure-recovery runbooks

Blocks:

* {{ISSUE:launch-guide}} Complete operating guide, release blockers and internal launch sign-off
