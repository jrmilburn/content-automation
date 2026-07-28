# Security, privacy and data lifecycle

## Scope and threat model

V1 is internal but processes valuable social-account credentials, unpublished source videos, scripts/transcripts and model-derived strategy. Main threats are stolen session/credential, crafted identifiers crossing the workspace boundary, over-broad signed URLs, malicious media/parser exploitation, leaked content in logs/provider dashboards, replayed OAuth/webhook requests, duplicate background effects, dependency compromise and incomplete deletion.

One workspace and a small user group reduce product complexity, not the need for server-side controls.

## Internal authentication and authorisation

- Google Workspace OIDC through Auth.js with exact issuer/audience/nonce validation.
- Access requires both approved domain and an explicit active `InternalUser` allowlist row. Do not auto-provision every domain user.
- Secure, HTTP-only, same-site cookies; TLS only; session rotation and bounded lifetime; revoke on user deactivation.
- State-changing routes/actions require CSRF/origin protection as appropriate to the framework.
- Every command/query derives actor/workspace from the server session and loads resources by `(workspace_id, id)`. Never trust a client `workspace_id` or post/account relationship.
- Non-owned and nonexistent crafted IDs return the same non-enumerating result. Negative authorisation tests cover every resource/file/job route.
- V1 roles are only `member` and `admin`: job retry/cancellation, deletion, credential connection/settings and user management are admin actions; no granular permission builder.
- Worker/service credentials cannot establish an interactive user session and are restricted by deployment identity/network/database role.

## Meta credentials and OAuth

- Request only `instagram_business_basic` and `instagram_business_manage_insights` on the selected v1 path.
- State/PKCE/nonce values are high entropy, session-bound, single-use and short-lived; redirect URIs are exact allowlisted HTTPS values.
- Exchange/refresh happens server-side. Access tokens never enter client JavaScript, query strings, logs, analytics or error monitoring.
- Envelope-encrypt credential ciphertext with an environment KMS/master key; store key version and rotate by re-encryption. Database administrators/backups should not have the application key.
- Scope, expiry/status and last validation are separate non-secret metadata. Refresh uses a per-credential lock and atomic rotation.
- Disconnect/revocation and invalid-token paths purge credential material and stop scheduled calls.
- Provider responses and error text pass a token/signed-URL redactor before logging.

## Application and environment secrets

- Production secrets live in the deployment secret manager, not repository, `.env` committed files, image layers, CI logs or database settings.
- Separate Meta, Gemini, OIDC, database, storage and error-monitoring credentials by environment.
- Apply least-privilege storage/database/provider access, short-lived workload identities where available and scheduled rotation.
- Validate configuration at startup with a secret-safe schema; fail closed on missing encryption/auth/provider configuration.
- Secret values are write-only in operations UI; the app displays status/fingerprint/last-rotated only.

## Secure file handling

- Private bucket, public access blocked, encryption at rest, TLS in transit and environment separation.
- Server authorises every signed URL and scopes it to a random exact object key/method/size/type with short expiry. Never accept arbitrary object keys from the browser.
- Validate server-observed bytes, checksum, magic/container, streams, duration and decodeability; declared MIME/extension are untrusted.
- Media probe runs current patched tooling in an isolated, network-disabled, resource/time-limited process. Filenames are never shell-interpolated.
- Uploaded objects remain quarantined until validation; malware/approved scanning is defence in depth.
- Content-Disposition uses a sanitised filename; CSP/media controls prevent uploaded active content execution.
- Abandoned multipart and failed/quarantined objects have lifecycle cleanup and monitoring.

## Gemini data handling

