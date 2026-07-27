Backlog metadata — Priority: P0 · Size: L · Product area: Product foundation · Target release: v1.0-internal · Parent capability: None

## Outcome

Studio Parallel has a dependency-ordered delivery project for an internal tool that connects an authorised Instagram professional account, imports posts and changing metrics, analyses one uploaded source video per Gemini request, computes account trends in application code, and generates evidence-linked content strategy and recommendations.

## Context

The repository is greenfield. This issue is the delivery source of truth for v1.

Relevant documentation:

* `docs/README.md`
* `docs/product/v1-product-definition.md`
* `docs/technical/architecture.md`
* `docs/repository-assessment.md`

## Product objective

Identify creative characteristics associated with stronger observed results in Studio Parallel's own authorised Instagram history and turn them into testable future-video recommendations without algorithm or causal claims.

## Internal user

Approved Studio Parallel content strategists, founders and operators in one internal workspace.

## Version-one definition

Internal users can connect an eligible account, import Reels and metric snapshots, upload/associate source content, run independently retryable structured video analyses, inspect account trends, generate evidence-linked strategies/recommendations and recover failed/incomplete work.

## Architecture summary

A TypeScript monorepo contains a Next.js web app and separate Node worker. PostgreSQL/Prisma stores product data and backs a durable queue; private S3-compatible storage holds source video. Official Meta and paid Gemini APIs are server-only. Gemini analyses one video at a time; application code owns files, state, validation, statistics and evidence retrieval.

## Key constraints

* Official authorised Instagram API only; no scraping.
* Missing metrics are first-class and never interpreted as zero.
* Compare only compatible metric definitions and post-age snapshots.
* Validate structured AI output syntactically and semantically before publication.
* Calculate statistics in application code using documented robust methods.
* Freeze a bounded strategy evidence manifest; never send all raw account videos.
* Use account-scoped, non-causal language with evidence and limitations.
* One internal workspace; no public SaaS/billing/complex roles.

## Capability checklist

- [ ] {{ISSUE:cap-foundation}} [Capability] Product foundation and technical architecture
- [ ] {{ISSUE:cap-access}} [Capability] Internal access and application shell
- [ ] {{ISSUE:cap-instagram-connection}} [Capability] Instagram account integration
- [ ] {{ISSUE:cap-instagram-sync}} [Capability] Instagram post and metric synchronisation
- [ ] {{ISSUE:cap-content-ingestion}} [Capability] Video upload and transcript management
- [ ] {{ISSUE:cap-background-jobs}} [Capability] Background processing and job reliability
- [ ] {{ISSUE:cap-video-analysis}} [Capability] Gemini per-video analysis
- [ ] {{ISSUE:cap-analysis-review}} [Capability] Analysis review and post detail
- [ ] {{ISSUE:cap-analytics}} [Capability] Account analytics and trend calculation
- [ ] {{ISSUE:cap-strategy}} [Capability] Automated content strategy
- [ ] {{ISSUE:cap-recommendations}} [Capability] Recommendation experience
- [ ] {{ISSUE:cap-operations}} [Capability] Internal operations and failure recovery
- [ ] {{ISSUE:cap-security}} [Capability] Security, privacy and data lifecycle
- [ ] {{ISSUE:cap-launch}} [Capability] Testing, deployment and launch readiness

## Major dependency order

1. Product/architecture and application/data/access foundations.
2. Instagram connection, synchronisation and secure source ingestion.
3. Durable jobs and Gemini structured analysis.
4. Post review, analytics and strategy.
5. Recommendations and operations.
6. Security/privacy review, acceptance and launch.

## Main risks

Meta access/metric changes; small or biased samples; incompatible snapshot ages; sampled-video limitations; semantically wrong model output; credential/provider failures; unresolved retention/provider-data terms; and unmeasured storage/inference cost.

## Explicit exclusions

Public sign-up/client onboarding, billing, complex roles, public API/mobile apps, other networks, publishing/scheduling, inbox/comments, scraping, competitor/global trends, ads, automatic editing/generation, custom ML, persistent per-post agents, multi-agent orchestration, real-time collaboration, white-labelling, client portals and public share links.

## Documentation index

See `docs/README.md` for all product, design, technical and repository-assessment documents.

## Definition of done for internal launch

- [ ] All capability checklists are complete or have an explicitly accepted non-blocking limitation.
- [ ] Real Meta account contract proof and paid Gemini data settings pass.
- [ ] Critical import, upload/analysis and strategy journeys pass end to end.
- [ ] Negative authorisation, idempotency, retry, deletion and restore checks pass.
- [ ] Trends/recommendations expose evidence, confidence and limitations.
- [ ] Deploy, monitoring, alerts, backups, runbooks and cost budgets are verified.
- [ ] Product, engineering, security/privacy and internal user acceptance are recorded.
- [ ] No open P0 or release-blocker remains.

## Scope

Coordinate every linked v1 capability, dependency, launch gate and accepted limitation.

## Acceptance criteria

- [ ] Every child has one parent, resolved dependency references, size no larger than L and relevant docs.
- [ ] Root/capability checklists resolve to actual issue numbers during import.
- [ ] No child introduces public SaaS, unauthorised scraping or autonomous per-post agents.
- [ ] Definition of done above is evidenced before closure.

## Out of scope

Implementation details belong in child issues; closure does not itself authorise a public launch.

## Implementation notes

Material changes to scope, evidence rules, providers, architecture or data lifecycle update docs and impacted backlog before build.

## Data and permissions

All data belongs to the Studio Parallel workspace and is server-authorised. Credential/private-file/deletion/crafted-identifier work remains a launch gate.

## Test notes

Close only after child automated tests, live provider contract proof, security review, end-to-end journeys, restore rehearsal and internal acceptance.

## Dependencies

Blocked by:

* None

Blocks:

* {{ISSUE:cap-foundation}} [Capability] Product foundation and technical architecture
* {{ISSUE:cap-access}} [Capability] Internal access and application shell
* {{ISSUE:cap-instagram-connection}} [Capability] Instagram account integration
* {{ISSUE:cap-instagram-sync}} [Capability] Instagram post and metric synchronisation
* {{ISSUE:cap-content-ingestion}} [Capability] Video upload and transcript management
* {{ISSUE:cap-background-jobs}} [Capability] Background processing and job reliability
* {{ISSUE:cap-video-analysis}} [Capability] Gemini per-video analysis
* {{ISSUE:cap-analysis-review}} [Capability] Analysis review and post detail
* {{ISSUE:cap-analytics}} [Capability] Account analytics and trend calculation
* {{ISSUE:cap-strategy}} [Capability] Automated content strategy
* {{ISSUE:cap-recommendations}} [Capability] Recommendation experience
* {{ISSUE:cap-operations}} [Capability] Internal operations and failure recovery
* {{ISSUE:cap-security}} [Capability] Security, privacy and data lifecycle
* {{ISSUE:cap-launch}} [Capability] Testing, deployment and launch readiness
