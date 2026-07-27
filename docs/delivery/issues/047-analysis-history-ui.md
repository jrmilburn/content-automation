Backlog metadata — Priority: P1 · Size: M · Product area: Video analysis · Target release: v1.0-internal · Parent capability: {{ISSUE:cap-analysis-review}} [Capability] Analysis review and post detail

## Outcome

Users can distinguish the current validated analysis from older/failed attempts, understand why it is stale and safely request or monitor reanalysis.

## Context

This issue delivers one implementation outcome within [Capability] Analysis review and post detail and follows the versioned product/technical contracts.

Relevant documentation:

* `docs/product/user-journeys.md`
* `docs/technical/ai-analysis-contract.md`

## Scope

* Add history/version selector with analysed time, source/transcript/schema/prompt/model summary.
* Show stale reason and version difference before reanalysis confirmation.
* Wire reanalysis command to job progress/detail and failed-attention retry guidance.
* Keep older results read-only and clearly historical.

## Acceptance criteria

- [ ] Current validated result is never confused with latest failed attempt or older history.
- [ ] Stale message names changed input/version and explains old result remains until success.
- [ ] Duplicate reanalysis clicks resolve to one logical job and button/state updates accessibly.
- [ ] Failure screen shows safe error class/correlation and correct replace/retry/config action.
- [ ] Historical strategy evidence link can open the exact older analysis.
- [ ] Crafted history/job IDs are denied and do not enumerate.
- [ ] Mobile/keyboard/error/loading tests pass.

## Out of scope

Schema/prompt editing and automatic bulk reanalysis.

## UI and content notes

Primary action is Reanalyse only when eligible; confirmation states estimated cost/work and immutable history. Failure copy says existing analysis remains safe.

## Implementation notes

History query uses explicit current pointer and immutable result metadata, not job ordering.

## Data and permissions

Same-workspace only; versions may reference deleted input hashes/tombstones per policy without restoring deleted content.

## Test notes

* Version/current/stale query integration tests.
* Duplicate/failure/old-evidence navigation Playwright.
* Authorisation and accessibility tests.

## Dependencies

Blocked by:

* {{ISSUE:analysis-result-ui}} Present structured creative analysis with confidence and estimation labels
* {{ISSUE:analysis-reanalysis}} Support analysis version activation and safe reanalysis
* {{ISSUE:jobs-operations-ui}} Provide job list and diagnostic detail experience

Blocks:

* {{ISSUE:e2e-analysis}} Prove end-to-end upload, transcript, analysis and reanalysis recovery
