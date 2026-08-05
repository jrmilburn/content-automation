-- CreateEnum
CREATE TYPE "chat_message_role" AS ENUM ('USER', 'ASSISTANT');

-- CreateTable
CREATE TABLE "chat_sessions" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "instagram_account_id" UUID,
    "title" VARCHAR(120) NOT NULL,
    "title_set_by_user" BOOLEAN NOT NULL DEFAULT false,
    "created_by_user_id" UUID,
    "message_count" INTEGER NOT NULL DEFAULT 0,
    "last_message_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "chat_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chat_messages" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "chat_session_id" UUID NOT NULL,
    "sequence" INTEGER NOT NULL,
    "role" "chat_message_role" NOT NULL,
    "content" TEXT NOT NULL,
    "cited_evidence_keys" TEXT[],
    "follow_ups" TEXT[],
    "context_hash" CHAR(64),
    "context_sources" TEXT[],
    "context_token_estimate" INTEGER,
    "strategy_generation_id" UUID,
    "prompt_version" VARCHAR(64),
    "schema_version" VARCHAR(64),
    "model_requested" VARCHAR(64),
    "model_version" VARCHAR(64),
    "finish_reason" VARCHAR(64),
    "input_tokens" INTEGER,
    "output_tokens" INTEGER,
    "total_tokens" INTEGER,
    "provider_latency_ms" INTEGER,
    "failure_class" VARCHAR(64),
    "failure_code" VARCHAR(64),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "chat_messages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "chat_session_recent_idx" ON "chat_sessions"("workspace_id", "last_message_at" DESC, "created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "chat_sessions_workspace_id_id_key" ON "chat_sessions"("workspace_id", "id");

-- CreateIndex
CREATE INDEX "chat_message_conversation_idx" ON "chat_messages"("workspace_id", "chat_session_id", "sequence");

-- CreateIndex
CREATE UNIQUE INDEX "chat_messages_workspace_id_id_key" ON "chat_messages"("workspace_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "chat_message_session_sequence" ON "chat_messages"("chat_session_id", "sequence");

-- AddForeignKey
ALTER TABLE "chat_sessions" ADD CONSTRAINT "chat_sessions_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_sessions" ADD CONSTRAINT "chat_sessions_workspace_id_instagram_account_id_fkey" FOREIGN KEY ("workspace_id", "instagram_account_id") REFERENCES "instagram_accounts"("workspace_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_sessions" ADD CONSTRAINT "chat_sessions_workspace_id_created_by_user_id_fkey" FOREIGN KEY ("workspace_id", "created_by_user_id") REFERENCES "internal_users"("workspace_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_workspace_id_chat_session_id_fkey" FOREIGN KEY ("workspace_id", "chat_session_id") REFERENCES "chat_sessions"("workspace_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_workspace_id_strategy_generation_id_fkey" FOREIGN KEY ("workspace_id", "strategy_generation_id") REFERENCES "strategy_generations"("workspace_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
