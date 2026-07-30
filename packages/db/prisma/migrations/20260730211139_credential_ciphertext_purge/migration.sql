-- A credential row is retained after it is superseded, revoked or marked
-- reauthorisation-required so the audit trail keeps its metadata, but it must
-- not keep a decryptable copy of the token. Only an ACTIVE row holds material.
--
-- This invariant is enforced in the database rather than only in the repository
-- because it is what limits what a database or backup disclosure can expose:
-- application code that forgets to purge fails loudly instead of quietly
-- accumulating usable tokens.
--
-- Prisma cannot express a check constraint, so it lives in SQL only and is
-- asserted by the integration tests.

-- Existing superseded rows predate the invariant and are purged first.
UPDATE "integration_credentials" SET "ciphertext" = '' WHERE "status" <> 'ACTIVE';

ALTER TABLE "integration_credentials" ADD CONSTRAINT "integration_credentials_material_only_when_active" CHECK (
    ("status" = 'ACTIVE' AND length("ciphertext") > 0)
    OR ("status" <> 'ACTIVE' AND length("ciphertext") = 0)
);
