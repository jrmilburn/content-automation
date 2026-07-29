# Testing strategy

## Quality goals

Protect authorisation, data provenance, idempotency, formula correctness, structured-AI validation and recoverability. Paid/live provider tests supplement deterministic fixtures; they do not replace them or run on every pull request.

## Test layers

### Static and unit

- Strict TypeScript, ESLint and formatting.
- Vitest for state machines, policies, canonicalisation/hashing, retry/error classification, redaction and all analytics formulas.
- Property-based tests where useful for rates, state transitions, idempotency and schema boundaries.
- Zod unit fixtures for valid/invalid analysis and strategy contracts, including cross-field semantic validators and causal-language lint.
- React Testing Library for component behaviour, keyboard/focus, accessible names and loading/empty/error/partial states.

### Database/repository integration

Run against real PostgreSQL (Testcontainers in CI or an isolated CI service):

- migrations up/down policy and schema drift;
- workspace-scoped repositories and crafted/cross-workspace identifiers;
- uniqueness/current-pointer/evidence constraints;
- transactional outbox/dedup/concurrent job claims;
- snapshot/analysis/strategy immutability and deletion effects;
- raw SQL analytics queries against reviewed fixed datasets.

Mocks are not acceptable for relational constraint tests.

### Provider contract

Adapters parse versioned, sanitised fixtures captured from official/sandbox calls:

- Meta pagination, account/media types, metric variants, empty data, missing fields, partial groups, 401/403/429/5xx and usage headers.
- Gemini file lifecycle, usage/finish/safety metadata, schema-valid output, malformed JSON, schema-valid semantic failure, blocked/no candidate and provider retry errors.
- Object store multipart creation/completion, checksum/etag/version, expiry, missing object and delete failures.
- OIDC issuer/audience/nonce and claim variations.

Record/replay tooling must strip tokens, signed URLs, PII/content and provider identifiers that are not safe. A scheduled/manual live contract suite validates the currently pinned Meta API version and Gemini model before release and API upgrades.

### Background job reliability

- Repeat delivery produces one logical snapshot/analysis/strategy.
- Crash injection before/after provider side effect and before/after commit.
- Lease expiry/heartbeat, concurrency limits, graceful shutdown and stale-job reconciliation.
- Retry timing with fake clock and seeded jitter; 429 hint handling; terminal/manual states.
- Sync page checkpoint/resume and per-item isolation.
- File cleanup/reconciliation does not undo valid output.
- Analytics debounce and atomic calculation-run publication.

### AI evaluation

A versioned, rights-cleared gold set contains representative Studio Parallel-like clips: talking head, B-roll, rapid edits, on-screen text, quiet/no speech, multiple CTAs, very short/long, poor audio/video and transcript mismatch.

For every proposed schema/prompt/model:

- 100% JSON/schema parse on supported fixtures after allowed retry.
- Semantic validator pass threshold defined before evaluation.
- Human-labelled taxonomy agreement and timestamp tolerance.
- Unknown/low-confidence behaviour on genuinely unobservable fields.
- Repeat-run variance on a fixed subset.
- No invented performance/algorithm claims.
- Strategy evidence-reference precision: every cited ID supports the text and no ID lies outside the manifest.
- Duplicate recommendation and insufficient-evidence behaviour.
- Token/latency/cost measurements.

Activation requires an evaluation report and explicit owner approval. AI snapshots should assert invariants/meaning, not brittle prose equality.

### End-to-end

Use Playwright with provider adapters in deterministic fake mode for:

1. Approved login and denied user.
2. Connect account callback and bootstrap import.
3. Manual/incremental sync with missing insights and retry.
4. Upload, validation, transcript edit and post association.
5. Analyse one post through queued/processing/complete and invalid-output failure/retry.
6. Review metrics/analysis/history/reanalysis.
7. Recalculate and inspect trend evidence/insufficient/outlier states.
8. Generate strategy, open evidence/recommendation, change status and link result post.
9. Operations retry/reconnect and token-expiry state.
10. Asset/transcript/account deletion effects.

At least one controlled staging smoke uses real Meta/Gemini/storage integrations with non-sensitive test content before internal launch.

## UI, browser and accessibility coverage

