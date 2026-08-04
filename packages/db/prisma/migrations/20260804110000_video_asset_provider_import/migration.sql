-- CreateEnum
CREATE TYPE "video_asset_origin" AS ENUM ('USER_UPLOAD', 'PROVIDER_IMPORT');

-- AlterTable
-- Every existing asset arrived through a browser upload, so the default is the
-- truth for all of them and no backfill is needed.
ALTER TABLE "video_assets"
ADD COLUMN "origin" "video_asset_origin" NOT NULL DEFAULT 'USER_UPLOAD',
ADD COLUMN "import_job_id" UUID,
ALTER COLUMN "upload_intent_id" DROP NOT NULL;

-- CreateIndex
-- The import's replay anchor. It does what the unique intent does for an
-- upload: a redelivered import resolves to the asset it already created rather
-- than writing a second object into the bucket.
CREATE UNIQUE INDEX "video_assets_workspace_id_import_job_id_key" ON "video_assets"("workspace_id", "import_job_id");

-- An asset has exactly one provenance. Without this, relaxing upload_intent_id
-- would allow a row that came from nowhere, and the origin column could
-- disagree with the anchor that actually produced the bytes.
ALTER TABLE "video_assets"
ADD CONSTRAINT "video_assets_single_provenance_check"
CHECK (num_nonnulls("upload_intent_id", "import_job_id") = 1),
ADD CONSTRAINT "video_assets_origin_matches_provenance_check"
CHECK (("origin" = 'USER_UPLOAD') = ("upload_intent_id" IS NOT NULL));