- Use a billing-enabled paid project. Under Google’s current [Gemini API terms](https://ai.google.dev/gemini-api/terms), paid-service prompts, files and responses are not used to improve Google products, though limited safety/security processing and required disclosures still apply.
- Do not use unpaid quota for internal source content.
- Disable optional developer request/response logging and never opt into sharing datasets. If logs are approved later, use the shortest practical retention and restrict project access; Google’s [logging policy](https://ai.google.dev/gemini-api/docs/logs-policy) currently offers 7–55-day retention.
- Upload only the selected video and needed context. Do not send Instagram tokens, internal user PII, irrelevant notes or raw account history.
- Explicitly delete temporary Gemini files after terminal handling; reconcile against the Files API’s current 48-hour auto-expiry.
- Confirm region/terms/Data Processing Addendum and content rights with Studio Parallel before production.
- Treat transcripts/video text as prompt-injection content. Fixed system instructions say embedded instructions are data; the model has no tools/function calls.

## Logging, monitoring and diagnostics

Allowlist structured fields; do not “log then redact” as the primary design.

Never log:

- access/refresh tokens, app/client secrets, encryption material or session cookies;
- signed URLs/query strings or raw request authorisation headers;
- video bytes/object contents, transcript/script/notes, full captions when avoidable;
- raw Gemini prompts/responses or Meta raw payloads;
- OIDC token claims beyond stable internal IDs/safe email hash.

Use resource UUIDs, correlation/provider request IDs, stage, safe error class/status, byte/token counts and duration. Error-monitoring breadcrumbs obey the same policy. Add automated redaction tests with canary secret patterns.

## API abuse and application protections

- Authenticated rate limits per user/workspace for upload intents, manual sync, analyse/reanalyse, strategy generation and retries.
- Manual job retry and cancellation use bounded per-admin/workspace audit windows before loading the
  target job, so crafted missing/cross-workspace IDs cannot bypass limits or reveal ownership.
- One active logical operation per idempotency signature; cooldowns/daily budgets protect paid/provider actions.
- Strict JSON/form body schemas, length/range limits and safe pagination caps.
- Same-origin/CORS allowlist, security headers (CSP, HSTS, frame-ancestors, referrer policy, nosniff) and dependency-safe rendering.
- SSRF protection: server fetches only provider endpoints and known object-store locations; user-supplied URLs are not fetched in v1.
- Database parameterisation/ORM, escaped text rendering, no raw HTML from provider/model/user.
- OAuth/webhook signatures and replay timestamps are verified if webhooks are added.
- Audit connect/disconnect, secret/config changes, deletes, retries, analysis activation, strategy/recommendation state and resulting-post links.

## Background-job integrity

- Internal opaque IDs only; worker reauthorises ownership relationships from database records.
- Transactional/outbox enqueue, unique idempotency keys, state compare-and-swap, leases and heartbeat.
- External provider IDs are stored after each side effect so crash retry reconciles instead of duplicating.
- Bounded retries and dead-letter/manual attention; no infinite retry costs.
- A failed replacement/reanalysis/strategy never overwrites a valid current record.
- Worker database/storage roles have only required read/write prefixes/tables where practicable.

## Retention policy (proposed; approval required)

| Data | Proposed retention | Deletion behaviour |
| --- | --- | --- |
| Meta credential | While connected | Revoke when possible and purge immediately on disconnect/invalidated removal |
| Source video | While post active | Explicit delete; superseded version 30-day recovery then purge |
| Rejected/abandoned upload | <=24 hours | Lifecycle + reconciler purge |
| Gemini temporary file | Job duration | Explicit terminal delete; 48-hour provider expiry backstop |
| Transcript/script/notes | While post active | Explicit content purge; retain non-reversible provenance hash if needed |
| Raw Meta payload/snapshots | Product history | Purge with post/account/workspace erase; restrict access |
| Post analyses/strategies | Product history/version audit | Purge or irreversibly redact with parent erase according to approved derived-data rule |
| Detailed job/sync logs | 180 days | Aggregate safe operational metrics thereafter |
| Audit events | 1 year proposed | Minimise personal fields; policy approval required |
| Backups | Provider cycle, proposed <=35 days | Deletion ages out; restore runbook reapplies tombstones/deletion queue |

The open decision is whether derived analysis survives source-video deletion. The recommended privacy-default is: individual asset deletion purges the file but may retain structured analysis with input hash if the user explicitly confirms; full post/account/workspace erase purges both source and derived content.

## Deletion workflow

1. Authorised admin sees exact scope/downstream effects and confirms.
2. Create immutable `DeletionRequest`, mark targets inaccessible/deletion-pending and block new jobs/signed URLs.
3. Cancel safe pending work and revoke integration when in scope.
4. Traverse dependencies in documented order: provider temp files, object versions/multipart, transcript content, analyses/statistics/evidence/strategies according to scope, credentials, primary rows/tombstones.
5. Record per-system outcome without deleted content; retry transient failures.
6. Reconciler verifies no live object/provider file/current pointer remains.
7. Backup restore procedure reapplies completed deletion ledger before reopening access.

No database cascade is allowed to silently leave an object or dangling evidence.

## Dependency and supply-chain security

- Lockfile and pinned runtime/toolchain; installs use immutable lock in CI.
- Dependabot/Renovate security updates, GitHub dependency review and CodeQL/static analysis.
- Secret scanning and push protection where available.
- Review direct dependency necessity/licence/maintenance; especially OAuth, queue, media and AI SDKs.
- Minimal non-root container images, pinned image digests for production, OS/image vulnerability scans and SBOM artifact.
- Patch cadence and emergency process for `ffmpeg`/image/media parsers.
- CI workflows use least-privilege `GITHUB_TOKEN`, pin third-party actions by commit SHA and protect production environments.
- No untrusted pull-request code receives production secrets.

## Security launch checklist

- Threat model and data-flow review complete.
- Meta/Gemini/OIDC/storage/database scopes verified in production.
- Negative authorisation matrix and signed-URL abuse tests pass.
- Credential encryption/rotation/revocation and restore test pass.
- Media parser sandbox and malicious/corrupt fixture tests pass.
- Log/monitoring redaction canary test passes.
- Rate limit/idempotency/replay protections pass.
- Retention and derived-data deletion decisions approved and deletion/restore rehearsed.
- Dependency, container, secret and code scans have no unaccepted critical/high findings.
- Incident contacts and credential-revocation runbook are available.