- Automated Chromium on PR; Chromium, Firefox and WebKit in release CI for critical journeys.
- Desktop and 390px mobile viewports; verify no clipped actions and usable scrollable data tables.
- `axe` automated checks for critical pages plus manual keyboard-only, focus order/return, screen-reader labels/live status, contrast, zoom to 200% and reduced motion.
- Charts always have an equivalent table/text summary and do not encode status only by colour.
- Test slow/failing networks for upload progress/resume and async status refresh.

## Security tests

- Negative authorisation matrix for every account/post/asset/transcript/job/statistic/strategy/recommendation/settings route.
- OAuth state/PKCE replay, callback expiry, open redirect and scope downgrade.
- CSRF/origin, rate limit, duplicate command/idempotency and input-length abuse.
- Signed upload/download expiry, wrong method/key/content length/type and object-key tampering.
- XSS/script content in captions/transcripts/model output; SSRF is impossible by route design.
- Malformed/polyglot/corrupt media and parser resource exhaustion.
- Redaction canaries prove secrets, signed URLs and content do not reach logs/errors.
- Dependency, secret, SAST/CodeQL, container and SBOM scans in CI/release.

## Performance and resilience

- Post list/filter and trend query budgets on a dataset materially larger than expected v1 (for example 2,000 posts/10,000 snapshots).
- Upload direct-to-object-store avoids web server memory buffering.
- Queue throughput/backpressure and provider concurrency simulation.
- Database connection/lock and analytics calculation duration.
- Controlled provider outage, database restart and worker termination exercises.
- Restore a backup to an isolated environment and reapply deletion ledger.

## CI gates

Pull requests: install from lockfile, generated-code/schema check, format/lint/typecheck, unit/component, PostgreSQL integration, adapter fixtures, critical Playwright, accessibility, dependency/secret/SAST scans and build.

The v1 foundation implements this as `.github/workflows/ci.yml` with parallel quality/build, PostgreSQL and browser/accessibility jobs, and `.github/workflows/supply-chain.yml` with dependency/secret/policy, dependency-review, CodeQL and container build/scan jobs. Pull-request jobs use `APP_ENV=test` and `PROVIDER_MODE=fake`, never `pull_request_target`, and receive no production provider secrets. All reusable GitHub Actions are pinned to immutable commit SHAs with least-privilege permissions and checkout credentials are not persisted. `npm run security:workflows` enforces those properties as a test rather than a convention; `docs/technical/supply-chain-security.md` documents them.

Every implementation pull request also runs `npm ci`, installs the pinned Chromium version when needed with `npm run test:e2e:install`, and records the result of `npm run validate:local`. Documentation-only pull requests may omit database/browser execution only with a written applicability rationale; formatting, secret scanning and directly affected checks remain required.

`validate:local` runs quality/type/unit/component checks, dependency auditing, the redacting secret scan, supply-chain policy checks and SBOM generation, disposable real-PostgreSQL integration, the production build, and Playwright/axe smoke at desktop and 390px mobile widths. Provider mode remains fake and fixtures remain synthetic, so local validation requires no production credentials or private content.

CI publishes only JUnit result files, the CycloneDX SBOM and image scan reports, all with bounded retention. Browser screenshots, video and traces are disabled, and fixture policy prohibits tokens, provider payloads and private content from test output. Later feature issues extend these jobs rather than adding provider credentials to pull-request workflows.

Main/release: full browser matrix, migration rehearsal, container scan/SBOM, AI contract fixture evaluation for changed schema/prompt/model, deployment smoke and manual production approval.

Flaky tests are quarantined only with an owner/expiry issue; critical authorisation/idempotency tests cannot be quarantined.

## Test data

- Synthetic/fabricated provider fixtures by default.
- Rights-cleared internal video fixtures in a restricted test bucket; no production tokens or customer-like sensitive content in CI artifacts.
- Factories make workspace ownership explicit so cross-workspace tests are easy.
- Fixed analytics fixtures and expected outputs are code-reviewed; random generators use recorded seeds.
- Test objects/databases have environment prefixes and automatic cleanup.

## Internal acceptance

Studio Parallel validates terminology, upload/association, analysis usefulness, trend evidence, strategy structure, recommendation actionability, insufficient-data language and operational recovery. Findings become release-blocker issues or explicitly accepted limitations. Launch sign-off includes product, engineering, security/privacy and operator owners.
