Backlog metadata — Priority: P1 · Size: M · Product area: Video analysis · Target release: v1.0-internal · Parent capability: {{ISSUE:cap-video-analysis}} [Capability] Gemini per-video analysis

## Outcome

The system identifies stale analyses and lets an authorised user re-run a post against changed source, transcript, schema, prompt or model while preserving complete history and current data until success.

## Context

This issue delivers one implementation outcome within [Capability] Gemini per-video analysis and follows the versioned product/technical contracts.

Relevant documentation:

* `docs/technical/ai-analysis-contract.md`
* `docs/technical/data-model.md`

## Scope

* Implement current-versus-active version/staleness calculation and reanalysis eligibility.
* Create reanalysis command with reason/new signature and safe duplicate handling.
* Activate new analysis transactionally after validation; retain history and evidence references to older versions.
* Expose batch-needed counts without implementing automatic bulk reanalysis.

## Acceptance criteria

- [ ] Asset/transcript/schema/prompt/model change marks current analysis stale with explicit reason.
- [ ] Reanalysis creates a new immutable analysis signature/history entry and never overwrites old data.
- [ ] Failed/cancelled reanalysis leaves old current analysis selected.
- [ ] Successful activation triggers one analytics recalculation and historical strategy keeps old evidence ID.
- [ ] Manual retry of same signature does not create a new version; intentional force requires recorded nonce/reason policy.
- [ ] Authorisation/rate/cost guard and structured audit/logging apply.
- [ ] Version transition/idempotency/failure tests pass.

## Out of scope

Automatic account-wide reanalysis, schema editor UI and deleting historical evidence.

## UI and content notes

There is no dedicated screen. Any surfaced state or error uses the canonical terminology and safe redacted detail defined by the parent capability.

## Implementation notes

Current is an explicit pointer, not max(created_at). Schema lifecycle retirement never invalidates referenced history.

## Data and permissions

Same workspace only; historical derived content retention follows approved policy.

## Test notes

* Staleness matrix for every input/version change.
* Failed/success activation and evidence-reference tests.
* Duplicate/forced/unauthorised reanalysis tests.

## Dependencies

Blocked by:

* {{ISSUE:analysis-handler}} Process and transactionally publish one validated post analysis
* {{ISSUE:jobs-reconcile}} Add cancellation, manual retry and background reconciliation

Blocks:

* {{ISSUE:analysis-history-ui}} Deliver analysis history, stale state, reanalysis and failure recovery UX
* {{ISSUE:operations-dashboard}} Deliver the manual-attention operations dashboard
