-- Analytics calculation runs, and the debounce that decides when one is due.
--
-- A run exists so activation can be atomic. Statistics are written while the run
-- is BUILDING and are invisible to readers, who only ever see the statistics of
-- the one ACTIVE run; flipping that pointer is a single statement, so a reader
-- sees the old complete set or the new complete set and never a mixture.
--
-- Superseded runs are retained. A stored strategy cites a statistic, and that
-- statistic belongs to the run that produced it.

-- CreateEnum
CREATE TYPE "analytics_run_state" AS ENUM ('BUILDING', 'ACTIVE', 'SUPERSEDED', 'FAILED');

-- AlterTable
ALTER TABLE "account_feature_statistics" ADD COLUMN     "calculation_run_id" UUID NOT NULL;

-- AlterTable
ALTER TABLE "instagram_accounts" ADD COLUMN     "analytics_dirty_since" TIMESTAMPTZ(3),
ADD COLUMN     "analytics_due_at" TIMESTAMPTZ(3);

-- CreateTable
CREATE TABLE "account_analytics_runs" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "instagram_account_id" UUID NOT NULL,
    "state" "analytics_run_state" NOT NULL DEFAULT 'BUILDING',
    "age_window" VARCHAR(16) NOT NULL,
    "published_from" TIMESTAMPTZ(3) NOT NULL,
    "published_to" TIMESTAMPTZ(3) NOT NULL,
    "input_fingerprint" CHAR(64) NOT NULL,
    "statistic_count" INTEGER NOT NULL DEFAULT 0,
    "analysis_count" INTEGER NOT NULL DEFAULT 0,
    "analytics_version" VARCHAR(64) NOT NULL,
    "statistics_version" VARCHAR(64) NOT NULL,
    "started_at" TIMESTAMPTZ(3) NOT NULL,
    "activated_at" TIMESTAMPTZ(3),
    "duration_ms" INTEGER,
    "failure_code" VARCHAR(64),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "account_analytics_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "analytics_runs_account_started_idx" ON "account_analytics_runs"("workspace_id", "instagram_account_id", "started_at" DESC);

-- CreateIndex
CREATE INDEX "analytics_runs_state_idx" ON "account_analytics_runs"("workspace_id", "state");

-- CreateIndex
CREATE UNIQUE INDEX "account_analytics_runs_workspace_id_id_key" ON "account_analytics_runs"("workspace_id", "id");

-- AddForeignKey
ALTER TABLE "account_feature_statistics" ADD CONSTRAINT "account_feature_statistics_workspace_id_calculation_run_id_fkey" FOREIGN KEY ("workspace_id", "calculation_run_id") REFERENCES "account_analytics_runs"("workspace_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "account_analytics_runs" ADD CONSTRAINT "account_analytics_runs_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "account_analytics_runs" ADD CONSTRAINT "account_analytics_runs_workspace_id_instagram_account_id_fkey" FOREIGN KEY ("workspace_id", "instagram_account_id") REFERENCES "instagram_accounts"("workspace_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Exactly one ACTIVE run per account, enforced where it cannot be raced. Prisma
-- cannot express a filtered unique index, so it lives in SQL only: two
-- concurrent activations must not both believe they published the current set.
CREATE UNIQUE INDEX "account_analytics_runs_one_active_per_account"
    ON "account_analytics_runs" ("workspace_id", "instagram_account_id")
    WHERE "state" = 'ACTIVE';

-- A run cannot be due without having been marked dirty. The debounce window is
-- meaningless otherwise, and a null pair is the only valid "clean" state.
ALTER TABLE "instagram_accounts"
    ADD CONSTRAINT "instagram_accounts_analytics_debounce_pair"
    CHECK (("analytics_dirty_since" IS NULL) = ("analytics_due_at" IS NULL));
