-- Analysis pipeline: one durable request per post input set, and one
-- immutable validated analysis per request.
--
-- AnalysisJob exists alongside BackgroundJob because two facts must survive a
-- crash that the generic job row cannot carry: the fixed inputs frozen at
-- request time, and the provider file name, so paid bytes can be released or
-- reused rather than abandoned to their 48-hour expiry.
--
-- The current-analysis pointer lives on the post and moves in the same
-- transaction that inserts the analysis, so nothing observes a post between two
-- current analyses.

-- CreateEnum
CREATE TYPE "analysis_job_stage" AS ENUM ('QUEUED', 'UPLOADING', 'AWAITING_FILE', 'REQUESTING', 'VALIDATING', 'REPAIRING', 'PUBLISHED', 'ABANDONED');

-- AlterTable
ALTER TABLE "instagram_posts" ADD COLUMN     "current_analysis_id" UUID;

-- CreateTable
CREATE TABLE "analysis_jobs" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "background_job_id" UUID NOT NULL,
    "instagram_post_id" UUID NOT NULL,
    "video_asset_id" UUID NOT NULL,
    "transcript_revision_id" UUID,
    "request_signature" CHAR(64) NOT NULL,
    "schema_version" VARCHAR(64) NOT NULL,
    "prompt_version" VARCHAR(64) NOT NULL,
    "model_requested" VARCHAR(64) NOT NULL,
    "stage" "analysis_job_stage" NOT NULL DEFAULT 'QUEUED',
    "provider_file_name" VARCHAR(128),
    "provider_file_expires_at" TIMESTAMPTZ(3),
    "repair_attempted" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "analysis_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "post_analyses" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "instagram_post_id" UUID NOT NULL,
    "analysis_job_id" UUID NOT NULL,
    "video_asset_id" UUID NOT NULL,
    "transcript_revision_id" UUID,
    "request_signature" CHAR(64) NOT NULL,
    "schema_version" VARCHAR(64) NOT NULL,
    "schema_sha256" CHAR(64) NOT NULL,
    "prompt_version" VARCHAR(64) NOT NULL,
    "prompt_sha256" CHAR(64) NOT NULL,
    "model_requested" VARCHAR(64) NOT NULL,
    "model_version" VARCHAR(64),
    "analysed_at" TIMESTAMPTZ(3) NOT NULL,
    "result" JSONB NOT NULL,
    "content_pillar" VARCHAR(64),
    "content_format" VARCHAR(64),
    "hook_category" VARCHAR(64),
    "presenter_mode" VARCHAR(64),
    "cta_type" VARCHAR(64),
    "duration_seconds" DECIMAL(10,3),
    "overall_confidence" VARCHAR(16) NOT NULL,
    "validation_warnings" JSONB NOT NULL,
    "input_tokens" INTEGER,
    "output_tokens" INTEGER,
    "total_tokens" INTEGER,
    "provider_latency_ms" INTEGER,
    "finish_reason" VARCHAR(64),
    "analytics_eligible" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "post_analyses_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "analysis_jobs_workspace_id_instagram_post_id_created_at_idx" ON "analysis_jobs"("workspace_id", "instagram_post_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "analysis_jobs_workspace_id_request_signature_idx" ON "analysis_jobs"("workspace_id", "request_signature");

-- CreateIndex
CREATE INDEX "analysis_jobs_stage_provider_file_expires_at_idx" ON "analysis_jobs"("stage", "provider_file_expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "analysis_jobs_workspace_id_id_key" ON "analysis_jobs"("workspace_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "analysis_jobs_workspace_id_background_job_id_key" ON "analysis_jobs"("workspace_id", "background_job_id");

-- CreateIndex
CREATE INDEX "post_analyses_workspace_id_instagram_post_id_analysed_at_idx" ON "post_analyses"("workspace_id", "instagram_post_id", "analysed_at" DESC);

-- CreateIndex
CREATE INDEX "post_analyses_workspace_id_analytics_eligible_content_pilla_idx" ON "post_analyses"("workspace_id", "analytics_eligible", "content_pillar");

-- CreateIndex
CREATE INDEX "post_analyses_workspace_id_analytics_eligible_hook_category_idx" ON "post_analyses"("workspace_id", "analytics_eligible", "hook_category");

-- CreateIndex
CREATE UNIQUE INDEX "post_analyses_workspace_id_id_key" ON "post_analyses"("workspace_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "post_analyses_workspace_id_analysis_job_id_key" ON "post_analyses"("workspace_id", "analysis_job_id");

-- CreateIndex
CREATE UNIQUE INDEX "post_analyses_workspace_id_request_signature_key" ON "post_analyses"("workspace_id", "request_signature");

-- CreateIndex
CREATE UNIQUE INDEX "instagram_posts_workspace_id_current_analysis_id_key" ON "instagram_posts"("workspace_id", "current_analysis_id");

-- AddForeignKey
ALTER TABLE "instagram_posts" ADD CONSTRAINT "instagram_posts_workspace_id_current_analysis_id_fkey" FOREIGN KEY ("workspace_id", "current_analysis_id") REFERENCES "post_analyses"("workspace_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "analysis_jobs" ADD CONSTRAINT "analysis_jobs_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "analysis_jobs" ADD CONSTRAINT "analysis_jobs_workspace_id_background_job_id_fkey" FOREIGN KEY ("workspace_id", "background_job_id") REFERENCES "background_jobs"("workspace_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "analysis_jobs" ADD CONSTRAINT "analysis_jobs_workspace_id_instagram_post_id_fkey" FOREIGN KEY ("workspace_id", "instagram_post_id") REFERENCES "instagram_posts"("workspace_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "analysis_jobs" ADD CONSTRAINT "analysis_jobs_workspace_id_video_asset_id_fkey" FOREIGN KEY ("workspace_id", "video_asset_id") REFERENCES "video_assets"("workspace_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "post_analyses" ADD CONSTRAINT "post_analyses_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "post_analyses" ADD CONSTRAINT "post_analyses_workspace_id_instagram_post_id_fkey" FOREIGN KEY ("workspace_id", "instagram_post_id") REFERENCES "instagram_posts"("workspace_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "post_analyses" ADD CONSTRAINT "post_analyses_workspace_id_analysis_job_id_fkey" FOREIGN KEY ("workspace_id", "analysis_job_id") REFERENCES "analysis_jobs"("workspace_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
