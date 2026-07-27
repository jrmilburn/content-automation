Backlog metadata — Priority: P0 · Size: L · Product area: Instagram integration · Target release: v1.0-internal · Parent capability: {{ISSUE:cap-instagram-sync}} [Capability] Instagram post and metric synchronisation

## Outcome

Each eligible post can store repeatable, versioned insight observations with canonical values, original provider definitions and explicit availability instead of treating missing data as zero.

## Context

This issue delivers one implementation outcome within [Capability] Instagram post and metric synchronisation and follows the versioned product/technical contracts.

Relevant documentation:

* `docs/technical/instagram-integration.md`
* `docs/technical/analytics-and-metrics.md`
* `docs/technical/data-model.md`

## Scope

* Implement versioned capability map by media/API version and request small compatible metric groups.
* Add InstagramMetricSnapshot typed nullable values, per-metric availability, raw payload/hash, post age and cadence metadata.
* Normalise units/names without merging views, plays, metadata counts or incompatible organic/paid definitions.
* Deduplicate observations while retaining genuinely changed snapshots.

## Acceptance criteria

- [ ] Supported metrics from representative Reel fixtures are stored with original name/unit/period/API version.
- [ ] Empty metric data records unavailable, not 0; unsupported, permission-missing, provider-error and not-requested are distinct.
- [ ] Views and plays remain separate canonical fields; watch-time units are normalised and original retained.
- [ ] Repeated identical request in one capture bucket does not duplicate; later changed values create a new snapshot.
- [ ] Partial group failure preserves successful metric groups and exposes limitations.
- [ ] Negative values/impossible units/unknown response shapes fail validation or quarantine safely.
- [ ] Adapter/database/availability tests cover every current capability-map branch.

## Out of scope

Rate calculations, trend statistics and guaranteeing every Meta metric/cadence.

## UI and content notes

There is no dedicated screen. Any surfaced state or error uses the canonical terminology and safe redacted detail defined by the parent capability.

## Implementation notes

Capability map is configuration/code-versioned and updated from official docs/live proof; never request one giant incompatible metric list.

## Data and permissions

Snapshots/raw payload are workspace/account/post scoped; no token/query URLs in stored payload/logs.

## Test notes

* Meta insight contract fixtures for available/empty/partial/429/permission cases.
* Snapshot dedupe/change and unit validation integration tests.
* Missing versus zero assertions.

## Dependencies

Blocked by:

* {{ISSUE:sync-media}} Import Instagram media with pagination and Reel classification

Blocks:

* {{ISSUE:sync-orchestration}} Deliver manual, incremental and scheduled sync orchestration
* {{ISSUE:post-detail}} Build unified post detail with metrics, source and processing status
* {{ISSUE:metrics-engine}} Implement canonical metric definitions and rate formula engine
