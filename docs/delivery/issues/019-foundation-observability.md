Backlog metadata — Priority: P0 · Size: M · Product area: Internal operations · Target release: v1.0-internal · Parent capability: {{ISSUE:cap-foundation}} [Capability] Product foundation and technical architecture

## Outcome

Web and worker operations emit correlated, structured and redacted diagnostics and errors suitable for internal recovery without leaking tokens or source content.

## Context

This issue delivers one implementation outcome within [Capability] Product foundation and technical architecture and follows the versioned product/technical contracts.

Relevant documentation:

* `docs/technical/architecture.md`
* `docs/technical/security-and-privacy.md`
* `docs/technical/deployment-and-operations.md`

## Scope

* Implement JSON logger/event conventions and request-to-job correlation IDs.
* Integrate environment-separated error monitoring behind a shared adapter.
* Add allowlist-based redaction and safe error classes.
* Expose liveness/readiness skeletons and basic web/worker metrics hooks.

## Acceptance criteria

- [ ] Web request, domain command and worker event can share one correlation ID.
- [ ] Logs include service/release/environment/event/stage and safe resource IDs.
- [ ] Token, cookie, signed-URL, transcript/video/prompt canary values are redacted or never collected.
- [ ] Expected validation/user errors do not create noisy unhandled exceptions.
- [ ] Error monitoring separates environments and records release identifiers.
- [ ] Health output contains no secret/config values.

## Out of scope

Provider-specific dashboards, alert thresholds and production incident verification.

## UI and content notes

There is no dedicated screen. Any surfaced state or error uses the canonical terminology and safe redacted detail defined by the parent capability.

## Implementation notes

Use allowlisted fields and structured errors; never attach raw request/provider/model bodies by default.

## Data and permissions

Log access is operationally restricted; sensitive bodies and secrets are forbidden.

## Test notes

* Logger schema and correlation propagation unit tests.
* Redaction canary tests for headers, URLs and nested errors.
* Error-monitoring adapter fake tests.

## Dependencies

Blocked by:

* {{ISSUE:foundation-scaffold}} Scaffold the TypeScript web and worker workspace
* {{ISSUE:foundation-database}} Establish PostgreSQL, Prisma and workspace ownership foundation

Blocks:

* {{ISSUE:access-auth}} Implement Google Workspace sign-in and server-side workspace authorisation
* {{ISSUE:access-dashboard}} Deliver the internal setup and attention dashboard
* {{ISSUE:jobs-queue}} Implement the PostgreSQL-backed queue and transactional dispatch
* {{ISSUE:instagram-oauth}} Implement Instagram connection callback and encrypted credential storage
* {{ISSUE:upload-storage}} Implement private object storage and signed multipart video upload
* {{ISSUE:gemini-adapter}} Integrate paid Gemini video file and model APIs with usage controls
* {{ISSUE:operations-health}} Expose integration, storage and Gemini usage/cost health signals
* {{ISSUE:security-secrets}} Harden secrets, credential encryption and logging redaction
* {{ISSUE:deployment-pipeline}} Provision staging/production and implement the safe deployment pipeline
