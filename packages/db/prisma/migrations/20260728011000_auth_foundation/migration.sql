-- Permit an explicitly allowlisted email to bind its stable Google subject on first approved sign-in.
ALTER TABLE "internal_users" ALTER COLUMN "oidc_subject" DROP NOT NULL;

-- Incremented on identity status changes so sessions issued before deactivation cannot revive.
ALTER TABLE "internal_users"
ADD COLUMN "session_version" INTEGER NOT NULL DEFAULT 1;

ALTER TABLE "internal_users"
ADD CONSTRAINT "internal_users_session_version_positive_check"
CHECK ("session_version" > 0);
