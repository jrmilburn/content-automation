-- CreateEnum
CREATE TYPE "integration_type" AS ENUM ('INSTAGRAM');

-- CreateEnum
CREATE TYPE "instagram_account_type" AS ENUM ('BUSINESS', 'CREATOR');

-- CreateEnum
CREATE TYPE "instagram_connection_status" AS ENUM ('ACTIVE', 'REAUTHORISATION_REQUIRED', 'DISCONNECTED');

-- CreateEnum
CREATE TYPE "integration_credential_status" AS ENUM ('ACTIVE', 'REAUTHORISATION_REQUIRED', 'REVOKED');

-- CreateTable
CREATE TABLE "instagram_accounts" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "provider_account_id" VARCHAR(64) NOT NULL,
    "username" VARCHAR(120),
    "account_type" "instagram_account_type" NOT NULL,
    "media_count" INTEGER,
    "follower_count" INTEGER,
    "follower_count_observed_at" TIMESTAMPTZ(3),
    "connection_status" "instagram_connection_status" NOT NULL DEFAULT 'ACTIVE',
    "token_expires_at" TIMESTAMPTZ(3),
    "granted_scopes" TEXT[],
    "last_successful_sync_at" TIMESTAMPTZ(3),
    "api_version" VARCHAR(16) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "instagram_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "integration_credentials" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "integration_type" "integration_type" NOT NULL,
    "account_id" UUID NOT NULL,
    "ciphertext" TEXT NOT NULL,
    "key_version" INTEGER NOT NULL,
    "token_type" VARCHAR(32) NOT NULL,
    "scope_hash" CHAR(64) NOT NULL,
    "status" "integration_credential_status" NOT NULL DEFAULT 'ACTIVE',
    "issued_at" TIMESTAMPTZ(3) NOT NULL,
    "expires_at" TIMESTAMPTZ(3),
    "refreshed_at" TIMESTAMPTZ(3),
    "last_validated_at" TIMESTAMPTZ(3),
    "last_validation_error_class" VARCHAR(64),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "integration_credentials_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "instagram_accounts_workspace_id_connection_status_idx" ON "instagram_accounts"("workspace_id", "connection_status");

-- CreateIndex
CREATE INDEX "instagram_accounts_workspace_id_token_expires_at_idx" ON "instagram_accounts"("workspace_id", "token_expires_at");

-- CreateIndex
CREATE INDEX "instagram_accounts_workspace_id_last_successful_sync_at_idx" ON "instagram_accounts"("workspace_id", "last_successful_sync_at");

-- CreateIndex
CREATE UNIQUE INDEX "instagram_accounts_workspace_id_id_key" ON "instagram_accounts"("workspace_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "instagram_accounts_workspace_id_provider_account_id_key" ON "instagram_accounts"("workspace_id", "provider_account_id");

-- CreateIndex
CREATE INDEX "integration_credentials_workspace_id_status_expires_at_idx" ON "integration_credentials"("workspace_id", "status", "expires_at");

-- CreateIndex
CREATE INDEX "integration_credentials_workspace_id_account_id_status_idx" ON "integration_credentials"("workspace_id", "account_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "integration_credentials_workspace_id_id_key" ON "integration_credentials"("workspace_id", "id");

-- AddForeignKey
ALTER TABLE "instagram_accounts" ADD CONSTRAINT "instagram_accounts_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "integration_credentials" ADD CONSTRAINT "integration_credentials_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "integration_credentials" ADD CONSTRAINT "integration_credentials_workspace_id_account_id_fkey" FOREIGN KEY ("workspace_id", "account_id") REFERENCES "instagram_accounts"("workspace_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Exactly one ACTIVE credential may exist per integration and account, while
-- superseded REVOKED/REAUTHORISATION_REQUIRED rows are retained for audit. A
-- filtered unique index cannot be expressed in the Prisma schema, so it is
-- created here and asserted by the integration tests. Concurrent duplicate
-- callbacks rely on this index to fail one transaction rather than activating
-- two credentials for the same account.
CREATE UNIQUE INDEX "integration_credentials_one_active_per_account"
    ON "integration_credentials" ("integration_type", "account_id")
    WHERE "status" = 'ACTIVE';
