Backlog metadata — Priority: P1 · Size: M · Product area: Launch readiness · Target release: v1.0-internal · Parent capability: {{ISSUE:cap-launch}} [Capability] Testing, deployment and launch readiness

## Outcome

The critical path from private source upload through validation, context revision, queued Gemini analysis, structured review, invalid-output recovery and versioned reanalysis is reproducibly tested.

## Context

This issue delivers one implementation outcome within [Capability] Testing, deployment and launch readiness and follows the versioned product/technical contracts.

Relevant documentation:

* `docs/technical/testing-strategy.md`
* `docs/technical/ai-analysis-contract.md`
* `docs/technical/video-ingestion.md`

## Scope

* Add deterministic browser/storage/Gemini fake journey for upload progress/ready, transcript save, analyse/status/result/history.
* Inject corrupt asset, upload interruption, Gemini 429, invalid semantic output, worker crash and failed reanalysis.
* Add one controlled paid-Gemini staging smoke with rights-cleared representative video and cleanup verification.
* Verify object/provider cleanup and one-analysis idempotency.

## Acceptance criteria

- [ ] Happy path publishes one validated analysis with exact input/version/usage metadata and review UI.
- [ ] Interrupted multipart resumes; corrupt media is rejected; duplicate Analyse creates one job/result.
- [ ] Invalid output never publishes; allowed repair/retry and manual state are correct.
- [ ] Failed reanalysis preserves old current; successful reanalysis adds history/activates new.
- [ ] Gemini temporary file is deleted/reconciled and no signed URL/content appears in logs.
- [ ] Mobile/keyboard/axe and cross-post/crafted-ID checks pass.
- [ ] CI fake and staging paid smoke evidence meet documented thresholds.

## Out of scope

Bulk account reanalysis and exact prose snapshot tests.

## UI and content notes

There is no dedicated screen. Any surfaced state or error uses the canonical terminology and safe redacted detail defined by the parent capability.

## Implementation notes

Live smoke is cost-bounded/manual. Inject crashes at provider/commit boundaries in integration tests.

## Data and permissions

Use rights-cleared restricted test video and paid project; clean object/provider copies per test policy.

## Test notes

* Playwright fake journey.
* Handler crash/retry/idempotency integration suite.
* Paid staging evaluation smoke and redaction scan.

## Dependencies

Blocked by:

* {{ISSUE:analysis-history-ui}} Deliver analysis history, stale state, reanalysis and failure recovery UX
* {{ISSUE:jobs-reconcile}} Add cancellation, manual retry and background reconciliation
* {{ISSUE:security-authz-abuse}} Complete negative authorisation, crafted-identifier and API-abuse controls

Blocks:

* {{ISSUE:acceptance-a11y}} Complete cross-browser, mobile, accessibility and Studio Parallel acceptance
