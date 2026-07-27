Backlog metadata — Priority: P0 · Size: L · Product area: Launch readiness · Target release: v1.0-internal · Parent capability: {{ISSUE:cap-launch}} [Capability] Testing, deployment and launch readiness

## Outcome

The same scanned release can deploy separate web and worker processes with managed PostgreSQL, private object storage, environment-isolated provider secrets, compatible migrations and controlled production promotion.

## Context

This issue delivers one implementation outcome within [Capability] Testing, deployment and launch readiness and follows the versioned product/technical contracts.

Relevant documentation:

* `docs/technical/deployment-and-operations.md`
* `docs/technical/security-and-privacy.md`

## Scope

* Select/record managed container/PostgreSQL/object provider and Australian/nearby region/cost rationale.
* Provision staging and production environments, domains/TLS, private networking/access and secret-manager entries.
* Create image build/publish-by-digest, migration one-off, web/worker deploy compatibility/readiness and manual production approval.
* Add rollback/smoke procedure and environment-fake defaults for previews.

## Acceptance criteria

- [ ] Staging/production databases, buckets, keys, OIDC/Meta/Gemini configs are distinct and preview has no production secrets.
- [ ] Web and worker deploy separately from same compatible release; long jobs never run in request process.
- [ ] Migrations are rehearsed/locked/backward-compatible and failed migration stops rollout.
- [ ] Production image is non-root/scanned/SBOM-addressed by digest.
- [ ] Readiness checks DB/queue/schema compatibility; liveness avoids provider calls.
- [ ] Post-deploy smoke verifies sign-in, DB, queue/no-op, private storage and provider status.
- [ ] Rollback and secret/config failure paths are documented and tested.

## Out of scope

Multi-region, Kubernetes/service mesh and public SLA.

## UI and content notes

There is no dedicated screen. Any surfaced state or error uses the canonical terminology and safe redacted detail defined by the parent capability.

## Implementation notes

Use expand/migrate/contract and immutable releases. Final vendor decision updates runbooks/cost assumptions.

## Data and permissions

Environment secrets stay in manager; staging uses authorised test account/rights-cleared content only.

## Test notes

* Infrastructure/config policy checks.
* Migration/deploy/rollback staging rehearsal.
* Post-deploy smoke and secret absence scan.

## Dependencies

Blocked by:

* {{ISSUE:foundation-ci}} Establish CI and automated test quality gates
* {{ISSUE:foundation-observability}} Add structured logging, correlation and error-monitoring foundations
* {{ISSUE:jobs-queue}} Implement the PostgreSQL-backed queue and transactional dispatch
* {{ISSUE:upload-storage}} Implement private object storage and signed multipart video upload
* {{ISSUE:security-supply-chain}} Add dependency, action, container and media-tool supply-chain controls

Blocks:

* {{ISSUE:backup-monitoring}} Verify backups, restore, monitoring and production alerts
