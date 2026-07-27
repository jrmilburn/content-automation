Backlog metadata — Priority: P1 · Size: M · Product area: Video analysis · Target release: v1.0-internal · Parent capability: {{ISSUE:cap-video-analysis}} [Capability] Gemini per-video analysis

## Outcome

Schema, prompt and pinned-model changes can be assessed repeatably against representative rights-cleared videos before activation, with quality, unknown-use, cost and latency evidence.

## Context

This issue delivers one implementation outcome within [Capability] Gemini per-video analysis and follows the versioned product/technical contracts.

Relevant documentation:

* `docs/technical/testing-strategy.md`
* `docs/technical/ai-analysis-contract.md`

## Scope

* Assemble restricted gold set/rubric covering talking head, B-roll, rapid cuts, captions, no speech, poor quality, multiple CTA and transcript mismatch.
* Create sanitised mocked provider responses for deterministic CI and an opt-in paid live evaluation runner.
* Score schema/semantic pass, taxonomy agreement, timestamp tolerance, hallucination/unknown use, repeat variance and usage/cost.
* Produce activation report format and regression thresholds/owner approval.

## Acceptance criteria

- [ ] Fixture rights/retention/location are documented and no production confidential video enters public CI artifacts.
- [ ] CI mock suite covers valid, malformed, semantic, blocked and provider failure responses.
- [ ] Live runner is secret-gated/manual, cost-bounded and records exact schema/prompt/model hashes.
- [ ] Rubric distinguishes objective contract errors from editorial judgement.
- [ ] Candidate models are compared on the same fixture/input configuration.
- [ ] Activation cannot occur without threshold report and named approval.
- [ ] Evaluation outputs exclude video/prompt raw content from normal logs.

## Out of scope

Custom model training, automated prompt optimisation and public benchmark publication.

## UI and content notes

There is no dedicated screen. Any surfaced state or error uses the canonical terminology and safe redacted detail defined by the parent capability.

## Implementation notes

Assert invariants and reviewed labels, not exact prose. Store evaluation summary with version artifacts.

## Data and permissions

Gold video bucket is restricted/private; paid Gemini only; delete provider copies after each run.

## Test notes

* Self-test scoring with known fixtures.
* Cost budget/secret absence/cleanup failure tests.
* Repeatability sample manual review.

## Dependencies

Blocked by:

* {{ISSUE:gemini-adapter}} Integrate paid Gemini video file and model APIs with usage controls
* {{ISSUE:analysis-contract}} Define and evaluate the v1 analysis schema, taxonomy and prompt
* {{ISSUE:foundation-ci}} Establish CI and automated test quality gates

Blocks:

* None
