Backlog metadata — Priority: P0 · Size: M · Product area: Launch readiness · Target release: v1.0-internal · Parent capability: {{ISSUE:cap-launch}} [Capability] Testing, deployment and launch readiness

## Outcome

Production data can be restored within approved objectives without reviving deleted content, and web/worker/provider/storage/cost failures produce actionable monitored alerts.

## Context

This issue delivers one implementation outcome within [Capability] Testing, deployment and launch readiness and follows the versioned product/technical contracts.

Relevant documentation:

* `docs/technical/deployment-and-operations.md`
* `docs/technical/security-and-privacy.md`

## Scope

* Enable encrypted PostgreSQL backup/PITR and object version/lifecycle settings; approve RPO/RTO/retention.
* Restore to isolated environment, verify constraints/current pointers/evidence and replay deletion ledger before access.
* Configure dashboards/alerts for web/DB/queue/provider/token/storage/cleanup/invalid output/cost.
* Send, acknowledge and resolve test incidents; document owners/escalation.

## Acceptance criteria

- [ ] Backup/PITR settings meet approved RPO/RTO/retention and access controls.
- [ ] Isolated restore succeeds and completed deletions remain inaccessible after ledger replay.
- [ ] Every documented P0 alert fires with environment/resource/correlation and no secrets/content.
- [ ] Alert silence/monitoring pipeline failure is detectable.
- [ ] Queue/dead-letter, Meta token/429, Gemini errors, cleanup/storage and cost thresholds are verified.
- [ ] Restore/test resources are cleaned safely and evidence recorded.
- [ ] Runbook links and named owners exist for each alert.

## Out of scope

Cross-region active replication and immutable compliance archive.

## UI and content notes

There is no dedicated screen. Any surfaced state or error uses the canonical terminology and safe redacted detail defined by the parent capability.

## Implementation notes

Backups are not a substitute for object/provider cleanup; restore procedure blocks user access until reconciliation/deletion replay.

## Data and permissions

Backup access is highly restricted/encrypted; restored data remains private and isolated.

## Test notes

* Quarterly-style restore rehearsal.
* Synthetic alert fire/ack/resolve tests.
* Deletion replay and log redaction verification.

## Dependencies

Blocked by:

* {{ISSUE:deployment-pipeline}} Provision staging/production and implement the safe deployment pipeline
* {{ISSUE:operations-health}} Expose integration, storage and Gemini usage/cost health signals
* {{ISSUE:security-deletion}} Implement approved retention and full data-deletion workflows

Blocks:

* {{ISSUE:launch-guide}} Complete operating guide, release blockers and internal launch sign-off
