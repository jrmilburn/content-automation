Backlog metadata — Priority: P1 · Size: M · Product area: Internal access · Target release: v1.0-internal · Parent capability: {{ISSUE:cap-access}} [Capability] Internal access and application shell

## Outcome

Signed-in users can reliably navigate the internal product on desktop and mobile with consistent loading, empty, error, not-found and session-expired states.

## Context

This issue delivers one implementation outcome within [Capability] Internal access and application shell and follows the versioned product/technical contracts.

Relevant documentation:

* `docs/design/design-principles.md`
* `docs/design/screen-map.md`

## Scope

* Implement primary/secondary navigation, page layout, session menu and active-route semantics.
* Create shared status badges, skeletons, error summary, empty/partial state and confirmation primitives.
* Add root error/not-found/unauthorised boundaries and responsive 390px navigation.
* Establish accessible typography, focus, colour/status and reduced-motion foundations.

## Acceptance criteria

- [ ] Only authenticated users render the internal shell.
- [ ] Primary routes match the approved screen map and use canonical terminology.
- [ ] Navigation and shared actions are keyboard-operable with visible focus and semantic landmarks.
- [ ] Status is never communicated by colour alone; async messages support polite live regions.
- [ ] At 390px no primary action is clipped and navigation remains usable.
- [ ] Session expiry returns to sign-in with safe context and no data flash.
- [ ] Component tests cover loading, empty, partial, error and mobile states.

## Out of scope

Feature screen contents and marketing/public navigation.

## UI and content notes

Information hierarchy prioritises current location, blocking alert and one primary action. Errors say what failed, whether data is safe and the next action. Mobile uses an accessible menu/sheet; preserve focus on close.

## Implementation notes

Use server-rendered authorisation boundaries and reusable design tokens/components without introducing a large design-system project.

## Data and permissions

Navigation never includes unauthorised resource names; client state must not cache secrets.

## Test notes

* RTL keyboard/focus/status tests.
* Playwright desktop/390px navigation and session-expiry smoke.
* Automated axe check.

## Dependencies

Blocked by:

* {{ISSUE:access-auth}} Implement Google Workspace sign-in and server-side workspace authorisation
* {{ISSUE:foundation-scaffold}} Scaffold the TypeScript web and worker workspace

Blocks:

* {{ISSUE:access-dashboard}} Deliver the internal setup and attention dashboard
* {{ISSUE:jobs-operations-ui}} Provide job list and diagnostic detail experience
* {{ISSUE:instagram-account-ui}} Deliver Instagram account configuration and safe disconnection
* {{ISSUE:posts-list}} Deliver the imported posts triage list
* {{ISSUE:sync-history}} Deliver sync history, detail and failure recovery
* {{ISSUE:source-editor}} Deliver source video association and transcript/context editor
* {{ISSUE:post-detail}} Build unified post detail with metrics, source and processing status
* {{ISSUE:trends-ui}} Deliver account trends dashboard and evidence detail
* {{ISSUE:strategy-ui}} Deliver evidence-first strategy generation and history experience
* {{ISSUE:operations-dashboard}} Deliver the manual-attention operations dashboard
* {{ISSUE:operations-settings}} Deliver safe internal settings and version visibility
