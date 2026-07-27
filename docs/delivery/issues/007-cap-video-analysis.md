Backlog metadata — Priority: P0 · Size: L · Product area: Video analysis · Target release: v1.0-internal · Parent capability: {{ISSUE:project-v1}} [Project] Studio Parallel Instagram content intelligence v1

## Outcome

Each eligible post can produce one immutable, validated, versioned creative analysis from one Gemini video request, with controlled retries, provenance, confidence and measured usage.

## Context

This capability coordinates a coherent v1 delivery area and rolls up its implementation issues.

Relevant documentation:

* `docs/technical/ai-analysis-contract.md`
* `docs/technical/video-ingestion.md`
* `docs/technical/background-jobs.md`

## Scope

* Paid Gemini file/model adapter and temporary-file lifecycle.
* Versioned analysis schema, controlled taxonomy and prompt.
* Worker handler with syntactic/semantic validation and transactional activation.
* Reanalysis/version lifecycle and gold-fixture evaluation.

Child issues:

- [ ] {{ISSUE:gemini-adapter}} {{TITLE:gemini-adapter}}
- [ ] {{ISSUE:analysis-contract}} {{TITLE:analysis-contract}}
- [ ] {{ISSUE:analysis-handler}} {{TITLE:analysis-handler}}
- [ ] {{ISSUE:analysis-reanalysis}} {{TITLE:analysis-reanalysis}}
- [ ] {{ISSUE:analysis-evaluation}} {{TITLE:analysis-evaluation}}

## Acceptance criteria

- [ ] Every child issue is complete with its automated tests and relevant documentation updates.
- [ ] Cross-child success, missing-data/failure and server-authorisation paths behave consistently.
- [ ] User-facing work meets responsive and accessibility requirements where applicable.
- [ ] Integration/background work exposes structured diagnostics without sensitive content.
- [ ] No child exceeds v1 scope or weakens the documented evidence/data-integrity boundaries.

## Out of scope

Account-wide raw-video prompts, model-controlled tools/database writes, custom training and persistent per-post agents.

## Implementation notes

Child issues own implementation detail. Shared contracts, state machines, versioning, idempotency and evidence references must follow the linked documentation.

## Data and permissions

Workspace ownership is enforced server-side. Sensitive fields, retention/deletion effects and crafted-identifier negative cases are defined in child issues and remain capability acceptance gates.

## Test notes

Capability closure requires integrated child tests plus the relevant critical journey or operational proof; test-only work does not substitute for outcome acceptance.

## Dependencies

Blocked by:

* {{ISSUE:cap-content-ingestion}} [Capability] Video upload and transcript management
* {{ISSUE:cap-background-jobs}} [Capability] Background processing and job reliability

Blocks:

* {{ISSUE:cap-analysis-review}} [Capability] Analysis review and post detail
* {{ISSUE:cap-analytics}} [Capability] Account analytics and trend calculation
* {{ISSUE:cap-strategy}} [Capability] Automated content strategy
* {{ISSUE:cap-operations}} [Capability] Internal operations and failure recovery
