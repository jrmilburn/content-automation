Backlog metadata — Priority: P1 · Size: M · Product area: Recommendations · Target release: v1.0-internal · Parent capability: {{ISSUE:cap-recommendations}} [Capability] Recommendation experience

## Outcome

Each validated strategy recommendation is stored as an immutable actionable brief with typed evidence, experiment definition and a semantic fingerprint that informs future generation.

## Context

This issue delivers one implementation outcome within [Capability] Recommendation experience and follows the versioned product/technical contracts.

Relevant documentation:

* `docs/technical/strategy-generation.md`
* `docs/technical/data-model.md`

## Scope

* Add ContentRecommendation and RecommendationEvidence schema/repositories from validated strategy output.
* Persist pillar/topic/format/audience, hooks, structure, filming/editing/CTA, rationale, evidence class/limitations, creative leap and experiment fields.
* Compute canonical/semantic fingerprint and recent-idea retrieval representation.
* Enforce same strategy/account ownership and immutable generated content.

## Acceptance criteria

- [ ] Every recommendation has 3–5 hooks, complete actionable fields, experiment primary metric/window/minimum posts/decision rule and at least valid context/evidence.
- [ ] Recommendation evidence resolves only within the parent strategy manifest and preserves support/counterexample/limitation roles.
- [ ] Fingerprint is deterministic and insensitive to trivial formatting while retaining materially different ideas.
- [ ] Generated brief cannot mutate after publication; lifecycle state is separate mutable data.
- [ ] Missing/unsupported evidence or canonical metric prevents publication.
- [ ] Indexes support account/state/history/recent duplicate lookup.
- [ ] Schema/repository/fingerprint/ownership tests pass.

## Out of scope

Recommendation screen, status transitions, resulting-post linking and embeddings/vector store.

## UI and content notes

There is no dedicated screen. Any surfaced state or error uses the canonical terminology and safe redacted detail defined by the parent capability.

## Implementation notes

Use canonical normalisation first; optional local text similarity only if deterministic/tested. Do not claim fingerprint proves semantic identity.

## Data and permissions

Workspace/account-owned derived strategy content; no cross-account evidence or raw model response.

## Test notes

* Persistence/evidence constraint tests.
* Fingerprint duplicate/distinct fixtures.
* Cross-account/reference and immutability negative tests.

## Dependencies

Blocked by:

* {{ISSUE:strategy-handler}} Generate, validate and preserve immutable strategy history

Blocks:

* {{ISSUE:recommendation-ui}} Deliver recommendation detail as an actionable evidence-linked video brief
