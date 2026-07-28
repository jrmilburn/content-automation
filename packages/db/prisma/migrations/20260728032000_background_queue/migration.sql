-- Domain jobs are durable user-visible intent; pg-boss rows remain replaceable delivery mechanics.
CREATE TYPE "job_dispatch_status" AS ENUM ('PENDING', 'DISPATCHED');

CREATE TABLE "background_jobs" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "queue_name" VARCHAR(80) NOT NULL,
    "handler_version" INTEGER NOT NULL,
    "idempotency_key" VARCHAR(255) NOT NULL,
    "correlation_id" UUID NOT NULL,
    "dispatch_status" "job_dispatch_status" NOT NULL DEFAULT 'PENDING',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "background_jobs_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "job_outbox" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "background_job_id" UUID NOT NULL,
    "queue_name" VARCHAR(80) NOT NULL,
    "handler_version" INTEGER NOT NULL,
    "correlation_id" UUID NOT NULL,
    "dispatch_attempt_count" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lease_id" UUID,
    "lease_expires_at" TIMESTAMPTZ(3),
    "queue_delivery_id" UUID,
    "last_error_code" VARCHAR(64),
    "dispatched_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "job_outbox_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "background_jobs_workspace_id_id_key"
ON "background_jobs"("workspace_id", "id");

CREATE UNIQUE INDEX "background_jobs_workspace_id_queue_name_handler_version_ide_key"
ON "background_jobs"("workspace_id", "queue_name", "handler_version", "idempotency_key");

CREATE INDEX "background_jobs_workspace_id_dispatch_status_created_at_idx"
ON "background_jobs"("workspace_id", "dispatch_status", "created_at");

CREATE UNIQUE INDEX "job_outbox_background_job_id_key" ON "job_outbox"("background_job_id");

CREATE UNIQUE INDEX "job_outbox_workspace_id_background_job_id_key"
ON "job_outbox"("workspace_id", "background_job_id");

CREATE INDEX "job_outbox_dispatched_at_next_attempt_at_lease_expires_at_c_idx"
ON "job_outbox"("dispatched_at", "next_attempt_at", "lease_expires_at", "created_at");

CREATE INDEX "job_outbox_workspace_id_created_at_idx"
ON "job_outbox"("workspace_id", "created_at");

ALTER TABLE "background_jobs"
ADD CONSTRAINT "background_jobs_workspace_id_fkey"
FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "job_outbox"
ADD CONSTRAINT "job_outbox_workspace_id_fkey"
FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "job_outbox"
ADD CONSTRAINT "job_outbox_workspace_id_background_job_id_fkey"
FOREIGN KEY ("workspace_id", "background_job_id") REFERENCES "background_jobs"("workspace_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "background_jobs"
ADD CONSTRAINT "background_jobs_handler_version_positive_check" CHECK ("handler_version" > 0),
ADD CONSTRAINT "background_jobs_idempotency_key_nonempty_check" CHECK (length(btrim("idempotency_key")) > 0),
ADD CONSTRAINT "background_jobs_queue_name_check" CHECK ("queue_name" IN (
  'instagram.sync.account',
  'instagram.snapshot.post',
  'instagram.token.maintain',
  'asset.validate',
  'asset.cleanup',
  'analysis.run',
  'analytics.recalculate',
  'strategy.generate',
  'system.reconcile'
));

ALTER TABLE "job_outbox"
ADD CONSTRAINT "job_outbox_handler_version_positive_check" CHECK ("handler_version" > 0),
ADD CONSTRAINT "job_outbox_attempt_count_nonnegative_check" CHECK ("dispatch_attempt_count" >= 0),
ADD CONSTRAINT "job_outbox_lease_shape_check" CHECK (num_nonnulls("lease_id", "lease_expires_at") IN (0, 2)),
ADD CONSTRAINT "job_outbox_delivery_shape_check" CHECK (
  ("dispatched_at" IS NULL AND "queue_delivery_id" IS NULL)
  OR ("dispatched_at" IS NOT NULL AND "queue_delivery_id" IS NOT NULL AND "lease_id" IS NULL AND "lease_expires_at" IS NULL)
),
ADD CONSTRAINT "job_outbox_queue_name_check" CHECK ("queue_name" IN (
  'instagram.sync.account',
  'instagram.snapshot.post',
  'instagram.token.maintain',
  'asset.validate',
  'asset.cleanup',
  'analysis.run',
  'analytics.recalculate',
  'strategy.generate',
  'system.reconcile'
));
