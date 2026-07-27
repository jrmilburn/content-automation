# V1 backlog overview

Status: import-ready; not published to GitHub because the target repository was public and the write was rejected as sensitive egress.

## Counts

- 1 root project issue
- 14 capability issues
- 61 implementation/testing/launch issues
- Implementation priority: 28 P0, 33 P1
- Implementation size: 1 S, 33 M, 27 L; nothing exceeds L
- Target release in every issue: `v1.0-internal`

## Root project

- [[Project] Studio Parallel Instagram content intelligence v1](issues/000-project-v1.md)

## Capabilities

1. [Product foundation and technical architecture](issues/001-cap-foundation.md) — 5 children
2. [Internal access and application shell](issues/002-cap-access.md) — 3 children
3. [Instagram account integration](issues/003-cap-instagram-connection.md) — 4 children
4. [Instagram post and metric synchronisation](issues/004-cap-instagram-sync.md) — 5 children
5. [Video upload and transcript management](issues/005-cap-content-ingestion.md) — 4 children
6. [Background processing and job reliability](issues/006-cap-background-jobs.md) — 4 children
7. [Gemini per-video analysis](issues/007-cap-video-analysis.md) — 5 children
8. [Analysis review and post detail](issues/008-cap-analysis-review.md) — 3 children
9. [Account analytics and trend calculation](issues/009-cap-analytics.md) — 5 children
10. [Automated content strategy](issues/010-cap-strategy.md) — 4 children
11. [Recommendation experience](issues/011-cap-recommendations.md) — 3 children
12. [Internal operations and failure recovery](issues/012-cap-operations.md) — 4 children
13. [Security, privacy and data lifecycle](issues/013-cap-security.md) — 5 children
14. [Testing, deployment and launch readiness](issues/014-cap-launch.md) — 7 children

## Suggested implementation order

1. Approve the planning baseline; scaffold web/worker/config, PostgreSQL, CI, observability, internal auth and the queue foundation.
2. Prove the live Meta contract; implement OAuth/credential health, media import, insight snapshots and sync operations.
3. Add private multipart upload, isolated validation, source/transcript editing and asset lifecycle.
4. Finalise Gemini schema/prompt/evaluation; implement the file adapter, one-video handler, post review and versioned reanalysis.
5. Implement canonical metrics, comparable cohorts, feature statistics, atomic recalculation and trends UI.
6. Implement frozen evidence retrieval, structured strategy generation/history and recommendation briefs/workflow.
7. Complete operations health/settings/runbooks and cross-cutting security, authorisation, deletion and supply-chain work.
8. Provision/rehearse deployment in parallel after foundations, then pass E2E provider journeys, restore/alerts, browser/accessibility/UAT and the final launch gate.

The manifest is the authoritative order and dependency graph. The importer creates root and every capability first, then implementation issues in dependency order, and performs a second pass so parent/checklist/dependency/block references contain actual GitHub numbers.
