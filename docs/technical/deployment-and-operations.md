# Deployment and operations

## Deployment model

Deploy a production and staging environment, each containing:

- one containerised Next.js web service;
- one separately scalable long-lived Node worker using the same release image or lockstep version;
- managed PostgreSQL with automated backups and point-in-time recovery where available;
- private S3-compatible object bucket/prefix;
- provider projects/apps/credentials isolated by environment;
- error monitoring, structured log sink and uptime/metric alerts.

Recommended v1 provider shape is a managed container platform that supports both web and worker plus managed PostgreSQL (for example Render/Railway after a cost/security spike) and Cloudflare R2 or organisation-approved S3-compatible storage. Do not combine Vercel-only request functions with a fake in-request worker. Final vendor/region is an explicit open decision.

One production region near Studio Parallel (Sydney/Australia where provider availability and cost permit) is sufficient. Multi-region active/active, Kubernetes and service mesh are out of scope.

## Environment separation

- Distinct database, bucket, KMS/encryption key, Meta app/config, Gemini paid project/API key, OIDC callback/client and monitoring environment.
- Staging uses a Meta test/authorised account and rights-cleared fixture content, never production credential copies.
- Preview environments have no provider production secrets and use fake adapters by default.
- DNS/TLS/redirect/CORS allowlists are exact by environment.

## Build and release

1. CI builds a minimal non-root container from the lockfile, generates Prisma/client/contracts, runs gates, scans image and publishes by immutable digest with SBOM/provenance.
2. Release runs database migration rehearsal against a restored/schema copy.
3. Deploy web in backward-compatible mode, run `prisma migrate deploy` as a one-off locked task, then deploy worker with compatible handlers.
4. Readiness requires database/queue connectivity and valid non-secret configuration; provider reachability is reported separately, not allowed to flap the web service.
5. Smoke login, database query, enqueue/no-op job, signed object check and provider credential status.
6. Manual approval promotes production; record release SHA, schema and handler versions.

Use expand/migrate/contract for breaking schema changes. A failed migration stops rollout. Rollback reverts application image only when schema is backward compatible; destructive down migrations are not the incident plan.

## Configuration

Typed startup validation separates:

- **Secrets:** database URL, OIDC secret/client credentials, Meta app/credential encryption keys, Gemini key, storage credentials, monitoring DSN—secret manager only.
- **Safe deploy config:** environment, public origin, provider API/model versions, bucket/region identifiers, log level.
- **Runtime settings:** concurrency, sync cadence/tolerances, active prompt/schema/formula versions, upload/retention/budget thresholds—allowlisted, versioned `SystemSetting` values.

Critical runtime setting changes require admin confirmation, reason/audit and validation. Secret values are never stored as `SystemSetting`.

## Health and observability

- `/health/live`: process/event-loop basic liveness, no external calls.
- `/health/ready`: database and required queue capability plus release/schema compatibility.
- Internal integration health separately reports Meta token/scopes/last sync, Gemini last success/quota errors, object-store validation/cleanup and statistics freshness.
- Correlation ID flows from browser command to domain job, provider request and result.
- Dashboards: web latency/error, database pool/query, queue depth/oldest age/outcomes, sync coverage/429, upload/storage/cleanup, AI latency/invalid output/tokens/cost and strategy/analytics freshness.
- Alerts: auth/5xx spike, database/queue unavailable, old queue age, dead-letter growth, token expiry/revocation, no successful sync, provider failure rate, cleanup debt/storage anomaly, cost budget and error-monitoring silence.

Logs are structured and redacted according to `security-and-privacy.md`. Raw provider/AI content is not a diagnostic shortcut.

## Scheduled work

The worker or platform scheduler enqueues:

- frequent outbox/lease reconciliation;
- token-health/refresh checks daily with expiry-aware urgency;
- daily account incremental sync and due snapshot jobs (more frequent cadence configurable after proof);
- abandoned upload/Gemini file cleanup;
- analytics dirty-account recalculation/debounce;
- daily health/cost aggregates;
- retention/deletion enforcement.

Schedules create idempotent domain work and are safe if invoked twice. Timezone affects display/editorial periods; infrastructure schedules use UTC.

## Backups and recovery

- Managed encrypted PostgreSQL daily backup and point-in-time recovery; proposed retention <=35 days subject to provider/policy.
- Object versioning plus bucket lifecycle; avoid treating versioning as immutable legal archive.
- Secret/KMS recovery procedure stored outside the application repository with restricted access.
- Quarterly restore rehearsal to an isolated environment: verify relational integrity, current pointers/evidence, queue reconciliation, signed access disabled and completed deletion ledger reapplied before access.
- Recovery objectives proposed for internal v1: RPO <=24h and RTO <=8h; approve before launch.
- Do not back up ephemeral Gemini files. Reanalysis can reconstruct derived work only when approved source assets remain.

## Cost controls

- Provider budgets and alerts for Gemini; record tokens/model/request and estimated dated cost.
- Storage bytes/egress, abandoned multipart and superseded asset dashboards.
- Queue concurrency limits prevent rate/cost spikes.
- Manual confirmation for bulk-like reanalysis; v1 does not auto-reanalyse entire history on schema activation.
- PostgreSQL-backed queue avoids a separate Redis service.
- Size services from measured staging load; no pre-emptive autoscaling beyond modest web/worker limits.

## Runbooks

Create launch-time operating guides for:

1. Meta token expiring/revoked and account reconnect.
2. Meta 429/version/permission/metric-definition change.
3. Stuck/failed sync or analysis/strategy job and safe retry.
4. Gemini outage/quota/model deprecation/invalid-output spike.
5. Object upload/cleanup/storage access failure.
6. Database/queue outage, lease recovery and restore.
7. Credential suspected compromised: revoke, rotate, audit and reprocess.
8. Data/asset/transcript/account deletion and backup tombstone replay.
9. Unexpected cost spike.
10. Rollback and worker/web/schema compatibility.

Each runbook names detection, impact, safe checks, mitigations, escalation owner, customer/internal communication and verification. Commands must not expose secrets.

## Launch checklist

- Production/staging provider accounts, domains, secrets and regions approved.
- CI/release gates and protected production approval enabled.
- Database migrations, backup/PITR and isolated restore rehearsed.
- Meta live contract/token/reconnect test and Gemini paid-data settings verified.
- Private bucket/CORS/signed URL/lifecycle/deletion verified.
- Queue crash/retry/reconcile/graceful deploy exercises pass.
- Dashboards/alerts/error monitoring send and resolve a test incident.
- Cost budgets and owners configured.
- Security/privacy checklist, retention decisions and internal acceptance signed off.
- Operating guide and release/blocker list have owners.
