Backlog metadata — Priority: P1 · Size: M · Product area: Launch readiness · Target release: v1.0-internal · Parent capability: {{ISSUE:cap-launch}} [Capability] Testing, deployment and launch readiness

## Outcome

Representative Studio Parallel users confirm the internal workflows and evidence language are useful, while critical screens pass supported browser, 390px mobile and accessibility basics.

## Context

This issue delivers one implementation outcome within [Capability] Testing, deployment and launch readiness and follows the versioned product/technical contracts.

Relevant documentation:

* `docs/technical/testing-strategy.md`
* `docs/design/design-principles.md`
* `docs/product/v1-product-definition.md`

## Scope

* Run full critical journey in current Chromium, Firefox and WebKit plus desktop/390px viewports.
* Perform keyboard-only, focus, screen-reader label/live state, 200% zoom, contrast and reduced-motion checks.
* Conduct scripted internal acceptance for setup, upload/analysis, trends, strategy, recommendations and recovery.
* Record defects as release blockers/non-blocking accepted limitations with owner.

## Acceptance criteria

- [ ] No critical action is clipped/unreachable at 390px or 200% zoom.
- [ ] Critical journeys complete by keyboard with logical focus and no severe automated axe issue.
- [ ] Charts have readable non-visual equivalents and status/confidence do not rely on colour.
- [ ] Browser-specific upload, playback, table and async polling issues are resolved or accepted non-blocking.
- [ ] Internal users validate canonical terminology, evidence/limitation clarity and recommendation actionability.
- [ ] No unresolved P0/severe accessibility issue remains.
- [ ] Signed acceptance notes name participants/date/environment/release.

## Out of scope

WCAG certification, native mobile app and public usability study.

## UI and content notes

There is no dedicated screen. Any surfaced state or error uses the canonical terminology and safe redacted detail defined by the parent capability.

## Implementation notes

Use production-like staged release and representative data, not live production secrets where avoidable.

## Data and permissions

Acceptance participants use authorised internal/staging content; screenshots/artifacts remain restricted and redacted.

## Test notes

* Full release Playwright browser matrix.
* Manual accessibility checklist.
* Scripted UAT with issue evidence.

## Dependencies

Blocked by:

* {{ISSUE:e2e-import}} Prove end-to-end Instagram connection, import and sync recovery
* {{ISSUE:e2e-analysis}} Prove end-to-end upload, transcript, analysis and reanalysis recovery
* {{ISSUE:e2e-strategy}} Prove end-to-end analytics, strategy and recommendation evidence flow

Blocks:

* {{ISSUE:launch-guide}} Complete operating guide, release blockers and internal launch sign-off
