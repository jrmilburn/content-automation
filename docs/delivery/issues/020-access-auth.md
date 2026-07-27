Backlog metadata — Priority: P0 · Size: L · Product area: Internal access · Target release: v1.0-internal · Parent capability: {{ISSUE:cap-access}} [Capability] Internal access and application shell

## Outcome

Only explicitly approved Studio Parallel identities can establish a session and every server action/query has a reusable, tested workspace authorisation boundary.

## Context

This issue delivers one implementation outcome within [Capability] Internal access and application shell and follows the versioned product/technical contracts.

Relevant documentation:

* `docs/technical/security-and-privacy.md`
* `docs/product/user-journeys.md`

## Scope

* Integrate Google OIDC through Auth.js with issuer/audience/nonce/state validation.
* Require approved domain plus active InternalUser allowlist; support deactivation and session expiry.
* Create server helpers for actor/workspace/resource loading and non-enumerating not-found responses.
* Protect return URLs, cookies, origins/CSRF and audit sign-in/security-relevant outcomes.

## Acceptance criteria

- [ ] Approved active user can sign in and receives only the seeded workspace.
- [ ] Unlisted, wrong-domain, inactive and malformed-claim identities are denied without data exposure.
- [ ] Session cookies are Secure/HttpOnly/SameSite with bounded lifetime and rotation.
- [ ] Crafted return URLs cannot redirect off-site.
- [ ] Server resource helper rejects missing/cross-workspace identifiers identically.
- [ ] Deactivation prevents new access and invalidates/limits existing sessions per documented policy.
- [ ] Negative authorisation and OIDC contract tests pass.

## Out of scope

Public registration, passwords, social sign-in choices and granular role administration.

## UI and content notes

There is no dedicated screen. Any surfaced state or error uses the canonical terminology and safe redacted detail defined by the parent capability.

## Implementation notes

Client route guards are convenience only; all data/actions reauthorise server-side.

## Data and permissions

Store stable OIDC subject, normalised email/display name and last login only; never persist ID/access tokens unnecessarily.

## Test notes

* OIDC success/failure/replay fixture tests.
* Session expiry/deactivation tests.
* Cross-workspace/crafted-ID integration matrix.

## Dependencies

Blocked by:

* {{ISSUE:foundation-database}} Establish PostgreSQL, Prisma and workspace ownership foundation
* {{ISSUE:foundation-observability}} Add structured logging, correlation and error-monitoring foundations

Blocks:

* {{ISSUE:access-shell}} Build the responsive accessible internal application shell
* {{ISSUE:instagram-oauth}} Implement Instagram connection callback and encrypted credential storage
* {{ISSUE:upload-storage}} Implement private object storage and signed multipart video upload
* {{ISSUE:security-authz-abuse}} Complete negative authorisation, crafted-identifier and API-abuse controls
