Backlog metadata — Priority: P0 · Size: L · Product area: Video analysis · Target release: v1.0-internal · Parent capability: {{ISSUE:cap-video-analysis}} [Capability] Gemini per-video analysis

## Outcome

V1 has an immutable, provider-compatible structured analysis contract and prompt that covers spoken, visual, hook, format, delivery, editing, CTA, strengths/weaknesses/improvements and field confidence without false precision.

## Context

This issue delivers one implementation outcome within [Capability] Gemini per-video analysis and follows the versioned product/technical contracts.

Relevant documentation:

* `docs/technical/ai-analysis-contract.md`
* `docs/product/terminology.md`

## Scope

* Implement canonical Zod schema, generated supported JSON Schema subset, controlled enums and observation/evidence/confidence wrappers.
* Implement semantic validators for times, sections, counts, CTA consistency, lengths, estimation basis and causal/algorithm language.
* Create immutable AnalysisSchemaVersion and PromptVersion records/artifacts with hashes/lifecycle.
* Draft prompt that treats video/transcript as untrusted data and uses unknown/limitations.

## Acceptance criteria

- [ ] Every product-required analysis field is represented with availability, basis, confidence/evidence where model-derived.
- [ ] Cut/shot/setup/visual timing fields require estimated basis and can be unknown.
- [ ] JSON Schema is accepted by the pinned candidate API and Zod round-trip matches.
- [ ] Semantic tests reject out-of-duration time, inconsistent CTA/sections, implausible counts, unsafe lengths/HTML and algorithm claims.
- [ ] Schema/prompt versions/hashes are immutable and one active default is explicit.
- [ ] Taxonomy uses canonical terms and includes other/unknown rules.
- [ ] Gold fixture rubric and activation thresholds are documented.

## Out of scope

Calling Gemini, activating an analysis or analytics calculation.

## UI and content notes

There is no dedicated screen. Any surfaced state or error uses the canonical terminology and safe redacted detail defined by the parent capability.

## Implementation notes

Keep schema shallow enough for Gemini's supported subset; application semantic validation remains authoritative.

## Data and permissions

Prompt fixtures contain synthetic/rights-cleared content; no secrets or production transcripts.

## Test notes

* Large valid/invalid fixture suite including every enum/nullable branch.
* Provider schema acceptance smoke via adapter fake/live test.
* Prompt injection and causal-language negative tests.

## Dependencies

Blocked by:

* {{ISSUE:foundation-approval}} Confirm v1 product, terminology, screen map and architecture baseline
* {{ISSUE:foundation-ci}} Establish CI and automated test quality gates

Blocks:

* {{ISSUE:analysis-handler}} Process and transactionally publish one validated post analysis
* {{ISSUE:analysis-evaluation}} Create Gemini analysis fixtures, mocks and model acceptance evaluation
* {{ISSUE:strategy-contract}} Define the structured strategy and recommendation prompt contract
* {{ISSUE:operations-settings}} Deliver safe internal settings and version visibility
