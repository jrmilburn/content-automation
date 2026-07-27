Backlog metadata — Priority: P1 · Size: L · Product area: Instagram integration · Target release: v1.0-internal · Parent capability: {{ISSUE:cap-instagram-sync}} [Capability] Instagram post and metric synchronisation

## Outcome

A user can find recent imported Reels and quickly identify missing source content, analysis state, metric availability and manual-attention work.

## Context

This issue delivers one implementation outcome within [Capability] Instagram post and metric synchronisation and follows the versioned product/technical contracts.

Relevant documentation:

* `docs/design/screen-map.md`
* `docs/product/user-journeys.md`

## Scope

* Build workspace/account-scoped paginated post query and /posts screen.
* Show thumbnail fallback, publication time, caption excerpt, Reel/product type, latest comparable metric summary and association/analysis/attention state.
* Add search plus date, media/product, source, analysis and attention filters with URL state.
* Link rows/cards to post detail and preserve filters on return.

## Acceptance criteria

- [ ] Loading, no account, no posts, no filter matches, partial metrics, provider-thumbnail failure and query error are distinct.
- [ ] Unavailable metrics display Unavailable/Not captured, never 0.
- [ ] Pagination/filter/sort are server-bounded and stable under new imports.
- [ ] Crafted account/post/filter values do not leak other workspace data.
- [ ] Keyboard/screen-reader row actions and visible focus work; table/card meaning is preserved at 390px.
- [ ] Provider thumbnail URL failure uses safe fallback and does not block the list.
- [ ] Query/component/Playwright tests cover primary and edge states.

## Out of scope

Post detail, upload, analysis editing and bulk actions.

## UI and content notes

Lead with post identity/date and attention status; secondary metrics must name denominator/snapshot age. Primary action is the missing prerequisite (upload, retry, review).

## Implementation notes

Use canonical state/metric presenters and authorised server queries; do not calculate analytics in React.

## Data and permissions

Captions/thumbnails are internal and rendered as text/private provider reference; no raw payload or credential.

## Test notes

* Query/filter/pagination/authorisation integration tests.
* Loading/empty/error/unavailable component tests.
* Desktop/mobile keyboard/axe Playwright.

## Dependencies

Blocked by:

* {{ISSUE:sync-media}} Import Instagram media with pagination and Reel classification
* {{ISSUE:access-shell}} Build the responsive accessible internal application shell

Blocks:

* {{ISSUE:source-editor}} Deliver source video association and transcript/context editor
* {{ISSUE:recommendation-workflow}} Implement recommendation status and resulting-post learning loop
