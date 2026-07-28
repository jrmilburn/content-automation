CREATE TYPE "internal_user_role" AS ENUM ('MEMBER', 'ADMIN');

ALTER TYPE "job_dispatch_status" ADD VALUE 'CANCELLED';
ALTER TYPE "job_attempt_state" ADD VALUE 'CANCELLED';

ALTER TABLE "internal_users"
ADD COLUMN "role" "internal_user_role" NOT NULL DEFAULT 'MEMBER';

ALTER TABLE "background_jobs"
ADD COLUMN "cancellation_requested_at" TIMESTAMPTZ(3),
ADD COLUMN "cancellation_reason_code" VARCHAR(64),
ADD COLUMN "reconciliation_required_at" TIMESTAMPTZ(3),
ADD COLUMN "reconciliation_code" VARCHAR(64);

ALTER TABLE "job_outbox"
ADD COLUMN "cancelled_at" TIMESTAMPTZ(3);

ALTER TABLE "audit_events"
ADD COLUMN "outcome" VARCHAR(32),
ADD COLUMN "reason_code" VARCHAR(64);

ALTER TABLE "background_jobs"
ADD CONSTRAINT "background_jobs_cancellation_shape_check" CHECK (
  num_nonnulls("cancellation_requested_at", "cancellation_reason_code") IN (0, 2)
),
ADD CONSTRAINT "background_jobs_cancellation_reason_safe_check" CHECK (
  "cancellation_reason_code" IS NULL OR "cancellation_reason_code" ~ '^[A-Z][A-Z0-9_]{0,63}$'
),
ADD CONSTRAINT "background_jobs_reconciliation_shape_check" CHECK (
  num_nonnulls("reconciliation_required_at", "reconciliation_code") IN (0, 2)
),
ADD CONSTRAINT "background_jobs_reconciliation_code_safe_check" CHECK (
  "reconciliation_code" IS NULL OR "reconciliation_code" ~ '^[A-Z][A-Z0-9_]{0,63}$'
);

ALTER TABLE "job_attempts"
DROP CONSTRAINT "job_attempts_timing_shape_check",
DROP CONSTRAINT "job_attempts_error_shape_check",
ADD CONSTRAINT "job_attempts_timing_shape_check" CHECK (
  ("state" = 'ACTIVE' AND "completed_at" IS NULL AND "next_attempt_at" IS NULL)
  OR ("state" = 'RETRY_SCHEDULED' AND "completed_at" IS NOT NULL AND "next_attempt_at" IS NOT NULL)
  OR ("state" IN ('SUCCEEDED', 'FAILED_ATTENTION', 'LEASE_EXPIRED', 'CANCELLED') AND "completed_at" IS NOT NULL AND "next_attempt_at" IS NULL)
),
ADD CONSTRAINT "job_attempts_error_shape_check" CHECK (
  ("state" IN ('ACTIVE', 'SUCCEEDED', 'CANCELLED') AND num_nonnulls("error_class", "error_code", "next_action") = 0)
  OR ("state" IN ('RETRY_SCHEDULED', 'FAILED_ATTENTION', 'LEASE_EXPIRED') AND num_nonnulls("error_class", "error_code", "next_action") = 3)
);

ALTER TABLE "job_outbox"
ADD CONSTRAINT "job_outbox_cancelled_lease_check" CHECK (
  "cancelled_at" IS NULL OR ("lease_id" IS NULL AND "lease_expires_at" IS NULL)
);

ALTER TABLE "audit_events"
ADD CONSTRAINT "audit_events_outcome_safe_check" CHECK (
  "outcome" IS NULL OR "outcome" ~ '^[A-Z][A-Z0-9_]{0,31}$'
),
ADD CONSTRAINT "audit_events_reason_code_safe_check" CHECK (
  "reason_code" IS NULL OR "reason_code" ~ '^[A-Z][A-Z0-9_]{0,63}$'
);

CREATE INDEX "audit_events_workspace_id_actor_user_id_action_occurred_at_idx"
ON "audit_events"("workspace_id", "actor_user_id", "action", "occurred_at");
