Backlog metadata — Priority: P0 · Size: M · Product area: Product foundation · Target release: v1.0-internal · Parent capability: {{ISSUE:cap-foundation}} [Capability] Product foundation and technical architecture

## Outcome

Developers can install, configure, build and run a typed Next.js web process and separate Node worker with shared domain/config packages.

## Context

This issue delivers one implementation outcome within [Capability] Product foundation and technical architecture and follows the versioned product/technical contracts.

Relevant documentation:

* `docs/technical/architecture.md`
* `docs/technical/deployment-and-operations.md`

## Scope

* Create the documented app/package layout, package manager lockfile and supported Node/toolchain versions.
* Add strict TypeScript, lint/format scripts and typed environment validation with safe example values.
* Provide local commands for web, worker, build and checks; adapters default to safe fake mode locally.
* Add minimal health entry points without implementing product features.

## Acceptance criteria

- [ ] A clean checkout installs from the immutable lockfile and builds both processes.
- [ ] Web and worker share domain/config packages without circular runtime imports.
- [ ] Startup fails with a clear secret-safe error for invalid required configuration.
- [ ] Preview/test environments do not require or receive production provider credentials.
- [ ] README developer setup and command documentation is present.
- [ ] Static checks run successfully in CI/local scripts.

## Out of scope

Database schema, user authentication, provider calls and production deployment.

## UI and content notes

There is no dedicated screen. Any surfaced state or error uses the canonical terminology and safe redacted detail defined by the parent capability.

## Implementation notes

Keep web and worker deployable separately but lockstep versioned. Use server-only module boundaries for secrets and provider adapters.

## Data and permissions

No real credentials or internal content in examples, fixtures, build output or client bundles.

## Test notes

* Typecheck/build tests for web, worker and shared packages.
* Configuration unit tests cover missing, malformed and secret-redacted failures.

## Dependencies

Blocked by:

* {{ISSUE:foundation-approval}} Confirm v1 product, terminology, screen map and architecture baseline

Blocks:

* {{ISSUE:foundation-database}} Establish PostgreSQL, Prisma and workspace ownership foundation
* {{ISSUE:foundation-ci}} Establish CI and automated test quality gates
* {{ISSUE:foundation-observability}} Add structured logging, correlation and error-monitoring foundations
* {{ISSUE:access-shell}} Build the responsive accessible internal application shell
* {{ISSUE:instagram-contract}} Prove Meta app, account, permissions and current API contract
* {{ISSUE:security-supply-chain}} Add dependency, action, container and media-tool supply-chain controls
