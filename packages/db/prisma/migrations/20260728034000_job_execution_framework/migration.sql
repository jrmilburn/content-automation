CREATE TYPE "background_job_state" AS ENUM (
  'QUEUED',
  'PROCESSING',
  'RETRY_SCHEDULED',
  'SUCCEEDED',
  'FAILED_ATTENTION',
  'CANCELLED'
);

CREATE TYPE "job_attempt_state" AS ENUM (
  'ACTIVE',
  'SUCCEEDED',
  'RETRY_SCHEDULED',
  'FAILED_ATTENTION',
  'LEASE_EXPIRED'
);

ALTER TABLE "background_jobs"
ADD COLUMN "state" "background_job_state" NOT NULL DEFAULT 'QUEUED',
ADD COLUMN "stage" VARCHAR(64) NOT NULL DEFAULT 'queued',
ADD COLUMN "priority" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "attempt_count" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "max_attempts" INTEGER NOT NULL DEFAULT 8,
ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN "resource_type" VARCHAR(64),
ADD COLUMN "resource_id" UUID,
ADD COLUMN "input_version" VARCHAR(128),
ADD COLUMN "queued_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN "started_at" TIMESTAMPTZ(3),
ADD COLUMN "heartbeat_at" TIMESTAMPTZ(3),
ADD COLUMN "lease_id" UUID,
ADD COLUMN "lease_expires_at" TIMESTAMPTZ(3),
ADD COLUMN "next_attempt_at" TIMESTAMPTZ(3),
ADD COLUMN "completed_at" TIMESTAMPTZ(3),
ADD COLUMN "last_error_class" VARCHAR(32),
ADD COLUMN "last_error_code" VARCHAR(64),
ADD COLUMN "next_action" VARCHAR(32);

CREATE TABLE "job_attempts" (
  "id" UUID NOT NULL,
  "workspace_id" UUID NOT NULL,
  "background_job_id" UUID NOT NULL,
  "attempt_number" INTEGER NOT NULL,
  "handler_version" INTEGER NOT NULL,
  "state" "job_attempt_state" NOT NULL DEFAULT 'ACTIVE',
  "stage" VARCHAR(64) NOT NULL DEFAULT 'starting',
  "lease_id" UUID NOT NULL,
  "correlation_id" UUID NOT NULL,
  "started_at" TIMESTAMPTZ(3) NOT NULL,
  "heartbeat_at" TIMESTAMPTZ(3) NOT NULL,
  "completed_at" TIMESTAMPTZ(3),
  "next_attempt_at" TIMESTAMPTZ(3),
  "error_class" VARCHAR(32),
  "error_code" VARCHAR(64),
  "next_action" VARCHAR(32),
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL,

  CONSTRAINT "job_attempts_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "background_jobs_workspace_id_state_next_attempt_at_priority_idx"
ON "background_jobs"("workspace_id", "state", "next_attempt_at", "priority", "queued_at");

CREATE INDEX "background_jobs_state_lease_expires_at_idx"
ON "background_jobs"("state", "lease_expires_at");

CREATE INDEX "background_jobs_correlation_id_idx"
ON "background_jobs"("correlation_id");

CREATE UNIQUE INDEX "job_attempts_lease_id_key" ON "job_attempts"("lease_id");

CREATE UNIQUE INDEX "job_attempts_background_job_id_attempt_number_key"
ON "job_attempts"("background_job_id", "attempt_number");

CREATE INDEX "job_attempts_workspace_id_state_started_at_idx"
ON "job_attempts"("workspace_id", "state", "started_at");

CREATE INDEX "job_attempts_background_job_id_completed_at_idx"
ON "job_attempts"("background_job_id", "completed_at");

ALTER TABLE "job_attempts"
ADD CONSTRAINT "job_attempts_workspace_id_fkey"
FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "job_attempts"
ADD CONSTRAINT "job_attempts_workspace_id_background_job_id_fkey"
FOREIGN KEY ("workspace_id", "background_job_id") REFERENCES "background_jobs"("workspace_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "background_jobs"
ADD CONSTRAINT "background_jobs_priority_range_check" CHECK ("priority" BETWEEN -1000 AND 1000),
ADD CONSTRAINT "background_jobs_attempt_count_check" CHECK (
  "attempt_count" >= 0 AND "max_attempts" BETWEEN 1 AND 100 AND "attempt_count" <= "max_attempts"
),
ADD CONSTRAINT "background_jobs_version_positive_check" CHECK ("version" > 0),
ADD CONSTRAINT "background_jobs_stage_safe_check" CHECK ("stage" ~ '^[a-z][a-z0-9_]{0,63}$'),
ADD CONSTRAINT "background_jobs_resource_type_safe_check" CHECK (
  "resource_type" IS NULL OR "resource_type" ~ '^[a-z][a-z0-9_]{0,63}$'
),
ADD CONSTRAINT "background_jobs_resource_shape_check" CHECK (
  num_nonnulls("resource_type", "resource_id") IN (0, 2)
),
ADD CONSTRAINT "background_jobs_input_version_safe_check" CHECK (
  "input_version" IS NULL OR "input_version" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
),
ADD CONSTRAINT "background_jobs_lease_shape_check" CHECK (
  ("state" = 'PROCESSING' AND "lease_id" IS NOT NULL AND "lease_expires_at" IS NOT NULL AND "heartbeat_at" IS NOT NULL AND "completed_at" IS NULL)
  OR ("state" <> 'PROCESSING' AND "lease_id" IS NULL AND "lease_expires_at" IS NULL)
),
ADD CONSTRAINT "background_jobs_timing_shape_check" CHECK (
  ("state" = 'RETRY_SCHEDULED' AND "next_attempt_at" IS NOT NULL AND "completed_at" IS NULL)
  OR ("state" IN ('SUCCEEDED', 'FAILED_ATTENTION', 'CANCELLED') AND "next_attempt_at" IS NULL AND "completed_at" IS NOT NULL)
  OR ("state" IN ('QUEUED', 'PROCESSING') AND "next_attempt_at" IS NULL AND "completed_at" IS NULL)
),
ADD CONSTRAINT "background_jobs_error_shape_check" CHECK (
  num_nonnulls("last_error_class", "last_error_code", "next_action") IN (0, 3)
);

ALTER TABLE "job_attempts"
ADD CONSTRAINT "job_attempts_attempt_number_positive_check" CHECK ("attempt_number" > 0),
ADD CONSTRAINT "job_attempts_handler_version_positive_check" CHECK ("handler_version" > 0),
ADD CONSTRAINT "job_attempts_stage_safe_check" CHECK ("stage" ~ '^[a-z][a-z0-9_]{0,63}$'),
ADD CONSTRAINT "job_attempts_timing_shape_check" CHECK (
  ("state" = 'ACTIVE' AND "completed_at" IS NULL AND "next_attempt_at" IS NULL)
  OR ("state" = 'RETRY_SCHEDULED' AND "completed_at" IS NOT NULL AND "next_attempt_at" IS NOT NULL)
  OR ("state" IN ('SUCCEEDED', 'FAILED_ATTENTION', 'LEASE_EXPIRED') AND "completed_at" IS NOT NULL AND "next_attempt_at" IS NULL)
),
ADD CONSTRAINT "job_attempts_error_shape_check" CHECK (
  ("state" IN ('ACTIVE', 'SUCCEEDED') AND num_nonnulls("error_class", "error_code", "next_action") = 0)
  OR ("state" IN ('RETRY_SCHEDULED', 'FAILED_ATTENTION', 'LEASE_EXPIRED') AND num_nonnulls("error_class", "error_code", "next_action") = 3)
);
