Backlog metadata — Priority: P1 · Size: M · Product area: Internal operations · Target release: v1.0-internal · Parent capability: {{ISSUE:cap-background-jobs}} [Capability] Background processing and job reliability

## Outcome

Authorised operators and scheduled reconciliation can recover safe failed/stale work or cancel eligible pending work without duplicating effects or editing the database.

## Context

This issue delivers one implementation outcome within [Capability] Background processing and job reliability and follows the versioned product/technical contracts.

Relevant documentation:

* `docs/technical/background-jobs.md`
* `docs/technical/security-and-privacy.md`

## Scope

* Implement cooperative cancellation for queued/retry and safe pre-provider stages.
* Implement permission/prerequisite-checked manual retry for failed-attention work.
* Schedule reconciliation for missing deliveries, expired leases, committed-result mismatch and cleanup debt hooks.
* Audit actor/service, reason and outcome.

## Acceptance criteria

- [ ] Queued/retry jobs cancel idempotently; processing jobs only cancel at documented safe points.
- [ ] Manual retry refuses ineligible/missing-prerequisite jobs and preserves the logical signature.
- [ ] Reconciler repairs unambiguous missing delivery/terminal state and flags ambiguous cases.
- [ ] Repeated retry/cancel/reconcile calls do not duplicate provider/result effects.
- [ ] All actions are server-authorised, rate-limited and audited.
- [ ] Structured logs/metrics distinguish user and reconciliation actions.
- [ ] Failure-injection integration tests pass.

## Out of scope

Bulk retry/cancel/delete and arbitrary state editing.

## UI and content notes

There is no dedicated screen. Any surfaced state or error uses the canonical terminology and safe redacted detail defined by the parent capability.

## Implementation notes

If inputs or versions intentionally change, create a new logical job rather than mutating provenance.

## Data and permissions

Only admins/operators in the same workspace act on jobs; crafted IDs get non-enumerating responses.

## Test notes

* Cancellation/retry authorisation and idempotency tests.
* Reconciliation fixture for every documented inconsistency.
* Negative crafted/cross-workspace job ID tests.

## Dependencies

Blocked by:

* {{ISSUE:jobs-policy}} Implement logical job states, leases, retries and idempotent handler framework

Blocks:

* {{ISSUE:sync-orchestration}} Deliver manual, incremental and scheduled sync orchestration
* {{ISSUE:asset-lifecycle}} Implement source asset replacement, transcript deletion and storage lifecycle
* {{ISSUE:analysis-reanalysis}} Support analysis version activation and safe reanalysis
* {{ISSUE:security-deletion}} Implement approved retention and full data-deletion workflows
* {{ISSUE:e2e-analysis}} Prove end-to-end upload, transcript, analysis and reanalysis recovery
