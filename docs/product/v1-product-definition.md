# Studio Parallel Instagram content intelligence: v1 product definition

Status: planning baseline
Target release: `v1.0-internal`
Last reviewed: 2026-07-28

## Problem

Studio Parallel can see how individual Instagram posts performed, but cannot consistently connect that performance to repeatable creative characteristics across its own history. Manual review is slow, subject to hindsight bias, and rarely preserves the evidence behind a recommendation.

Version one creates an internal evidence system: it imports authorised Instagram professional-account data, analyses one uploaded source video at a time, calculates comparable statistics in application code, and generates recommendations whose supporting posts, metrics, assumptions and limitations can be inspected.

The product does not explain or reverse-engineer the Instagram algorithm. It describes associations observed in connected Studio Parallel accounts and distinguishes measurement from model-generated creative judgement.

## Internal user

The primary user is a Studio Parallel content strategist, founder or operator who is authorised to access the connected Instagram account and source content. All signed-in v1 users share one Studio Parallel workspace. Public sign-up, clients and granular roles are excluded.

## Version-one outcome

A team member can:

1. Sign in with an approved Studio Parallel identity.
2. Connect or configure an authorised Instagram Business or Creator account.
3. Import recent Reels and capture repeatable metric snapshots without treating absent insights as zero.
4. Upload a durable source video, associate it with a post, and add or edit a transcript, script, audience, objective and category tags.
5. submit an eligible post to an independently retryable analysis job.
6. Review validated, versioned creative analysis for that one video.
7. Compare creative features with comparable performance observations calculated by the application.
8. Generate and inspect an evidence-linked account strategy and concrete next-video recommendations.
9. Reanalyse a post when the active schema or prompt changes.
10. Find failed, incomplete or stale work and safely retry it.

## Success criteria

Internal launch is successful when:

- One production Studio Parallel professional account can be connected using official Meta APIs and least-privilege scopes.
- At least 20 recent Reels can be imported when available, with raw provider payload provenance and per-field availability recorded.
- At least 10 representative source videos complete per-video analysis against a locked evaluation fixture; schema-invalid output is never published as an analysis.
- At least 95% of non-provider-fault analysis jobs complete without manual database intervention during acceptance testing; retries do not duplicate analyses or metric snapshots.
- A user can trace every displayed trend and recommendation to post IDs, snapshot times, metric definitions and analysis versions.
- Small samples, outliers, unavailable metrics and incomparable snapshot ages are visibly qualified.
- A strategy can be regenerated without losing previous generations or their evidence.
- Access, credential handling, private-file access, deletion, redaction, backup/restore and failure recovery pass the launch checklist.

These are launch gates, not claims of statistical power. Strategy quality still requires editorial review.

## Core workflows

### Connect and import

The user connects an eligible account, sees scopes and token health, starts an import, and watches a sync run page. Posts and insights are upserted by provider identifier. Unsupported media and missing metrics are retained with explicit reasons rather than silently dropped.

### Prepare and analyse a post

The user selects an imported Reel, uploads its original video, adds optional source context, and submits it. The system validates the asset, creates one idempotent job, uploads the asset to Gemini only for that job, validates the structured response, stores a new immutable analysis version, and deletes the temporary Gemini file when practical.

### Review evidence

The post page brings together imported metadata, comparable metric snapshots, source inputs, job state and the latest analysis. Estimated observations are labelled. Previous analyses remain inspectable.

### Explore trends

The trends page applies documented metric and cohort rules, then shows strongest signals, weak signals, outliers, distribution and limitations. A trend always names the feature, value, metric, cohort, baseline, difference, time period, sample size, confidence and supporting posts.

### Generate strategy and recommendations

The user requests a strategy for an account and optional period/pillar. Application code retrieves a bounded evidence set of analyses, comparable metrics, feature statistics and recent recommendations. Gemini returns a validated strategy contract; the system stores the exact evidence set and exposes it with every claim and recommendation.

