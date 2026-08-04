-- Repairs a database where `20260803060000_analytics_runs` is recorded as
-- applied but did not leave the membership table behind.
--
-- The deployed database has `account_analytics_runs` and every other table that
-- migration creates, and is missing only `account_analytics_run_statistics`.
-- Because the migration is recorded complete it can never run again, so the
-- table can only come back through a new one. Every recalculation since has
-- failed at its first write with P2021, which is why the account has nine
-- BUILDING runs and no statistic.
--
-- Written to be a no-op wherever the table already exists, so CI, a fresh
-- install and the repaired database all converge on the same schema rather than
-- this becoming a second thing to remember.

CREATE TABLE IF NOT EXISTS "account_analytics_run_statistics" (
    "workspace_id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "statistic_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "account_analytics_run_statistics_pkey" PRIMARY KEY ("workspace_id", "run_id", "statistic_id")
);

CREATE INDEX IF NOT EXISTS "analytics_run_statistics_statistic_idx"
    ON "account_analytics_run_statistics"("workspace_id", "statistic_id");

-- Foreign keys have no IF NOT EXISTS, so each is added only when absent.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'account_analytics_run_statistics_workspace_id_fkey'
    ) THEN
        ALTER TABLE "account_analytics_run_statistics"
            ADD CONSTRAINT "account_analytics_run_statistics_workspace_id_fkey"
            FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id")
            ON DELETE RESTRICT ON UPDATE CASCADE;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'account_analytics_run_statistics_workspace_id_run_id_fkey'
    ) THEN
        ALTER TABLE "account_analytics_run_statistics"
            ADD CONSTRAINT "account_analytics_run_statistics_workspace_id_run_id_fkey"
            FOREIGN KEY ("workspace_id", "run_id")
            REFERENCES "account_analytics_runs"("workspace_id", "id")
            ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'account_analytics_run_statistics_workspace_id_statistic_id_fkey'
    ) THEN
        ALTER TABLE "account_analytics_run_statistics"
            ADD CONSTRAINT "account_analytics_run_statistics_workspace_id_statistic_id_fkey"
            FOREIGN KEY ("workspace_id", "statistic_id")
            REFERENCES "account_feature_statistics"("workspace_id", "id")
            ON DELETE RESTRICT ON UPDATE CASCADE;
    END IF;
END $$;
