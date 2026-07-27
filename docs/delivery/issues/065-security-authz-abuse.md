Backlog metadata — Priority: P0 · Size: M · Product area: Security and privacy · Target release: v1.0-internal · Parent capability: {{ISSUE:cap-security}} [Capability] Security, privacy and data lifecycle

## Outcome

Every data/action/file/job route enforces server-side workspace ownership and sensitive paid/provider commands resist crafted IDs, CSRF/replay, duplicate clicks and abusive request rates.

## Context

This issue delivers one implementation outcome within [Capability] Security, privacy and data lifecycle and follows the versioned product/technical contracts.

Relevant documentation:

* `docs/technical/security-and-privacy.md`
* `docs/technical/testing-strategy.md`

## Scope

* Build route/action authorisation inventory and reusable negative test matrix for all entities.
* Apply rate/cooldown/daily-budget limits to OAuth, uploads, sync, analyse/reanalyse, strategy, retry and settings/deletion actions.
* Verify origin/CSRF, return URL, payload length/schema and non-enumerating 403/404 behaviour.
* Add security headers/CSP/CORS and prove no user URL SSRF path.

## Acceptance criteria

- [ ] Every listed route/action has same-workspace success plus unauthenticated, inactive, cross-workspace/crafted and relationship-mismatch tests.
- [ ] Paid/provider commands have documented per-user/workspace idempotency/rate/budget responses.
- [ ] OAuth/retry callbacks reject replay and state/origin violations.
- [ ] Unknown IDs do not reveal existence/timing/materially different detail.
- [ ] CSP/HSTS/frame/referrer/nosniff and exact storage CORS are verified in production-like environment.
- [ ] Oversized/malformed bodies and unsafe text/HTML fail safely.
- [ ] Security matrix runs in CI and has no uncovered P0 route.

## Out of scope

WAF/enterprise SOC controls and complex roles.

## UI and content notes

There is no dedicated screen. Any surfaced state or error uses the canonical terminology and safe redacted detail defined by the parent capability.

## Implementation notes

Derive workspace/actor from session; never accept object keys/workspace relationships from client. Rate limits complement idempotency.

## Data and permissions

Denied responses/logs contain safe IDs/error codes only and no resource metadata.

## Test notes

* Automated route/action negative matrix.
* CSRF/replay/rate/idempotency/security-header tests.
* Cross-workspace timing/non-enumeration spot checks.

## Dependencies

Blocked by:

* {{ISSUE:access-auth}} Implement Google Workspace sign-in and server-side workspace authorisation
* {{ISSUE:sync-orchestration}} Deliver manual, incremental and scheduled sync orchestration
* {{ISSUE:analysis-handler}} Process and transactionally publish one validated post analysis
* {{ISSUE:strategy-handler}} Generate, validate and preserve immutable strategy history

Blocks:

* {{ISSUE:security-review}} Complete pre-launch security and privacy review
* {{ISSUE:e2e-import}} Prove end-to-end Instagram connection, import and sync recovery
* {{ISSUE:e2e-analysis}} Prove end-to-end upload, transcript, analysis and reanalysis recovery