### Operate and recover

The operations area shows integration health, syncs, jobs, schema versions, missing associations and cost/usage metadata. Authorised users can retry safe operations, reconnect expired credentials and inspect redacted errors.

## Functional requirements

### Account and ingestion

- Support Instagram professional Business and Creator accounts only.
- Prefer Instagram API with Instagram Login for the internal v1, subject to a production proof of `instagram_business_basic` and `instagram_business_manage_insights` against the Studio Parallel account.
- Store tokens encrypted and server-side; expose status, not token material.
- Import cursor-paginated owned media and classify Reels using provider fields such as `media_product_type`, not `media_type` alone.
- Preserve raw API payloads with API version and capture time for audit, while exposing normalised fields to the product.
- Store multiple immutable insight snapshots per post and a per-metric status: available, unavailable, not_applicable, permission_missing, provider_error or not_requested.
- Allow manual sync and scheduled, configurable follow-up snapshots. The model supports initial, roughly 1h, 24h, 3d, 7d and 30d observations without promising every cadence.

### Source content

- Use a private object store as the durable source of truth; do not persist Instagram CDN URLs as the source asset.
- Use signed, short-lived upload and download URLs, server-authorised before issuance.
- Validate declared and detected file type, size, duration and decodability before analysis eligibility.
- Allow one active video association per post while preserving replacement/deletion audit events.
- Provide versioned editable transcript content plus optional script, audience, objective, notes and tags.

### Analysis

- Process exactly one post/video per Gemini analysis request.
- Use an immutable analysis schema version and prompt version, a pinned model ID, and a deterministic idempotency key.
- Request structured JSON and validate syntax, shape, enumerations, ranges, cross-field rules and business semantics in application code.
- Preserve model, prompt/schema versions, timestamps, safety/finish reason, latency and token usage where returned.
- Treat visual timing/count fields as estimates with field-level confidence and evidence notes.
- Never overwrite historical analysis. Reanalysis creates a new record and updates the selected current analysis only after validation succeeds.

### Analytics

- Calculate rates, baselines, cohort comparisons, confidence and outlier sensitivity in application code.
- Compare only identical metric definitions at comparable snapshot ages and compatible media/account contexts.
- Prefer medians and median ratios over means for skewed post performance.
- Show no numeric rate when its denominator is absent or zero.
- Never infer zero from an empty insight response.
- Label evidence using the rules in `docs/technical/analytics-and-metrics.md`.

### Strategy and recommendations

- Retrieve a bounded evidence set instead of sending all raw account videos or history.
- Include strong/weak patterns, gaps, pillar allocation, next tests and next-video recommendations when supported.
- For each recommendation store rationale, evidence strength, data limitations, historical post/statistic references and whether the content is a model-generated creative proposal.
- Support proposed, selected, completed and dismissed recommendation states; a completed item may link to a resulting imported post.
- Detect near-duplicate recent ideas before generation and instruct the model to diversify or explicitly justify repetition.
- Refuse a strongly evidence-based framing when the minimum analysed/comparable sample is not met; offer data-gathering experiments instead.

### Internal operations

- Show sync/job status, attempt counts, next retry, redacted error class, correlation ID and required manual action.
- Make retry, cancellation-before-start and reconnect operations explicit and idempotent.
- Show active schema/prompt/model configuration, token status and aggregated usage/cost estimates without exposing secrets.

## Non-functional requirements

