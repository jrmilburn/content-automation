-- CreateEnum
CREATE TYPE "video_upload_intent_state" AS ENUM ('PENDING', 'COMPLETED', 'ABORTED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "video_asset_state" AS ENUM ('PENDING_VALIDATION', 'READY', 'REJECTED');

-- CreateTable
CREATE TABLE "video_upload_intents" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "instagram_post_id" UUID NOT NULL,
    "pending_for_post_id" UUID,
    "object_key" VARCHAR(512) NOT NULL,
    "bucket" VARCHAR(63) NOT NULL,
    "region" VARCHAR(64) NOT NULL,
    "provider_upload_id" VARCHAR(512) NOT NULL,
    "declared_bytes" BIGINT NOT NULL,
    "declared_content_type" VARCHAR(128) NOT NULL,
    "part_size_bytes" INTEGER NOT NULL,
    "part_count" INTEGER NOT NULL,
    "state" "video_upload_intent_state" NOT NULL DEFAULT 'PENDING',
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "completed_at" TIMESTAMPTZ(3),
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "video_upload_intents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "video_assets" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "instagram_post_id" UUID NOT NULL,
    "upload_intent_id" UUID NOT NULL,
    "object_key" VARCHAR(512) NOT NULL,
    "bucket" VARCHAR(63) NOT NULL,
    "region" VARCHAR(64) NOT NULL,
    "object_version" VARCHAR(256),
    "etag" VARCHAR(256) NOT NULL,
    "bytes" BIGINT NOT NULL,
    "content_type" VARCHAR(128),
    "declared_checksum_sha256" CHAR(64),
    "verified_checksum_sha256" CHAR(64),
    "state" "video_asset_state" NOT NULL DEFAULT 'PENDING_VALIDATION',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "video_assets_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "video_upload_intents_workspace_id_instagram_post_id_created_idx" ON "video_upload_intents"("workspace_id", "instagram_post_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "video_upload_intents_state_expires_at_idx" ON "video_upload_intents"("state", "expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "video_upload_intents_workspace_id_id_key" ON "video_upload_intents"("workspace_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "video_upload_intents_object_key_key" ON "video_upload_intents"("object_key");

-- CreateIndex
CREATE UNIQUE INDEX "video_upload_intents_workspace_id_pending_for_post_id_key" ON "video_upload_intents"("workspace_id", "pending_for_post_id");

-- CreateIndex
CREATE INDEX "video_assets_workspace_id_instagram_post_id_created_at_idx" ON "video_assets"("workspace_id", "instagram_post_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "video_assets_workspace_id_state_idx" ON "video_assets"("workspace_id", "state");

-- CreateIndex
CREATE UNIQUE INDEX "video_assets_workspace_id_id_key" ON "video_assets"("workspace_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "video_assets_workspace_id_upload_intent_id_key" ON "video_assets"("workspace_id", "upload_intent_id");

-- CreateIndex
CREATE UNIQUE INDEX "video_assets_object_key_key" ON "video_assets"("object_key");

-- AddForeignKey
ALTER TABLE "video_upload_intents" ADD CONSTRAINT "video_upload_intents_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "video_upload_intents" ADD CONSTRAINT "video_upload_intents_workspace_id_instagram_post_id_fkey" FOREIGN KEY ("workspace_id", "instagram_post_id") REFERENCES "instagram_posts"("workspace_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "video_upload_intents" ADD CONSTRAINT "video_upload_intents_workspace_id_created_by_user_id_fkey" FOREIGN KEY ("workspace_id", "created_by_user_id") REFERENCES "internal_users"("workspace_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "video_assets" ADD CONSTRAINT "video_assets_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "video_assets" ADD CONSTRAINT "video_assets_workspace_id_instagram_post_id_fkey" FOREIGN KEY ("workspace_id", "instagram_post_id") REFERENCES "instagram_posts"("workspace_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "video_assets" ADD CONSTRAINT "video_assets_workspace_id_upload_intent_id_fkey" FOREIGN KEY ("workspace_id", "upload_intent_id") REFERENCES "video_upload_intents"("workspace_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
