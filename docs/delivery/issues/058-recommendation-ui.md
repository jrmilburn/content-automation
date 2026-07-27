Backlog metadata — Priority: P1 · Size: L · Product area: Recommendations · Target release: v1.0-internal · Parent capability: {{ISSUE:cap-recommendations}} [Capability] Recommendation experience

## Outcome

A user can open a recommended next video and act on its pillar, topic, audience, multiple hooks, structure, filming/editing approach, CTA, experiment, rationale, evidence strength and limitations.

## Context

This issue delivers one implementation outcome within [Capability] Recommendation experience and follows the versioned product/technical contracts.

Relevant documentation:

* `docs/design/screen-map.md`
* `docs/technical/strategy-generation.md`

## Scope

* Build /recommendations/:id detail and links from strategy.
* Present production brief sections and experiment card with canonical metric/observation window.
* Render support/counterevidence/limitations and model-generated creative-leap label.
* Provide copy-friendly interactions without public share links and with lifecycle action placeholders.

## Acceptance criteria

- [ ] All recommendation contract fields have intentional rendering and 3–5 hook options remain distinguishable.
- [ ] Evidence refs open exact authorised trend/post/analysis; tombstones remain explicit.
- [ ] Creative proposal is visually/textually distinct from measured/statistical evidence.
- [ ] Experiment states hypothesis, changed/held variables, metric/window/minimum posts and decision rule.
- [ ] Loading, unavailable evidence, incomplete legacy schema, not-found and error states are usable.
- [ ] Copy/actions, headings/lists and focus work by keyboard; 390px/zoom/axe pass.
- [ ] Crafted recommendation/evidence IDs do not leak data.

## Out of scope

Editing/generated video, automatic publishing and public sharing.

## UI and content notes

Lead with title/pillar and why now, then hook options/structure, filming/editing/CTA, experiment, evidence and limitations. Primary action is Select when workflow lands.

## Implementation notes

Render through version-aware presenter and plain text only; do not recompute confidence.

## Data and permissions

Internal derived content and linked account evidence require server authorisation.

## Test notes

* Presenter/full/partial/tombstone component fixtures.
* Authorisation/XSS negative tests.
* Mobile/keyboard/copy/axe Playwright.

## Dependencies

Blocked by:

* {{ISSUE:recommendation-model}} Persist actionable recommendations, evidence and duplicate fingerprints
* {{ISSUE:strategy-ui}} Deliver evidence-first strategy generation and history experience

Blocks:

* {{ISSUE:recommendation-workflow}} Implement recommendation status and resulting-post learning loop