- **Security:** server-side authentication and authorisation on every data/file/job action; encrypted integration credentials; private objects; CSRF/state/PKCE protections; redacted structured logs.
- **Reliability:** durable queue, leases/heartbeats, bounded exponential retry with jitter, dead-letter state, reconciliation and idempotent writes.
- **Traceability:** provider API version, raw payload, snapshot time, formula version, schema/prompt/model version, evidence IDs and actor/correlation IDs are preserved.
- **Performance:** list/detail pages render useful skeletons quickly; heavy imports, media work, analysis and strategy generation never depend on a browser request remaining open.
- **Accessibility:** keyboard-operable actions, semantic headings/tables, labelled controls, visible focus, non-colour status cues and accessible error summaries.
- **Responsive use:** core review and retry flows work at 390px; dense analytics may use horizontally scrollable labelled tables, never clipped controls.
- **Privacy:** paid Gemini service, no voluntary prompt-log sharing, explicit retention/deletion, and no transcript/video body in application logs.
- **Maintainability:** strict TypeScript, shared Zod contracts, migration discipline, automated tests and documented runbooks.
- **Cost control:** configurable concurrency, file cleanup, token recording, request budgets and no default context cache or batch subsystem.

## Data sources

1. **Instagram API:** authoritative for account/post identifiers, metadata and whatever insights are returned for that account, media, permission set and API version. Availability is captured, not assumed.
2. **Uploaded source content:** authoritative for durable video, user-edited transcript/script and intent notes. Instagram media URLs may aid display temporarily but are not durable storage.
3. **Gemini:** source of model-derived creative observations and recommendations, never the source of performance calculations.

## Analysis and recommendation approach

The deterministic pipeline is described in `docs/technical/architecture.md`. Each video is analysed independently. Account statistics are recomputed from stored, validated analyses and comparable snapshots. Strategy retrieval selects relevant posts and statistics; Gemini interprets that evidence under a structured contract. No persistent autonomous agents or model-controlled database/file/queue operations are used.

## Evidence and confidence rules

- **Measured fact:** provider value or deterministic calculation, with source and observation time.
- **Model observation:** structured interpretation of video/audio/text, with field confidence and estimation label.
- **Statistically supported association:** meets the documented sample, uncertainty, effect and sensitivity rules. It is still not causal.
- **Weak directional signal:** has limited sample or uncertainty but a consistent direction worth testing.
- **Single-post outlier:** a result dominated by one post; displayed separately and never generalised.
- **Unsupported:** missing comparable evidence or denominator; excluded from evidence claims.
- **Creative recommendation:** a model-generated proposal informed by evidence but not itself a measured fact.

Every recommendation uses language such as “In this account’s observed posts…” and “is associated with…”, never “Instagram rewards…” or “causes…”.

## Version-one exclusions

Public sign-up, client onboarding, billing, complex roles, public APIs, native mobile apps, other social networks, publishing/scheduling, inbox and comment moderation (comments are read as strategy input, never written or replied to), scraping, competitor/global trend data, advertising tools, automatic editing/generation, custom model training, persistent per-post agents, multi-agent orchestration, real-time collaboration, white-labelling, client portals and public share links are out of scope.

## Risks

- Meta permissions, metric names, metric retention and account eligibility can change or differ by account.
- Small content histories and changing creative/distribution conditions limit statistical power.
- Source videos may not perfectly match the published edit.
- One-frame-per-second Gemini sampling can miss rapid cuts and fine on-screen text.
- Model responses can be syntactically valid but semantically wrong.
- Long-lived access can expire or be revoked; scheduled snapshots may therefore be missed.
- Video storage, inference and egress costs need real production measurements.
- Recommendations may become repetitive without explicit history retrieval and editorial controls.

## Open questions before build completion

1. Which Studio Parallel Instagram account(s) and Meta app/business own the v1 integration?
2. Can the target account use Standard Access as an owned/managed account, or is Advanced Access/App Review required by the actual ownership setup?
3. What default analysis period and primary success metric should strategy views lead with?
4. What are the approved upload maximum, original-video retention period and deletion approval policy?
5. Which Google Cloud billing entity, region and Data Processing Addendum cover source content?
6. Is Google Workspace OIDC with explicit email allowlisting acceptable for internal access?
7. Which managed deployment provider and object-store region satisfy Studio Parallel’s cost and data-location preferences?
8. What gold-standard set of videos will Studio Parallel annotate for prompt/model acceptance testing?
