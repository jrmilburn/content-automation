Backlog metadata — Priority: P0 · Size: S · Product area: Product foundation · Target release: v1.0-internal · Parent capability: {{ISSUE:cap-foundation}} [Capability] Product foundation and technical architecture

## Outcome

Studio Parallel and engineering have an explicit, recorded decision baseline for v1 scope, evidence language, primary workflow, architecture and the open choices that affect implementation.

## Context

This issue delivers one implementation outcome within [Capability] Product foundation and technical architecture and follows the versioned product/technical contracts.

Relevant documentation:

* `docs/product/v1-product-definition.md`
* `docs/product/terminology.md`
* `docs/product/user-journeys.md`
* `docs/design/screen-map.md`
* `docs/technical/architecture.md`

## Scope

* Review every planning document with product/engineering owners.
* Resolve or assign owners/dates to account ownership, primary metric, upload/retention, authentication, deployment and Gemini data-term questions.
* Record accepted decisions or targeted document changes; mark material changes before dependent work starts.

## Acceptance criteria

- [ ] A named product and engineering owner approve the v1 outcome, exclusions and terminology.
- [ ] Every open question is resolved or has an owner, due date and non-blocking fallback.
- [ ] The selected Meta account/app ownership and Gemini paid-project owner are identified.
- [ ] No document describes public SaaS, scraping, causal algorithm claims or multi-agent processing.
- [ ] Decision changes are reflected consistently in all directly affected documents.

## Out of scope

Application implementation and provider production configuration.

## UI and content notes

There is no dedicated screen. Any surfaced state or error uses the canonical terminology and safe redacted detail defined by the parent capability.

## Implementation notes

Treat this as the scope lock for dependent foundation work; a later material change must update architecture, data contracts and impacted issues.

## Data and permissions

Review may reference internal account/provider ownership but must not place tokens, secrets or sensitive sample content in GitHub.

## Test notes

* Perform a documentation link/terminology consistency review.
* Manually verify exclusions, one-video pipeline and retrieval-based strategy across documents.

## Dependencies

Blocked by:

* None

Blocks:

* {{ISSUE:foundation-scaffold}} Scaffold the TypeScript web and worker workspace
* {{ISSUE:instagram-contract}} Prove Meta app, account, permissions and current API contract
* {{ISSUE:analysis-contract}} Define and evaluate the v1 analysis schema, taxonomy and prompt
