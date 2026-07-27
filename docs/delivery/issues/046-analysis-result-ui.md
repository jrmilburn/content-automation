Backlog metadata — Priority: P1 · Size: L · Product area: Video analysis · Target release: v1.0-internal · Parent capability: {{ISSUE:cap-analysis-review}} [Capability] Analysis review and post detail

## Outcome

Users can scan and inspect validated hook, content, structure, delivery, CTA, visual/editing, strengths, weaknesses and improvements while understanding provenance, estimated fields and model limitations.

## Context

This issue delivers one implementation outcome within [Capability] Analysis review and post detail and follows the versioned product/technical contracts.

Relevant documentation:

* `docs/technical/ai-analysis-contract.md`
* `docs/design/design-principles.md`

## Scope

* Build result sections/components from versioned analysis presenter.
* Show opening/hook/topic/pillar/format/presenter mode/audience/tone/pace/structure, CTA, talking-head/B-roll/text/captions, estimated cut/shot/setup/timing, audio/editing and improvements.
* Render observation availability/basis/field confidence/evidence timestamps and overall source-quality limitations.
* Expose model/schema/prompt/analysed metadata in progressive detail.

## Acceptance criteria

- [ ] All v1 contract fields have intentional available/unknown/not-applicable rendering.
- [ ] Estimated measurements are explicitly labelled and never formatted as exact ground truth.
- [ ] Model field confidence is visually/textually distinct from statistical evidence confidence.
- [ ] Timestamp evidence is keyboard accessible and can seek playback when an authorised asset is available.
- [ ] No raw JSON/unsafe HTML/model text injection is rendered.
- [ ] Partial unknowns do not hide useful sections; low source quality is prominent.
- [ ] Mobile, zoom, screen reader structure and automated component/E2E tests pass.

## Out of scope

Editing analysis output, performance causal claims and public share/export.

## UI and content notes

Lead with hook/content summary and actionable strengths/improvements; place technical metadata later. Use “Model observation” and “Estimated” wording, not certainty scores.

## Implementation notes

Presenter maps schema version to components or safe generic fallback for history. Sanitize/render text only.

## Data and permissions

Analysis is internal derived content; server authorises post/asset. Do not expose provider raw response or prompt.

## Test notes

* Presenter fixtures for full/partial/unknown/estimated/older schema.
* XSS/length/authorisation negative tests.
* Mobile/keyboard/axe and timestamp interaction tests.

## Dependencies

Blocked by:

* {{ISSUE:post-detail}} Build unified post detail with metrics, source and processing status
* {{ISSUE:analysis-handler}} Process and transactionally publish one validated post analysis

Blocks:

* {{ISSUE:analysis-history-ui}} Deliver analysis history, stale state, reanalysis and failure recovery UX
* {{ISSUE:trends-ui}} Deliver account trends dashboard and evidence detail
