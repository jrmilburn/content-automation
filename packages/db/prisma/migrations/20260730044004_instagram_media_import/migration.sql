-- CreateEnum
CREATE TYPE "instagram_media_kind" AS ENUM ('REEL', 'VIDEO', 'IMAGE', 'CAROUSEL_ALBUM', 'UNSUPPORTED');

-- CreateEnum
CREATE TYPE "sync_run_trigger" AS ENUM ('BOOTSTRAP', 'MANUAL', 'SCHEDULED', 'RECONCILE');

-- CreateEnum
CREATE TYPE "sync_run_state" AS ENUM ('RUNNING', 'SUCCEEDED', 'FAILED');

-- CreateTable
CREATE TABLE "instagram_posts" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "instagram_account_id" UUID NOT NULL,
    "provider_media_id" VARCHAR(64) NOT NULL,
    "media_kind" "instagram_media_kind" NOT NULL,
    "media_type" VARCHAR(32) NOT NULL,
    "media_product_type" VARCHAR(32),
    "caption" TEXT,
    "permalink" TEXT,
    "published_at" TIMESTAMPTZ(3) NOT NULL,
    "provider_thumbnail_url" TEXT,
    "first_imported_at" TIMESTAMPTZ(3) NOT NULL,
    "last_imported_at" TIMESTAMPTZ(3) NOT NULL,
    "last_sync_run_id" UUID,
    "raw_payload" JSONB NOT NULL,
    "raw_payload_hash" CHAR(64) NOT NULL,
    "raw_api_version" VARCHAR(16) NOT NULL,
    "raw_retrieved_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "instagram_posts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sync_runs" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "instagram_account_id" UUID NOT NULL,
    "trigger" "sync_run_trigger" NOT NULL,
    "idempotency_key" VARCHAR(255) NOT NULL,
    "background_job_id" UUID,
    "state" "sync_run_state" NOT NULL DEFAULT 'RUNNING',
    "stage" VARCHAR(64) NOT NULL DEFAULT 'starting',
    "horizon_start" TIMESTAMPTZ(3),
    "cursor" VARCHAR(512),
    "pages_completed" INTEGER NOT NULL DEFAULT 0,
    "items_seen" INTEGER NOT NULL DEFAULT 0,
    "items_imported" INTEGER NOT NULL DEFAULT 0,
    "items_updated" INTEGER NOT NULL DEFAULT 0,
    "items_skipped" INTEGER NOT NULL DEFAULT 0,
    "items_invalid" INTEGER NOT NULL DEFAULT 0,
    "api_version" VARCHAR(16) NOT NULL,
    "usage_summary" JSONB,
    "correlation_id" UUID NOT NULL,
    "started_at" TIMESTAMPTZ(3) NOT NULL,
    "checkpoint_at" TIMESTAMPTZ(3),
    "completed_at" TIMESTAMPTZ(3),
    "failure_class" VARCHAR(32),
    "failure_code" VARCHAR(64),
    "requested_by_user_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "sync_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "instagram_posts_workspace_id_instagram_account_id_published_idx" ON "instagram_posts"("workspace_id", "instagram_account_id", "published_at" DESC);

-- CreateIndex
CREATE INDEX "instagram_posts_workspace_id_instagram_account_id_media_kin_idx" ON "instagram_posts"("workspace_id", "instagram_account_id", "media_kind");

-- CreateIndex
CREATE INDEX "instagram_posts_workspace_id_instagram_account_id_last_impo_idx" ON "instagram_posts"("workspace_id", "instagram_account_id", "last_imported_at");

-- CreateIndex
CREATE UNIQUE INDEX "instagram_posts_workspace_id_id_key" ON "instagram_posts"("workspace_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "instagram_posts_instagram_account_id_provider_media_id_key" ON "instagram_posts"("instagram_account_id", "provider_media_id");

-- CreateIndex
CREATE INDEX "sync_runs_workspace_id_instagram_account_id_started_at_idx" ON "sync_runs"("workspace_id", "instagram_account_id", "started_at" DESC);

-- CreateIndex
CREATE INDEX "sync_runs_workspace_id_state_started_at_idx" ON "sync_runs"("workspace_id", "state", "started_at");

-- CreateIndex
CREATE INDEX "sync_runs_correlation_id_idx" ON "sync_runs"("correlation_id");

-- CreateIndex
CREATE UNIQUE INDEX "sync_runs_workspace_id_id_key" ON "sync_runs"("workspace_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "sync_runs_workspace_id_instagram_account_id_trigger_idempot_key" ON "sync_runs"("workspace_id", "instagram_account_id", "trigger", "idempotency_key");

-- AddForeignKey
ALTER TABLE "instagram_posts" ADD CONSTRAINT "instagram_posts_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "instagram_posts" ADD CONSTRAINT "instagram_posts_workspace_id_instagram_account_id_fkey" FOREIGN KEY ("workspace_id", "instagram_account_id") REFERENCES "instagram_accounts"("workspace_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sync_runs" ADD CONSTRAINT "sync_runs_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sync_runs" ADD CONSTRAINT "sync_runs_workspace_id_instagram_account_id_fkey" FOREIGN KEY ("workspace_id", "instagram_account_id") REFERENCES "instagram_accounts"("workspace_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- At most one RUNNING run may exist per account and trigger, so a manual and a
-- scheduled import can overlap but two of the same purpose cannot page the same
-- media concurrently. Finished runs are retained as history. Prisma cannot
-- express a filtered unique index, so it is created here and asserted by the
-- integration tests.
CREATE UNIQUE INDEX "sync_runs_one_running_per_account_trigger"
    ON "sync_runs" ("instagram_account_id", "trigger")
    WHERE "state" = 'RUNNING';

-- Counters are cumulative and a cursor is only ever an opaque provider token,
-- so a negative count or an empty-string cursor indicates a logic fault rather
-- than a legitimate state.
ALTER TABLE "sync_runs" ADD CONSTRAINT "sync_runs_counts_non_negative" CHECK (
    "pages_completed" >= 0
    AND "items_seen" >= 0
    AND "items_imported" >= 0
    AND "items_updated" >= 0
    AND "items_skipped" >= 0
    AND "items_invalid" >= 0
);

ALTER TABLE "sync_runs" ADD CONSTRAINT "sync_runs_cursor_not_empty" CHECK (
    "cursor" IS NULL OR length("cursor") > 0
);

-- A post cannot have been imported before it first existed here.
ALTER TABLE "instagram_posts" ADD CONSTRAINT "instagram_posts_import_order" CHECK (
    "last_imported_at" >= "first_imported_at"
);
