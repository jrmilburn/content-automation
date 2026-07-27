Backlog metadata — Priority: P1 · Size: L · Product area: Content ingestion · Target release: v1.0-internal · Parent capability: {{ISSUE:cap-content-ingestion}} [Capability] Video upload and transcript management

## Outcome

From an imported post, a user can upload/associate a validated source video and create versioned transcript, original script, audience, objective, notes and category tags as explicit analysis inputs.

## Context

This issue delivers one implementation outcome within [Capability] Video upload and transcript management and follows the versioned product/technical contracts.

Relevant documentation:

* `docs/technical/video-ingestion.md`
* `docs/product/user-journeys.md`
* `docs/design/screen-map.md`

## Scope

* Add Transcript revision/current-pointer schema and length/source/taxonomy validation.
* Build /posts/:id/source upload/validation status plus text/context editor with autosave or explicit save semantics.
* Activate one ready current asset only after validation; create transcript revisions on meaningful changes.
* Show analysis eligibility and stale-analysis consequence when inputs change.

## Acceptance criteria

- [ ] User can complete upload through ready association and save optional fields with canonical terminology.
- [ ] Transcript edits create a new revision/hash; historical revisions/analysis inputs do not mutate.
- [ ] User-supplied transcript/script are labelled and rendered strictly as text.
- [ ] No video, validating, rejected, ready, save conflict, validation and upload error states provide one next action.
- [ ] Cross-post asset/transcript IDs and crafted post IDs are denied server-side.
- [ ] Editor and upload controls remain usable at 390px, keyboard accessible and preserve focus/errors.
- [ ] Queries/commands/components/E2E fake flow have automated coverage.

## Out of scope

Model transcript generation, collaborative editing, automatic matching and analysis result editing.

## UI and content notes

Separate Source video, Transcript and Intent/context sections. Primary action changes from Upload to Save inputs to Analyse when eligible. Explain that source changes make prior analysis stale.

## Implementation notes

Analysis jobs capture exact asset/revision IDs and hashes. Keep provider CDN preview separate from durable source.

## Data and permissions

Video/text are private workspace content; signed playback/download requires fresh server authorisation. Text deletion handled by lifecycle issue.

## Test notes

* Revision/current-pointer/optimistic conflict integration tests.
* Cross-post/cross-workspace negative tests.
* Upload-to-ready/editor mobile/accessibility Playwright.

## Dependencies

Blocked by:

* {{ISSUE:asset-validation}} Validate uploaded video assets in an isolated worker
* {{ISSUE:posts-list}} Deliver the imported posts triage list
* {{ISSUE:access-shell}} Build the responsive accessible internal application shell

Blocks:

* {{ISSUE:asset-lifecycle}} Implement source asset replacement, transcript deletion and storage lifecycle
* {{ISSUE:analysis-handler}} Process and transactionally publish one validated post analysis
* {{ISSUE:post-detail}} Build unified post detail with metrics, source and processing status
