-- A run and its statistics may now span every linked account instead of one.
--
-- The scope is carried by `instagram_account_id` itself: a row naming an account
-- describes that account, and a null one describes the workspace. A separate
-- discriminator column would have allowed the two to disagree, and there is no
-- third scope for it to express.
--
-- Both composite foreign keys stay as they are. They are MATCH SIMPLE, so a row
-- with a null account is not checked against `instagram_accounts` rather than
-- failing it, which is exactly the behaviour a workspace-wide row needs.
ALTER TABLE "account_analytics_runs" ALTER COLUMN "instagram_account_id" DROP NOT NULL;

ALTER TABLE "account_feature_statistics" ALTER COLUMN "instagram_account_id" DROP NOT NULL;

-- Both unique indexes below have to be rebuilt rather than left alone, and the
-- reason is the whole risk of this migration.
--
-- A unique index treats nulls as distinct by default, so every workspace-wide
-- row would be unique from every other one on the strength of the null alone.
-- The dedupe key would stop collapsing repeat calculations and accumulate a new
-- row per run; the active-run index would stop being able to say "one", and two
-- concurrent activations could both believe they had published the current set.
-- Neither failure raises an error — they just quietly stop enforcing. `NULLS NOT
-- DISTINCT` is what keeps both meaning what their names claim.
DROP INDEX "account_feature_statistics_question_inputs_key";

CREATE UNIQUE INDEX "account_feature_statistics_question_inputs_key"
    ON "account_feature_statistics" (
      "workspace_id",
      "instagram_account_id",
      "feature_path",
      "feature_value",
      "metric",
      "age_window",
      "input_fingerprint"
    )
    NULLS NOT DISTINCT;

DROP INDEX "account_analytics_runs_one_active_per_account";

-- Renamed as well as rebuilt: it is now one ACTIVE run per scope, and a
-- workspace-wide run is not an account's.
CREATE UNIQUE INDEX "account_analytics_runs_one_active_per_scope"
    ON "account_analytics_runs" ("workspace_id", "instagram_account_id")
    NULLS NOT DISTINCT
    WHERE "state" = 'ACTIVE';
