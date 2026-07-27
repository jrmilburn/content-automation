Backlog metadata — Priority: P1 · Size: M · Product area: Recommendations · Target release: v1.0-internal · Parent capability: {{ISSUE:cap-recommendations}} [Capability] Recommendation experience

## Outcome

Users can mark a recommendation proposed, selected, completed or dismissed and optionally link a completed item to the resulting imported post without implying causation.

## Context

This issue delivers one implementation outcome within [Capability] Recommendation experience and follows the versioned product/technical contracts.

Relevant documentation:

* `docs/technical/strategy-generation.md`
* `docs/product/user-journeys.md`

## Scope

* Implement validated status transition commands with actor/time and optional dismissal reason.
* Add completed-resulting-post association picker/command scoped to same Instagram account/workspace.
* Show lifecycle/history and resulting post on detail/strategy summaries.
* Feed status/reason/result link into future duplicate/context retrieval as non-performance context.

## Acceptance criteria

- [ ] Only documented state transitions are allowed; repeated command is idempotent and audited.
- [ ] Resulting post must be imported under the same account/workspace and can be unlinked/corrected per policy.
- [ ] UI wording says link closes a learning loop, not that recommendation caused results.
- [ ] Dismissal reason is optional/length-limited and never treated as model evidence.
- [ ] Loading/empty/no eligible posts/conflict/error states are clear and accessible.
- [ ] Non-authorised/crafted/cross-account post/recommendation IDs are denied.
- [ ] Transition/link/query/component tests pass.

## Out of scope

Automatic completion detection, publishing/scheduling and causal experiment attribution.

## UI and content notes

Primary action follows state (Select, Mark completed, Link post); dismiss is secondary. Confirmation explains evidence is historical/contextual.

## Implementation notes

Generated brief remains immutable; store lifecycle events separately and include resulting post only in later explicitly retrieved context.

## Data and permissions

Same workspace/account enforcement; actor/reason are internal. Deletion of linked post leaves an explicit tombstone.

## Test notes

* State-machine/idempotency/conflict tests.
* Cross-account/crafted-ID negative tests.
* Picker/empty/error/mobile/accessibility Playwright.

## Dependencies

Blocked by:

* {{ISSUE:recommendation-ui}} Deliver recommendation detail as an actionable evidence-linked video brief
* {{ISSUE:posts-list}} Deliver the imported posts triage list

Blocks:

* {{ISSUE:security-deletion}} Implement approved retention and full data-deletion workflows
* {{ISSUE:e2e-strategy}} Prove end-to-end analytics, strategy and recommendation evidence flow
