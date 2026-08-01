-- CreateEnum
CREATE TYPE "video_asset_rejection_code" AS ENUM ('EMPTY_OBJECT', 'BYTES_EXCEEDED', 'CHECKSUM_MISMATCH', 'CONTAINER_UNSUPPORTED', 'CONTAINER_MISMATCH', 'UNDECODABLE', 'NO_VIDEO_STREAM', 'VIDEO_CODEC_UNSUPPORTED', 'AUDIO_CODEC_UNSUPPORTED', 'DURATION_OUT_OF_RANGE', 'DIMENSIONS_OUT_OF_RANGE');

-- AlterTable
ALTER TABLE "video_assets" ADD COLUMN     "audio_codec" VARCHAR(64),
ADD COLUMN     "container_format" VARCHAR(64),
ADD COLUMN     "duration_ms" INTEGER,
ADD COLUMN     "height_px" INTEGER,
ADD COLUMN     "purge_after" TIMESTAMPTZ(3),
ADD COLUMN     "purged_at" TIMESTAMPTZ(3),
ADD COLUMN     "rejection_code" "video_asset_rejection_code",
ADD COLUMN     "validated_at" TIMESTAMPTZ(3),
ADD COLUMN     "video_codec" VARCHAR(64),
ADD COLUMN     "width_px" INTEGER;

-- CreateIndex
CREATE INDEX "video_assets_state_purge_after_idx" ON "video_assets"("state", "purge_after");
