# Database foundation

This package owns the Prisma/PostgreSQL client, committed migrations and workspace-scoped repository entry points.

## Safety boundaries

- Runtime callers create a validated `WorkspaceContext` and receive repositories already scoped to that workspace.
- There is no exported generic repository that accepts an optional workspace.
- IDs are application-generated UUIDv7 values; provider identifiers remain strings in later entities.
- PostgreSQL stores UTC `timestamptz(3)` values.
- Audit records contain identifiers and hashes, never secret or content bodies.
- Production and staging Prisma commands require an explicit `DATABASE_URL`; the fallback URL is local-only.

## Commands

```powershell
npm run db:validate
npm run db:generate
npm run db:migrate:deploy
npm run db:seed
npm run db:drift:check
npm run test:db:integration
```

`test:db:integration` creates a dedicated PostgreSQL 17 Docker Compose project on port 55432, applies the migrations to an empty database, explicitly seeds it, checks drift, runs integration tests serially and removes the volume.

Use `test:db:integration:existing` only when `DATABASE_URL` already points to a disposable migrated and seeded test database.

## Migration policy

1. Change `prisma/schema.prisma` on the issue branch.
2. Generate a named migration with `prisma migrate dev` against a disposable development database.
3. Review SQL for destructive operations, locks, defaults, indexes and custom constraints.
4. Commit the schema and migration together.
5. Run validation, empty-database deploy, seed, drift and integration tests.

Migrations are forward-only in production. Breaking changes use expand/migrate/contract across compatible releases. Do not edit an applied migration; create a corrective migration. Full product tables, queue tables and production data backfills belong to their vertical issues.
