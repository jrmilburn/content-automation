Backlog metadata — Priority: P1 · Size: L · Product area: Content strategy · Target release: v1.0-internal · Parent capability: {{ISSUE:cap-strategy}} [Capability] Automated content strategy

## Outcome

Strategy generation has an immutable provider-compatible schema/prompt that returns evidence-scoped claims, pillar allocation, experiments and actionable recommendations while preserving confidence and non-causal language.

## Context

This issue delivers one implementation outcome within [Capability] Automated content strategy and follows the versioned product/technical contracts.

Relevant documentation:

* `docs/technical/strategy-generation.md`
* `docs/product/terminology.md`

## Scope

* Implement Zod/generated JSON Schema for evidence refs, claims, working/weak patterns, tests, allocations, recommendations and limitations.
* Implement semantic validators for evidence membership/support, confidence ceiling, allocations, canonical metrics/windows, duplicates and prohibited causal/algorithm phrases.
* Create versioned strategy PromptVersion/schema lifecycle and exploratory-mode instructions.
* Add synthetic manifest/output fixtures including counterevidence and insufficient samples.

## Acceptance criteria

- [ ] Every empirical claim/recommendation carries manifest-local evidence refs and canonical evidence class.
- [ ] Model cannot upgrade stored statistic confidence or cite outside manifest.
- [ ] Pillar allocations total exactly 100; experimental allocation is labelled under exploratory mode.
- [ ] Recommendations contain 3–5 hooks, structure, filming/editing/CTA, rationale, evidence, creative leap where applicable and a testable experiment.
- [ ] Validators reject unsupported values, duplicate hooks/ideas, omitted relevant limitation and causal/algorithm claims.
- [ ] Schema/prompt hashes are immutable and compatible with pinned model API.
- [ ] Contract/semantic/prompt-injection fixtures pass.

## Out of scope

Evidence selection, provider call, recommendation status workflow and automatic execution.

## UI and content notes

There is no dedicated screen. Any surfaced state or error uses the canonical terminology and safe redacted detail defined by the parent capability.

## Implementation notes

Use structured output, not function calling. Treat evidence text as untrusted data and maintain a shallow provider-supported schema.

## Data and permissions

Fixtures are synthetic; prompt never includes credentials or raw account video/content beyond bounded evidence.

## Test notes

* Valid/invalid contract fixture matrix.
* Evidence support/confidence/causal/duplicate/allocation semantic tests.
* Provider schema acceptance smoke.

## Dependencies

Blocked by:

* {{ISSUE:analysis-contract}} Define and evaluate the v1 analysis schema, taxonomy and prompt
* {{ISSUE:foundation-ci}} Establish CI and automated test quality gates

Blocks:

* {{ISSUE:strategy-handler}} Generate, validate and preserve immutable strategy history
* {{ISSUE:operations-settings}} Deliver safe internal settings and version visibility
