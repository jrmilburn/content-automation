Backlog metadata — Priority: P0 · Size: M · Product area: Launch readiness · Target release: v1.0-internal · Parent capability: {{ISSUE:cap-foundation}} [Capability] Product foundation and technical architecture

## Outcome

Every change is checked consistently for build quality, real-database integration, critical UI behaviour and dependency/secret risks before merge.

## Context

This issue delivers one implementation outcome within [Capability] Product foundation and technical architecture and follows the versioned product/technical contracts.

Relevant documentation:

* `docs/technical/testing-strategy.md`
* `docs/technical/deployment-and-operations.md`

## Scope

* Create GitHub Actions workflows for lockfile install, format/lint/typecheck, unit/component, PostgreSQL integration and build.
* Set up Vitest, React Testing Library, Playwright smoke infrastructure and deterministic fixture conventions.
* Add dependency, secret and baseline static-analysis checks with least-privilege workflow permissions.
* Publish concise test artifacts without sensitive payloads.

## Acceptance criteria

- [ ] Pull request CI fails on formatting, lint, type, unit, integration or build regression.
- [ ] PostgreSQL service/test isolation works on CI and locally.
- [ ] A minimal Playwright and accessibility smoke executes against the built app.
- [ ] Workflows pin third-party actions by commit and use minimal permissions.
- [ ] No production secrets are available to untrusted pull-request code.
- [ ] Test artifacts have bounded retention and exclude tokens/content.

## Out of scope

Full feature E2E suites, production deployment and final browser matrix.

## UI and content notes

There is no dedicated screen. Any surfaced state or error uses the canonical terminology and safe redacted detail defined by the parent capability.

## Implementation notes

Prefer one readable CI workflow with parallel jobs and caching; do not add vendor-specific deployment until the deployment issue.

## Data and permissions

Fixtures are synthetic/rights-cleared and logs/artifacts follow redaction policy.

## Test notes

* Intentionally failing sample checks are verified during setup then removed.
* CI workflow syntax and branch event behaviour are reviewed.

## Dependencies

Blocked by:

* {{ISSUE:foundation-scaffold}} Scaffold the TypeScript web and worker workspace
* {{ISSUE:foundation-database}} Establish PostgreSQL, Prisma and workspace ownership foundation

Blocks:

* {{ISSUE:analysis-contract}} Define and evaluate the v1 analysis schema, taxonomy and prompt
* {{ISSUE:analysis-evaluation}} Create Gemini analysis fixtures, mocks and model acceptance evaluation
* {{ISSUE:metrics-engine}} Implement canonical metric definitions and rate formula engine
* {{ISSUE:strategy-contract}} Define the structured strategy and recommendation prompt contract
* {{ISSUE:security-supply-chain}} Add dependency, action, container and media-tool supply-chain controls
* {{ISSUE:deployment-pipeline}} Provision staging/production and implement the safe deployment pipeline
