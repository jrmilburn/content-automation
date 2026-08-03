-- CreateEnum
CREATE TYPE "strategy_generation_state" AS ENUM ('PENDING', 'PROCESSING', 'SUCCEEDED', 'FAILED');

-- CreateEnum
CREATE TYPE "strategy_mode" AS ENUM ('EVIDENCE_LED', 'EXPLORATORY');

-- CreateEnum
CREATE TYPE "strategy_evidence_type" AS ENUM ('FEATURE_STATISTIC', 'POST_ANALYSIS', 'METRIC_SNAPSHOT', 'POST', 'DATA_QUALITY', 'RECENT_RECOMMENDATION');

-- CreateEnum
CREATE TYPE "strategy_evidence_category" AS ENUM ('POSITIVE_STATISTIC', 'NEGATIVE_STATISTIC', 'COUNTEREXAMPLE', 'TOP_POST', 'WEAK_POST', 'RECENT_POST', 'COMPARATOR_POST', 'DISTRIBUTION', 'RECENT_STRATEGY', 'DATA_QUALITY');

-- CreateTable
CREATE TABLE "strategy_generations" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "instagram_account_id" UUID NOT NULL,
    "background_job_id" UUID NOT NULL,
    "analytics_run_id" UUID NOT NULL,
    "state" "strategy_generation_state" NOT NULL DEFAULT 'PENDING',
    "mode" "strategy_mode" NOT NULL,
    "primary_metric" VARCHAR(64) NOT NULL,
    "age_window" VARCHAR(16) NOT NULL,
    "requested_period_days" INTEGER NOT NULL,
    "published_from" TIMESTAMPTZ(3) NOT NULL,
    "published_to" TIMESTAMPTZ(3) NOT NULL,
    "pillar_emphasis" TEXT[],
    "format_emphasis" TEXT[],
    "editorial_constraint" VARCHAR(1000),
    "analysed_post_count" INTEGER NOT NULL,
    "comparable_post_count" INTEGER NOT NULL,
    "publication_week_count" INTEGER NOT NULL,
    "evidence_count" INTEGER NOT NULL,
    "post_evidence_count" INTEGER NOT NULL,
    "statistic_evidence_count" INTEGER NOT NULL,
    "estimated_input_tokens" INTEGER NOT NULL,
    "manifest_hash" CHAR(64) NOT NULL,
    "request_signature" CHAR(64) NOT NULL,
    "regeneration_ordinal" INTEGER NOT NULL DEFAULT 0,
    "regenerated_from_id" UUID,
    "retrieval_version" VARCHAR(64) NOT NULL,
    "analytics_version" VARCHAR(64) NOT NULL,
    "statistics_version" VARCHAR(64) NOT NULL,
    "cohort_version" VARCHAR(64) NOT NULL,
    "analysis_schema_version" VARCHAR(64) NOT NULL,
    "strategy_schema_version" VARCHAR(64) NOT NULL,
    "strategy_schema_sha256" CHAR(64) NOT NULL,
    "strategy_prompt_version" VARCHAR(64) NOT NULL,
    "strategy_prompt_sha256" CHAR(64) NOT NULL,
    "model_requested" VARCHAR(64) NOT NULL,
    "correlation_id" UUID NOT NULL,
    "requested_by_user_id" UUID,
    "requested_at" TIMESTAMPTZ(3) NOT NULL,
    "frozen_at" TIMESTAMPTZ(3) NOT NULL,
    "failure_class" VARCHAR(32),
    "failure_code" VARCHAR(64),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "strategy_generations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "strategy_evidence" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "strategy_generation_id" UUID NOT NULL,
    "evidence_key" VARCHAR(80) NOT NULL,
    "evidence_type" "strategy_evidence_type" NOT NULL,
    "category" "strategy_evidence_category" NOT NULL,
    "retrieval_reason" VARCHAR(64) NOT NULL,
    "rank" INTEGER NOT NULL,
    "rank_score" DECIMAL(20,8),
    "allowed_roles" TEXT[],
    "classification" "feature_statistic_confidence",
    "dimensions" TEXT[],
    "sample_size" INTEGER,
    "allowed_numeric_claims" TEXT[],
    "required_in_limitations" BOOLEAN NOT NULL DEFAULT false,
    "summary_text" VARCHAR(500) NOT NULL,
    "summary_hash" CHAR(64) NOT NULL,
    "feature_statistic_id" UUID,
    "post_analysis_id" UUID,
    "metric_snapshot_id" UUID,
    "instagram_post_id" UUID,
    "source_generation_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "strategy_evidence_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "strategy_generations_account_requested_idx" ON "strategy_generations"("workspace_id", "instagram_account_id", "requested_at" DESC);

