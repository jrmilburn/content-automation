Backlog metadata — Priority: P0 · Size: L · Product area: Content ingestion · Target release: v1.0-internal · Parent capability: {{ISSUE:cap-content-ingestion}} [Capability] Video upload and transcript management

## Outcome

An authorised user can upload a large source video directly to a private object store with progress/resume while the server controls the exact object, size, type, expiry and association intent.

## Context

This issue delivers one implementation outcome within [Capability] Video upload and transcript management and follows the versioned product/technical contracts.

Relevant documentation:

* `docs/technical/video-ingestion.md`
* `docs/technical/security-and-privacy.md`

## Scope

* Configure an S3-compatible private storage adapter, environment prefixes, encryption/version/lifecycle/CORS expectations.
* Add VideoAsset/upload-intent schema and authorised multipart initiate/part/complete/abort commands.
* Use random exact object keys, short-lived signed operations, declared limits and checksums.
* Provide browser upload progress, resume/retry and completion handoff to validation.

## Acceptance criteria

- [ ] Video bytes never proxy through web memory and bucket/public access remains private.
- [ ] Signed operations are exact-key/method, short-lived and server-authorised for the post/workspace.
- [ ] Wrong/expired key, method, size/type, object version and crafted post ID fail safely.
- [ ] Multipart resume/retry does not create duplicate ready asset records.
- [ ] Completion verifies server-observed object metadata/checksum and queues validation idempotently.
- [ ] Upload UI shows selecting/uploading/paused/completing/error states and remains usable at 390px.
- [ ] Abandoned multipart cleanup/lifecycle and structured byte/failure metrics exist.

## Out of scope

Media validation, current-asset activation, automatic Instagram download and public URLs.

## UI and content notes

State supported formats/maximum before selection. Progress distinguishes upload from later validation. Network errors preserve resumable intent when safe; never imply completion before server verification.

## Implementation notes

Do not trust original filename/MIME/ETag as checksum. Client never supplies a reusable arbitrary object key.

## Data and permissions

Objects are workspace-prefixed private source content; signed URLs are sensitive and never logged. Upload actions require post ownership.

## Test notes

* Storage adapter contract and multipart integration tests.
* Signed-scope/expiry/crafted-ID negative tests.
* Browser progress/resume/mobile/accessibility tests.

## Dependencies

Blocked by:

* {{ISSUE:foundation-database}} Establish PostgreSQL, Prisma and workspace ownership foundation
* {{ISSUE:access-auth}} Implement Google Workspace sign-in and server-side workspace authorisation
* {{ISSUE:foundation-observability}} Add structured logging, correlation and error-monitoring foundations
* {{ISSUE:jobs-policy}} Implement logical job states, leases, retries and idempotent handler framework

Blocks:

* {{ISSUE:asset-validation}} Validate uploaded video assets in an isolated worker
* {{ISSUE:operations-health}} Expose integration, storage and Gemini usage/cost health signals
* {{ISSUE:security-secrets}} Harden secrets, credential encryption and logging redaction
* {{ISSUE:deployment-pipeline}} Provision staging/production and implement the safe deployment pipeline
