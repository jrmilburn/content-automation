-- CreateEnum
CREATE TYPE "instagram_metric_availability" AS ENUM ('AVAILABLE', 'UNAVAILABLE', 'NOT_APPLICABLE', 'PERMISSION_MISSING', 'PROVIDER_ERROR', 'NOT_REQUESTED');

-- CreateEnum
CREATE TYPE "instagram_snapshot_bucket" AS ENUM ('IMPORT', 'HOUR_1', 'DAY_1', 'DAY_3', 'DAY_7', 'DAY_30', 'MATURE');

-- CreateTable
CREATE TABLE "instagram_metric_snapshots" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "instagram_post_id" UUID NOT NULL,
    "sync_run_id" UUID,
    "captured_at" TIMESTAMPTZ(3) NOT NULL,
    "post_age_seconds" INTEGER NOT NULL,
    "age_bucket" "instagram_snapshot_bucket" NOT NULL,
    "api_version" VARCHAR(16) NOT NULL,
    "views" INTEGER,
    "plays" INTEGER,
    "reach" INTEGER,
    "likes" INTEGER,
    "comments" INTEGER,
    "shares" INTEGER,
    "saves" INTEGER,
    "total_interactions" INTEGER,
    "total_watch_time_ms" BIGINT,
    "average_watch_time_ms" INTEGER,
    "skip_rate" DECIMAL(6,5),
    "follows" INTEGER,
    "profile_visits" INTEGER,
    "profile_activity" INTEGER,
    "availability" JSONB NOT NULL,
    "follower_count" INTEGER,
    "raw_payload" JSONB NOT NULL,
    "raw_payload_hash" CHAR(64) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "instagram_metric_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "instagram_metric_snapshots_workspace_id_instagram_post_id_c_idx" ON "instagram_metric_snapshots"("workspace_id", "instagram_post_id", "captured_at" DESC);

-- CreateIndex
CREATE INDEX "instagram_metric_snapshots_workspace_id_instagram_post_id_p_idx" ON "instagram_metric_snapshots"("workspace_id", "instagram_post_id", "post_age_seconds");

-- CreateIndex
CREATE INDEX "instagram_metric_snapshots_workspace_id_sync_run_id_idx" ON "instagram_metric_snapshots"("workspace_id", "sync_run_id");

-- CreateIndex
CREATE UNIQUE INDEX "instagram_metric_snapshots_workspace_id_id_key" ON "instagram_metric_snapshots"("workspace_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "instagram_metric_snapshots_instagram_post_id_age_bucket_api_key" ON "instagram_metric_snapshots"("instagram_post_id", "age_bucket", "api_version", "raw_payload_hash");

-- AddForeignKey
ALTER TABLE "instagram_metric_snapshots" ADD CONSTRAINT "instagram_metric_snapshots_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "instagram_metric_snapshots" ADD CONSTRAINT "instagram_metric_snapshots_workspace_id_instagram_post_id_fkey" FOREIGN KEY ("workspace_id", "instagram_post_id") REFERENCES "instagram_posts"("workspace_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- A negative count or duration is impossible and would corrupt any rate derived
-- from it. The adapter quarantines such a value, and this refuses it outright so
-- a future writer cannot reintroduce one.
ALTER TABLE "instagram_metric_snapshots"
  ADD CONSTRAINT "instagram_metric_snapshots_counts_non_negative" CHECK (
    "post_age_seconds" >= 0
    AND ("views" IS NULL OR "views" >= 0)
    AND ("plays" IS NULL OR "plays" >= 0)
    AND ("reach" IS NULL OR "reach" >= 0)
    AND ("likes" IS NULL OR "likes" >= 0)
    AND ("comments" IS NULL OR "comments" >= 0)
    AND ("shares" IS NULL OR "shares" >= 0)
    AND ("saves" IS NULL OR "saves" >= 0)
    AND ("total_interactions" IS NULL OR "total_interactions" >= 0)
    AND ("total_watch_time_ms" IS NULL OR "total_watch_time_ms" >= 0)
    AND ("average_watch_time_ms" IS NULL OR "average_watch_time_ms" >= 0)
    AND ("follows" IS NULL OR "follows" >= 0)
    AND ("profile_visits" IS NULL OR "profile_visits" >= 0)
    AND ("profile_activity" IS NULL OR "profile_activity" >= 0)
    AND ("follower_count" IS NULL OR "follower_count" >= 0)
  );

-- A skip rate is a proportion. A value outside it means the provider contract
-- moved and must be investigated rather than stored and later divided by.
ALTER TABLE "instagram_metric_snapshots"
  ADD CONSTRAINT "instagram_metric_snapshots_skip_rate_is_a_ratio" CHECK (
    "skip_rate" IS NULL OR ("skip_rate" >= 0 AND "skip_rate" <= 1)
  );

-- Availability must account for every canonical metric, so it is an object
-- rather than an array or a scalar.
ALTER TABLE "instagram_metric_snapshots"
  ADD CONSTRAINT "instagram_metric_snapshots_availability_is_object" CHECK (
    jsonb_typeof("availability") = 'object'
  );
