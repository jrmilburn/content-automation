Backlog metadata — Priority: P1 · Size: M · Product area: Launch readiness · Target release: v1.0-internal · Parent capability: {{ISSUE:cap-launch}} [Capability] Testing, deployment and launch readiness

## Outcome

The critical internal path from approved sign-in through account connection, paginated Reel/insight import, manual/incremental sync and failure recovery is reproducibly tested.

## Context

This issue delivers one implementation outcome within [Capability] Testing, deployment and launch readiness and follows the versioned product/technical contracts.

Relevant documentation:

* `docs/technical/testing-strategy.md`
* `docs/technical/instagram-integration.md`

## Scope

* Add deterministic Playwright/provider-fake journey including missing insights, pagination, duplicate import, 429 and expired-token reconnect.
* Add controlled staging smoke against authorised Meta account/API version with sanitised evidence.
* Verify post list/sync history/dashboard updates and refresh-safe behaviour.
* Document unavoidable live-test/manual steps.

## Acceptance criteria

- [ ] Happy path imports expected posts/snapshots exactly once and exposes unavailable metrics correctly.
- [ ] Manual/incremental repeat remains idempotent and preserves snapshot history.
- [ ] 429 retries/reschedules and expired token leads to reconnect then resume.
- [ ] Loading/empty/partial/error states and 390px/keyboard/axe checks pass.
- [ ] Cross-workspace/crafted provider/post/run actions are covered.
- [ ] Live smoke records API version/scopes/result without token/content leakage.
- [ ] CI fake journey is stable and staging live test is a release gate.

## Out of scope

Continuous production API probing and other social networks.

## UI and content notes

There is no dedicated screen. Any surfaced state or error uses the canonical terminology and safe redacted detail defined by the parent capability.

## Implementation notes

Use fake adapters in CI; live test is manual/release secret-gated and rate limited.

## Data and permissions

Live test uses authorised account and sanitised assertions; no token/caption/raw payload artifact.

## Test notes

* Playwright CI journey.
* Meta staging contract smoke.
* Negative authorisation and retry assertions.

## Dependencies

Blocked by:

* {{ISSUE:sync-history}} Deliver sync history, detail and failure recovery
* {{ISSUE:instagram-account-ui}} Deliver Instagram account configuration and safe disconnection
* {{ISSUE:security-authz-abuse}} Complete negative authorisation, crafted-identifier and API-abuse controls

Blocks:

* {{ISSUE:acceptance-a11y}} Complete cross-browser, mobile, accessibility and Studio Parallel acceptance