-- CreateIndex
CREATE INDEX "strategy_generations_state_idx" ON "strategy_generations"("workspace_id", "state");

-- CreateIndex
CREATE INDEX "strategy_generations_manifest_idx" ON "strategy_generations"("workspace_id", "manifest_hash");

-- CreateIndex
CREATE UNIQUE INDEX "strategy_generations_workspace_id_id_key" ON "strategy_generations"("workspace_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "strategy_generations_workspace_id_background_job_id_key" ON "strategy_generations"("workspace_id", "background_job_id");

-- CreateIndex
CREATE UNIQUE INDEX "strategy_generations_workspace_id_request_signature_key" ON "strategy_generations"("workspace_id", "request_signature");

-- CreateIndex
CREATE INDEX "strategy_evidence_generation_rank_idx" ON "strategy_evidence"("workspace_id", "strategy_generation_id", "category", "rank");

-- CreateIndex
CREATE INDEX "strategy_evidence_statistic_idx" ON "strategy_evidence"("workspace_id", "feature_statistic_id");

-- CreateIndex
CREATE INDEX "strategy_evidence_post_idx" ON "strategy_evidence"("workspace_id", "instagram_post_id");

-- CreateIndex
CREATE UNIQUE INDEX "strategy_evidence_workspace_id_id_key" ON "strategy_evidence"("workspace_id", "id");

-- AddForeignKey
ALTER TABLE "strategy_generations" ADD CONSTRAINT "strategy_generations_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "strategy_generations" ADD CONSTRAINT "strategy_generations_workspace_id_instagram_account_id_fkey" FOREIGN KEY ("workspace_id", "instagram_account_id") REFERENCES "instagram_accounts"("workspace_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "strategy_generations" ADD CONSTRAINT "strategy_generations_workspace_id_background_job_id_fkey" FOREIGN KEY ("workspace_id", "background_job_id") REFERENCES "background_jobs"("workspace_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "strategy_generations" ADD CONSTRAINT "strategy_generations_workspace_id_analytics_run_id_fkey" FOREIGN KEY ("workspace_id", "analytics_run_id") REFERENCES "account_analytics_runs"("workspace_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "strategy_generations" ADD CONSTRAINT "strategy_generations_workspace_id_requested_by_user_id_fkey" FOREIGN KEY ("workspace_id", "requested_by_user_id") REFERENCES "internal_users"("workspace_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "strategy_generations" ADD CONSTRAINT "strategy_generations_workspace_id_regenerated_from_id_fkey" FOREIGN KEY ("workspace_id", "regenerated_from_id") REFERENCES "strategy_generations"("workspace_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "strategy_evidence" ADD CONSTRAINT "strategy_evidence_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "strategy_evidence" ADD CONSTRAINT "strategy_evidence_workspace_id_strategy_generation_id_fkey" FOREIGN KEY ("workspace_id", "strategy_generation_id") REFERENCES "strategy_generations"("workspace_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "strategy_evidence" ADD CONSTRAINT "strategy_evidence_workspace_id_feature_statistic_id_fkey" FOREIGN KEY ("workspace_id", "feature_statistic_id") REFERENCES "account_feature_statistics"("workspace_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "strategy_evidence" ADD CONSTRAINT "strategy_evidence_workspace_id_post_analysis_id_fkey" FOREIGN KEY ("workspace_id", "post_analysis_id") REFERENCES "post_analyses"("workspace_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "strategy_evidence" ADD CONSTRAINT "strategy_evidence_workspace_id_metric_snapshot_id_fkey" FOREIGN KEY ("workspace_id", "metric_snapshot_id") REFERENCES "instagram_metric_snapshots"("workspace_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "strategy_evidence" ADD CONSTRAINT "strategy_evidence_workspace_id_instagram_post_id_fkey" FOREIGN KEY ("workspace_id", "instagram_post_id") REFERENCES "instagram_posts"("workspace_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "strategy_evidence" ADD CONSTRAINT "strategy_evidence_workspace_id_source_generation_id_fkey" FOREIGN KEY ("workspace_id", "source_generation_id") REFERENCES "strategy_generations"("workspace_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- The constraints below are not expressible in the Prisma schema and are
-- maintained here by hand. Each one is a rule the frozen manifest depends on,
-- so a ranking bug becomes an insert failure rather than a corrupted manifest.

-- One entry per opaque key per generation. The key is what the model cites, so
-- two rows sharing one would make a citation ambiguous.
CREATE UNIQUE INDEX "strategy_evidence_manifest_key"
  ON "strategy_evidence" ("strategy_generation_id", "evidence_key");

-- One entry per referenced record per generation. This is the deduplication
-- guarantee in the database rather than only in the ranker: the same statistic
-- selected by two categories, or a post already carried by a statistic, would
-- otherwise present one observation as two pieces of agreement.
CREATE UNIQUE INDEX "strategy_evidence_manifest_reference"
  ON "strategy_evidence" (
    "strategy_generation_id",
    "evidence_type",
    COALESCE(
      "feature_statistic_id",
      "post_analysis_id",
      "metric_snapshot_id",
      "instagram_post_id",
      "source_generation_id"
    )
  )
  WHERE COALESCE(
    "feature_statistic_id",
    "post_analysis_id",
    "metric_snapshot_id",
    "instagram_post_id",
    "source_generation_id"
  ) IS NOT NULL;

-- Exactly one reference for row-backed evidence, and none for evidence that is
-- synthesised. Without this a data-quality row could quietly carry a post ID
-- that nothing enforces, or a statistic row could carry none and reference
-- nothing at all.
ALTER TABLE "strategy_evidence"
  ADD CONSTRAINT "strategy_evidence_reference_arity" CHECK (
    (
      "evidence_type" = 'DATA_QUALITY'
      AND "feature_statistic_id" IS NULL
      AND "post_analysis_id" IS NULL
      AND "metric_snapshot_id" IS NULL
      AND "instagram_post_id" IS NULL
      AND "source_generation_id" IS NULL
    )
    OR (
      "evidence_type" <> 'DATA_QUALITY'
      AND (
        ("feature_statistic_id" IS NOT NULL)::int
        + ("post_analysis_id" IS NOT NULL)::int
        + ("metric_snapshot_id" IS NOT NULL)::int
        + ("instagram_post_id" IS NOT NULL)::int
        + ("source_generation_id" IS NOT NULL)::int
      ) = 1
    )
  );

-- A rank is a position within a category and starts at zero.
ALTER TABLE "strategy_evidence"
  ADD CONSTRAINT "strategy_evidence_rank_non_negative" CHECK ("rank" >= 0);

-- A regeneration ordinal separates an explicit repeat from the request it
-- repeats, so it can never run backwards.
ALTER TABLE "strategy_generations"
  ADD CONSTRAINT "strategy_generations_ordinal_non_negative"
  CHECK ("regeneration_ordinal" >= 0);

-- The effective evidence window is the active run's and cannot be inverted.
ALTER TABLE "strategy_generations"
  ADD CONSTRAINT "strategy_generations_period_ordered"
  CHECK ("published_from" <= "published_to");
