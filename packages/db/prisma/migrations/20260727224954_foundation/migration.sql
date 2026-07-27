-- Required for case-insensitive identity uniqueness.
CREATE EXTENSION IF NOT EXISTS "citext";

-- CreateEnum
CREATE TYPE "workspace_status" AS ENUM ('ACTIVE', 'DISABLED');

-- CreateEnum
CREATE TYPE "internal_user_status" AS ENUM ('ACTIVE', 'DISABLED');

-- CreateEnum
CREATE TYPE "audit_actor_type" AS ENUM ('USER', 'SERVICE', 'SYSTEM');

-- CreateEnum
CREATE TYPE "setting_value_type" AS ENUM ('STRING', 'NUMBER', 'BOOLEAN', 'JSON');

-- CreateTable
CREATE TABLE "workspaces" (
    "id" UUID NOT NULL,
    "slug" VARCHAR(63) NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "timezone" VARCHAR(64) NOT NULL DEFAULT 'Australia/Sydney',
    "status" "workspace_status" NOT NULL DEFAULT 'ACTIVE',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "workspaces_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "internal_users" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "oidc_subject" VARCHAR(255) NOT NULL,
    "email" CITEXT NOT NULL,
    "display_name" VARCHAR(160),
    "status" "internal_user_status" NOT NULL DEFAULT 'ACTIVE',
    "last_login_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "internal_users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_events" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "actor_type" "audit_actor_type" NOT NULL,
    "actor_user_id" UUID,
    "actor_service" VARCHAR(100),
    "action" VARCHAR(120) NOT NULL,
    "resource_type" VARCHAR(100) NOT NULL,
    "resource_id" VARCHAR(255),
    "before_hash" CHAR(64),
    "after_hash" CHAR(64),
    "correlation_id" UUID NOT NULL,
    "occurred_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "system_settings" (
    "id" UUID NOT NULL,
    "workspace_id" UUID NOT NULL,
    "key" VARCHAR(120) NOT NULL,
    "value_type" "setting_value_type" NOT NULL,
    "value" JSONB NOT NULL,
    "version" INTEGER NOT NULL,
    "effective_at" TIMESTAMPTZ(3) NOT NULL,
    "changed_by_user_id" UUID,
    "changed_by_service" VARCHAR(100),
    "change_reason" VARCHAR(500) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "system_settings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "workspaces_slug_key" ON "workspaces"("slug");

-- CreateIndex
CREATE INDEX "workspaces_status_idx" ON "workspaces"("status");

-- CreateIndex
CREATE INDEX "internal_users_workspace_id_status_idx" ON "internal_users"("workspace_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "internal_users_workspace_id_id_key" ON "internal_users"("workspace_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "internal_users_workspace_id_oidc_subject_key" ON "internal_users"("workspace_id", "oidc_subject");

-- CreateIndex
CREATE UNIQUE INDEX "internal_users_workspace_id_email_key" ON "internal_users"("workspace_id", "email");

-- CreateIndex
CREATE INDEX "audit_events_workspace_id_occurred_at_idx" ON "audit_events"("workspace_id", "occurred_at" DESC);

-- CreateIndex
CREATE INDEX "audit_events_workspace_id_resource_type_resource_id_idx" ON "audit_events"("workspace_id", "resource_type", "resource_id");

-- CreateIndex
CREATE INDEX "system_settings_workspace_id_key_effective_at_idx" ON "system_settings"("workspace_id", "key", "effective_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "system_settings_workspace_id_key_version_key" ON "system_settings"("workspace_id", "key", "version");

-- AddForeignKey
ALTER TABLE "internal_users" ADD CONSTRAINT "internal_users_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_workspace_id_actor_user_id_fkey" FOREIGN KEY ("workspace_id", "actor_user_id") REFERENCES "internal_users"("workspace_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "system_settings" ADD CONSTRAINT "system_settings_workspace_id_fkey" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "system_settings" ADD CONSTRAINT "system_settings_workspace_id_changed_by_user_id_fkey" FOREIGN KEY ("workspace_id", "changed_by_user_id") REFERENCES "internal_users"("workspace_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Enforce actor provenance without allowing ambiguous or content-bearing actor data.
ALTER TABLE "audit_events"
ADD CONSTRAINT "audit_events_actor_shape_check"
CHECK (
  ("actor_type" = 'USER' AND "actor_user_id" IS NOT NULL AND "actor_service" IS NULL)
  OR ("actor_type" = 'SERVICE' AND "actor_user_id" IS NULL AND "actor_service" IS NOT NULL)
  OR ("actor_type" = 'SYSTEM' AND "actor_user_id" IS NULL AND "actor_service" IS NULL)
);

ALTER TABLE "system_settings"
ADD CONSTRAINT "system_settings_actor_shape_check"
CHECK (num_nonnulls("changed_by_user_id", "changed_by_service") = 1);

ALTER TABLE "system_settings"
ADD CONSTRAINT "system_settings_version_positive_check"
CHECK ("version" > 0);
