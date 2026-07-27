Backlog metadata — Priority: P1 · Size: M · Product area: Internal operations · Target release: v1.0-internal · Parent capability: {{ISSUE:cap-operations}} [Capability] Internal operations and failure recovery

## Outcome

Operators can see whether Meta, Gemini, storage and processing are healthy and monitor safe aggregate usage/cost/cleanup signals before failures or spend become surprises.

## Context

This issue delivers one implementation outcome within [Capability] Internal operations and failure recovery and follows the versioned product/technical contracts.

Relevant documentation:

* `docs/technical/deployment-and-operations.md`
* `docs/technical/security-and-privacy.md`

## Scope

* Create health projection/metrics for last provider success/failure/429, token expiry, queue age, storage bytes/cleanup debt and Gemini requests/tokens/estimated dated cost.
* Show freshness and configured budgets/threshold states in operations without exposing infrastructure secrets.
* Add alert hooks for sustained provider errors, stale sync, queue/dead-letter, token expiry, cleanup/storage and cost anomalies.
* Document estimation limitations and source timestamps.

## Acceptance criteria

- [ ] Health distinguishes never checked, healthy, degraded, unavailable and stale rather than a single green flag.
- [ ] Cost is labelled estimated with model/pricing effective date and provider usage source.
- [ ] No API key/token/signed URL/object key/raw content/prompt appears in projection, logs or alert.
- [ ] Provider outage does not make web liveness fail; readiness and integration health remain distinct.
- [ ] Alert test events route to named environment/owner and can be resolved.
- [ ] Metrics cardinality is bounded and workspace/provider scoped.
- [ ] Projection/redaction/threshold/fake-time tests pass.

## Out of scope

Formal billing, chargeback, public status page and provider SLA guarantees.

## UI and content notes

Lead with blocking/degraded signals and action; place usage/cost trend below. Always show Last checked and limitation.

## Implementation notes

Pricing table is dated configuration and never rewrites historical usage. Use aggregates, not raw diagnostic bodies.

## Data and permissions

Operational aggregates are restricted to internal users/admin where needed; no source content.

## Test notes

* Health state/threshold/cost estimate unit tests.
* Provider/stale/cleanup alert integration tests.
* Secret canary and partial UI tests.

## Dependencies

Blocked by:

* {{ISSUE:foundation-observability}} Add structured logging, correlation and error-monitoring foundations
* {{ISSUE:gemini-adapter}} Integrate paid Gemini video file and model APIs with usage controls
* {{ISSUE:instagram-token-health}} Implement Instagram token health, refresh and reconnect handling
* {{ISSUE:upload-storage}} Implement private object storage and signed multipart video upload

Blocks:

* {{ISSUE:operations-runbooks}} Create internal operating and failure-recovery runbooks
* {{ISSUE:backup-monitoring}} Verify backups, restore, monitoring and production alerts
