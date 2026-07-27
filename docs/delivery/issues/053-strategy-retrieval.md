Backlog metadata — Priority: P1 · Size: L · Product area: Content strategy · Target release: v1.0-internal · Parent capability: {{ISSUE:cap-strategy}} [Capability] Automated content strategy

## Outcome

A strategy request produces a bounded, reproducible and account-authorised evidence manifest containing relevant statistics, posts/analyses, counterexamples, recency, distributions, prior recommendations and limitations.

## Context

This issue delivers one implementation outcome within [Capability] Automated content strategy and follows the versioned product/technical contracts.

Relevant documentation:

* `docs/technical/strategy-generation.md`
* `docs/technical/data-model.md`

## Scope

* Implement eligibility/standard-versus-exploratory mode and request options.
* Build ranked retrieval categories/caps, deduplicate posts and enforce input/token budget.
* Persist immutable StrategyGeneration request plus typed StrategyEvidence manifest entries/reasons/ranks/canonical hash.
* Include recent strategy/recommendation fingerprints and data-quality summary without raw videos.

## Acceptance criteria

- [ ] Zero analyses returns no model job; below threshold creates only explicit exploratory eligibility.
- [ ] Manifest respects documented caps and includes positive, negative, counterexample, recent, relevant and limitation evidence when available.
- [ ] Every entry belongs to requested account/workspace and references immutable analysis/snapshot/statistic versions.
- [ ] Canonical ordering/hash is deterministic; retry uses identical manifest.
- [ ] Raw videos, credentials and all unbounded account history are absent.
- [ ] Removal/tombstone after freeze does not silently retarget an ID.
- [ ] Ranking/ownership/cap/dedup/token-budget fixtures pass.

## Out of scope

Calling Gemini, semantic search/vector database and global/external trend retrieval.

## UI and content notes

There is no dedicated screen. Any surfaced state or error uses the canonical terminology and safe redacted detail defined by the parent capability.

## Implementation notes

Use SQL/categorical/metric/recency retrieval at v1 scale. Store minimal prompt representation and exact IDs.

## Data and permissions

Only authorised account evidence is selected; sensitive text is minimised to fields needed by strategy prompt.

## Test notes

* Deterministic ranking/cap/dedup/hash unit tests.
* Cross-account/crafted request negative tests.
* Insufficient/tombstoned/missing-evidence fixtures.

## Dependencies

Blocked by:

* {{ISSUE:analytics-recalculation}} Publish versioned account analytics through a debounced recalculation job
* {{ISSUE:analysis-handler}} Process and transactionally publish one validated post analysis
* {{ISSUE:foundation-database}} Establish PostgreSQL, Prisma and workspace ownership foundation

Blocks:

* {{ISSUE:strategy-handler}} Generate, validate and preserve immutable strategy history
