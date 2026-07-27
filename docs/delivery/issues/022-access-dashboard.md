Backlog metadata — Priority: P1 · Size: M · Product area: Internal access · Target release: v1.0-internal · Parent capability: {{ISSUE:cap-access}} [Capability] Internal access and application shell

## Outcome

A Studio Parallel user lands on a clear operational summary that directs them to the highest-value setup, incomplete-data, failure and strategy action.

## Context

This issue delivers one implementation outcome within [Capability] Internal access and application shell and follows the versioned product/technical contracts.

Relevant documentation:

* `docs/design/screen-map.md`
* `docs/product/v1-product-definition.md`

## Scope

* Show account connection/sync health, posts missing source content, active/failed jobs, analysis coverage and current strategy/recommendation summary as data becomes available.
* Provide truthful setup/empty/partial states before downstream capabilities exist.
* Use authorised server-side summary queries and link to owning screens.
* Show last-updated/staleness and never block the whole page on one failing card.

## Acceptance criteria

- [ ] No-account state leads with Connect Instagram account.
- [ ] Partial downstream data renders available cards and names unavailable sections.
- [ ] Attention items are ordered by blocking/security/manual action before informational activity.
- [ ] Counts link to pre-filtered owning screens once those capabilities exist.
- [ ] Loading/error states are isolated per section and accessible.
- [ ] Desktop and 390px layouts preserve hierarchy and actions.
- [ ] Summary queries are workspace-scoped and tested.

## Out of scope

Detailed post, trend, strategy and job manipulation.

## UI and content notes

Hierarchy: blocking integration alert, manual attention, current strategy/next videos, coverage/recent performance, processing activity. Empty states teach the prerequisite and use canonical terms.

## Implementation notes

Use stable summary interfaces so downstream capabilities can fill cards incrementally; do not duplicate calculation logic in the UI.

## Data and permissions

Only aggregate safe metadata appears; no credentials, raw provider/model payloads or transcript/video content.

## Test notes

* Server query authorisation tests.
* Component tests for setup/partial/error/stale states.
* Mobile/keyboard/axe smoke.

## Dependencies

Blocked by:

* {{ISSUE:access-shell}} Build the responsive accessible internal application shell
* {{ISSUE:foundation-observability}} Add structured logging, correlation and error-monitoring foundations

Blocks:

* None
