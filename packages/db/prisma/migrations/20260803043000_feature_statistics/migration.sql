-- Feature statistics: one immutable statement about one feature value
-- against one metric, plus the posts that produced it.
--
-- Rows are never updated. A recalculation writes a new row with a new input
-- fingerprint and leaves the old one, because a stored strategy that cited a
-- statistic must still resolve exactly what it cited; rewriting the number
-- under it would silently change what a published claim meant.
--
-- The unique key is the question plus the inputs, so recalculating over
-- unchanged data collapses onto the existing row rather than accumulating
-- duplicates that differ only by calculation time.

-- CreateEnum
CREATE TYPE "feature_statistic_confidence" AS ENUM ('INSUFFICIENT_EVIDENCE', 'SINGLE_POST_OUTLIER', 'WEAK_DIRECTIONAL_SIGNAL', 'MODERATE_ASSOCIATION', 'STATISTICALLY_SUPPORTED_ASSOCIATION');

-- CreateTable
CREATE TABLE "account_feature_statistics" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "instagram_account_id" UUID NOT NULL,
    "feature_path" VARCHAR(128) NOT NULL,
    "feature_value" VARCHAR(64) NOT NULL,
    "metric" VARCHAR(64) NOT NULL,
    "age_window" VARCHAR(16) NOT NULL,
    "published_from" TIMESTAMPTZ(3) NOT NULL,
    "published_to" TIMESTAMPTZ(3) NOT NULL,
    "group_count" INTEGER NOT NULL,
    "comparison_count" INTEGER NOT NULL,
    "group_median" DECIMAL(20,8),
    "group_iqr" DECIMAL(20,8),
    "comparison_median" DECIMAL(20,8),
    "comparison_iqr" DECIMAL(20,8),
    "difference_of_medians" DECIMAL(20,8),
    "relative_effect" DECIMAL(20,8),
    "interval_lower" DECIMAL(20,8),
    "interval_upper" DECIMAL(20,8),
    "interval_confidence" DECIMAL(4,3),
    "bootstrap_seed" BIGINT,
    "bootstrap_resamples" INTEGER,
    "confidence" "feature_statistic_confidence" NOT NULL,
    "classification_reason" VARCHAR(64) NOT NULL,
    "top_contributor_share" DECIMAL(6,5),
    "sensitivity_holds_direction" BOOLEAN,
    "missing_ratio" DECIMAL(6,5) NOT NULL,
    "distinct_publication_dates" INTEGER NOT NULL,
    "distinct_publication_weeks" INTEGER NOT NULL,
    "multiple_testing_applied" BOOLEAN NOT NULL DEFAULT false,
    "analytics_version" VARCHAR(64) NOT NULL,
    "statistics_version" VARCHAR(64) NOT NULL,
    "cohort_version" VARCHAR(64) NOT NULL,
    "analysis_schema_version" VARCHAR(64) NOT NULL,
    "input_fingerprint" CHAR(64) NOT NULL,
    "calculated_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "account_feature_statistics_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "account_feature_statistic_posts" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "statistic_id" UUID NOT NULL,
    "instagram_post_id" UUID NOT NULL,
    "metric_snapshot_id" UUID NOT NULL,
    "post_analysis_id" UUID NOT NULL,
    "membership" VARCHAR(16) NOT NULL,
    "value" DECIMAL(20,8) NOT NULL,

    CONSTRAINT "account_feature_statistic_posts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "account_feature_statistics_account_calculated_at_idx" ON "account_feature_statistics"("workspace_id", "instagram_account_id", "calculated_at" DESC);

-- CreateIndex
CREATE INDEX "account_feature_statistics_account_confidence_idx" ON "account_feature_statistics"("workspace_id", "instagram_account_id", "confidence");

-- CreateIndex
CREATE INDEX "account_feature_statistics_account_feature_metric_idx" ON "account_feature_statistics"("workspace_id", "instagram_account_id", "feature_path", "metric");

-- CreateIndex
CREATE UNIQUE INDEX "account_feature_statistics_workspace_id_id_key" ON "account_feature_statistics"("workspace_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "account_feature_statistics_question_inputs_key" ON "account_feature_statistics"("workspace_id", "instagram_account_id", "feature_path", "feature_value", "metric", "age_window", "input_fingerprint");

-- CreateIndex
CREATE INDEX "account_feature_statistic_posts_workspace_id_instagram_post_idx" ON "account_feature_statistic_posts"("workspace_id", "instagram_post_id");

-- CreateIndex
CREATE UNIQUE INDEX "account_feature_statistic_posts_workspace_id_id_key" ON "account_feature_statistic_posts"("workspace_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "account_feature_statistic_posts_statistic_id_instagram_post_key" ON "account_feature_statistic_posts"("statistic_id", "instagram_post_id");

-- AddForeignKey
ALTER TABLE "account_feature_statistics" ADD CONSTRAINT "account_feature_statistics_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "account_feature_statistics" ADD CONSTRAINT "account_feature_statistics_workspace_id_instagram_account__fkey" FOREIGN KEY ("workspace_id", "instagram_account_id") REFERENCES "instagram_accounts"("workspace_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "account_feature_statistic_posts" ADD CONSTRAINT "account_feature_statistic_posts_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "account_feature_statistic_posts" ADD CONSTRAINT "account_feature_statistic_posts_workspace_id_statistic_id_fkey" FOREIGN KEY ("workspace_id", "statistic_id") REFERENCES "account_feature_statistics"("workspace_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;
