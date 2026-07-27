Backlog metadata — Priority: P1 · Size: M · Product area: Analytics · Target release: v1.0-internal · Parent capability: {{ISSUE:cap-analytics}} [Capability] Account analytics and trend calculation

## Outcome

New snapshots or current analyses trigger one account-scoped calculation run that builds and atomically publishes a complete versioned statistic set without partial/stale UI results.

## Context

This issue delivers one implementation outcome within [Capability] Account analytics and trend calculation and follows the versioned product/technical contracts.

Relevant documentation:

* `docs/technical/analytics-and-metrics.md`
* `docs/technical/background-jobs.md`

## Scope

* Add dirty-account marker/calculation run and deduplicated/debounced job.
* Read a consistent input set, calculate staged statistics, validate counts/fingerprint and atomically activate run.
* Retain older statistic versions referenced by strategies and clean only unreferenced materialisations.
* Expose freshness, version, duration, counts and safe failure/retry.

## Acceptance criteria

- [ ] Burst of input changes yields one due recalculation per account/version window.
- [ ] UI/current readers see either old complete or new complete set, never partial rows.
- [ ] Input changes during calculation cause a safe follow-up run or fingerprint rejection.
- [ ] Repeated delivery produces one activated calculation run.
- [ ] Historical StrategyEvidence can still resolve its referenced statistic version.
- [ ] Failure retains prior current statistics and creates manual/retry state with structured diagnostics.
- [ ] Job/idempotency/concurrency/freshness tests pass.

## Out of scope

On-request full recalculation and cross-account/global aggregation.

## UI and content notes

There is no dedicated screen. Any surfaced state or error uses the canonical terminology and safe redacted detail defined by the parent capability.

## Implementation notes

Use staging/run ID and current pointer/activation transaction. Debounce must not lose later dirty changes.

## Data and permissions

Worker is service-authorised by account; logs contain counts/IDs, not content.

## Test notes

* Burst/debounce/fingerprint race tests.
* Atomic activation/repeated delivery/failure retention tests.
* Evidence retention integration test.

## Dependencies

Blocked by:

* {{ISSUE:analytics-feature-stats}} Calculate feature statistics, confidence and outlier sensitivity
* {{ISSUE:jobs-policy}} Implement logical job states, leases, retries and idempotent handler framework

Blocks:

* {{ISSUE:trends-ui}} Deliver account trends dashboard and evidence detail
* {{ISSUE:strategy-retrieval}} Build deterministic strategy evidence retrieval and frozen manifests
* {{ISSUE:operations-settings}} Deliver safe internal settings and version visibility
