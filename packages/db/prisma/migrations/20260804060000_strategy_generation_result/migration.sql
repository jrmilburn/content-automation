-- CreateEnum
CREATE TYPE "strategy_generation_stage" AS ENUM ('REQUESTING', 'REPAIRING', 'PUBLISHING');

-- AlterTable
ALTER TABLE "instagram_accounts" ADD COLUMN     "current_strategy_id" UUID;

-- AlterTable
ALTER TABLE "strategy_generations" ADD COLUMN     "completed_at" TIMESTAMPTZ(3),
ADD COLUMN     "finish_reason" VARCHAR(64),
ADD COLUMN     "generated_at" TIMESTAMPTZ(3),
ADD COLUMN     "input_tokens" INTEGER,
ADD COLUMN     "model_version" VARCHAR(64),
ADD COLUMN     "output_tokens" INTEGER,
ADD COLUMN     "provider_latency_ms" INTEGER,
ADD COLUMN     "recommendation_fingerprints" TEXT[],
ADD COLUMN     "repair_attempted" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "result" JSONB,
ADD COLUMN     "stage" "strategy_generation_stage" NOT NULL DEFAULT 'REQUESTING',
ADD COLUMN     "total_tokens" INTEGER;

-- CreateIndex
CREATE UNIQUE INDEX "instagram_accounts_workspace_id_current_strategy_id_key" ON "instagram_accounts"("workspace_id", "current_strategy_id");

-- AddForeignKey
ALTER TABLE "instagram_accounts" ADD CONSTRAINT "instagram_accounts_workspace_id_current_strategy_id_fkey" FOREIGN KEY ("workspace_id", "current_strategy_id") REFERENCES "strategy_generations"("workspace_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

