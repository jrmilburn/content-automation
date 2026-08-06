-- CreateTable
CREATE TABLE "instagram_comments" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "instagram_post_id" UUID NOT NULL,
    "provider_comment_id" VARCHAR(64) NOT NULL,
    "parent_provider_comment_id" VARCHAR(64),
    "text" TEXT NOT NULL,
    "username" VARCHAR(120),
    "like_count" INTEGER,
    "published_at" TIMESTAMPTZ(3) NOT NULL,
    "first_imported_at" TIMESTAMPTZ(3) NOT NULL,
    "last_imported_at" TIMESTAMPTZ(3) NOT NULL,
    "raw_payload" JSONB NOT NULL,
    "raw_payload_hash" CHAR(64) NOT NULL,
    "raw_api_version" VARCHAR(16) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "instagram_comments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "instagram_comments_workspace_id_id_key" ON "instagram_comments"("workspace_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "instagram_comments_instagram_post_id_provider_comment_id_key" ON "instagram_comments"("instagram_post_id", "provider_comment_id");

-- CreateIndex
CREATE INDEX "instagram_comments_post_published_idx" ON "instagram_comments"("workspace_id", "instagram_post_id", "published_at" DESC);

-- CreateIndex
CREATE INDEX "instagram_comments_post_like_count_idx" ON "instagram_comments"("workspace_id", "instagram_post_id", "like_count" DESC);

-- AddForeignKey
ALTER TABLE "instagram_comments" ADD CONSTRAINT "instagram_comments_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "instagram_comments" ADD CONSTRAINT "instagram_comments_workspace_id_instagram_post_id_fkey" FOREIGN KEY ("workspace_id", "instagram_post_id") REFERENCES "instagram_posts"("workspace_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- A negative like count is impossible and would misreport which comments an
-- audience reacted to, which is the one thing a capped dossier selects on.
ALTER TABLE "instagram_comments"
  ADD CONSTRAINT "instagram_comments_like_count_non_negative" CHECK (
    "like_count" IS NULL OR "like_count" >= 0
  );

-- A reply cannot be its own parent. Meta has no reason to return one, and the
-- flattening in `normaliseInstagramCommentItem` cannot produce one, so a row
-- like this would mean the provider contract changed under us.
ALTER TABLE "instagram_comments"
  ADD CONSTRAINT "instagram_comments_parent_not_self" CHECK (
    "parent_provider_comment_id" IS NULL
    OR "parent_provider_comment_id" <> "provider_comment_id"
  );

-- The frozen manifest holds what the model was actually given.
--
-- This column was VARCHAR(500) holding a redacted summary, which was right when
-- the manifest carried one effect percentage per comparison. A post dossier
-- carries the post's metrics, its transcript and its comments, and a 500-char
-- summary of that is not the evidence the strategy argued from — it is a
-- description of it. Widening is the only way the freeze stays honest.
--
-- Widening a varchar to text rewrites no rows and takes no table rewrite in
-- PostgreSQL; it is a catalogue change.
ALTER TABLE "strategy_evidence" ALTER COLUMN "summary_text" TYPE TEXT;

-- The queue allowlist is written down twice: `queueDefinitions` in the domain
-- package, which application code validates against, and these constraints,
-- which the database enforces. Both tables carry the list because both are
-- written in the same transaction, so extending one alone would move the
-- failure by a statement rather than remove it. Order matches the domain
-- declaration, which `packages/db/src/migrations.test.ts` compares against.
ALTER TABLE "background_jobs" DROP CONSTRAINT "background_jobs_queue_name_check";

ALTER TABLE "background_jobs"
ADD CONSTRAINT "background_jobs_queue_name_check" CHECK ("queue_name" IN (
  'instagram.sync.account',
  'instagram.snapshot.post',
  'instagram.token.maintain',
  'instagram.media.import',
  'instagram.comments.post',
  'asset.validate',
  'asset.cleanup',
  'analysis.run',
  'analytics.recalculate',
  'strategy.generate',
  'system.reconcile'
));

ALTER TABLE "job_outbox" DROP CONSTRAINT "job_outbox_queue_name_check";

ALTER TABLE "job_outbox"
ADD CONSTRAINT "job_outbox_queue_name_check" CHECK ("queue_name" IN (
  'instagram.sync.account',
  'instagram.snapshot.post',
  'instagram.token.maintain',
  'instagram.media.import',
  'instagram.comments.post',
  'asset.validate',
  'asset.cleanup',
  'analysis.run',
  'analytics.recalculate',
  'strategy.generate',
  'system.reconcile'
));
