# PostgreSQL queue adapter

This package isolates pg-boss `12.26.3` behind the application's typed publisher and worker
contracts. Domain jobs and `job_outbox` remain the source of truth; the `pgboss` schema is delivery
mechanics and may only contain opaque internal IDs plus queue/version metadata.

## Deployment lifecycle

1. Apply Prisma migrations with `npm run db:migrate:deploy`.
2. Run `npm run queue:migrate` once as a release migration task. It applies pg-boss's own schema
   migrations, provisions every versioned queue, and fails if schema drift remains.
3. Start the worker. Runtime startup uses `migrate: false`, verifies the installed schema and queue
   policies, then begins outbox reconciliation and handler leasing.
4. During shutdown, stop reconciliation and leasing first, allow active work to finish within
   `WORKER_SHUTDOWN_GRACE_SECONDS`, then close database connections.

Do not grant the web process the `@studio-parallel/queue/worker` entry point. Web commands call the
database transaction helper to create/deduplicate a domain job and its outbox record; the worker
publishes that record after commit. The in-process driver uses the same envelope and handler
contracts for deterministic unit tests.

Queue names are physicalised as `<domain-name>.v<handler-version>`. A delivery uses the domain job
UUID as both its pg-boss job ID and singleton key, so replay after a crash returns the existing
delivery instead of creating a second logical job.
