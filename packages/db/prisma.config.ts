import "dotenv/config";

import { defineConfig } from "prisma/config";

/**
 * Which database a Prisma command talks to.
 *
 * Supabase issues two URLs and they are not interchangeable. `DATABASE_URL` is
 * the transaction pooler, which multiplexes connections and holds no session
 * state; `DIRECT_URL` is the session pooler. Prisma's schema engine needs
 * session-level features for its advisory locks and DDL, so a migration through
 * the transaction pooler fails with a bare `Schema engine error:` and no cause —
 * which reads like a transient blip rather than a configuration mistake. Three
 * migrations sat unapplied against production because of it.
 *
 * `DIRECT_URL` is therefore preferred here and `DATABASE_URL` is the fallback.
 * That is the opposite of what the application wants at runtime, which is the
 * pooler precisely because it holds no session state.
 */

export const localFallbackUrl =
  "postgresql://studio_parallel:studio_parallel@127.0.0.1:5432/studio_parallel";

/** Environments allowed to fall back to a local database. */
const localEnvironments = new Set(["local", "test"]);

export type MigrationDatasource = Readonly<{ source: string; url: string }>;

export function resolveMigrationDatasource(
  environment: Readonly<Record<string, string | undefined>>,
): MigrationDatasource {
  const direct = environment["DIRECT_URL"]?.trim();
  const pooled = environment["DATABASE_URL"]?.trim();

  if (direct) return Object.freeze({ source: "DIRECT_URL", url: direct });
  if (pooled) return Object.freeze({ source: "DATABASE_URL", url: pooled });

  const appEnvironment = environment["APP_ENV"]?.trim();

  // A deployed environment reaching this point has lost its configuration.
  // Falling back to localhost would run a production migration somewhere else
  // and report success, which is worse than failing.
  if (appEnvironment && !localEnvironments.has(appEnvironment)) {
    throw new Error(
      `DIRECT_URL or DATABASE_URL is required for Prisma commands when APP_ENV=${appEnvironment}`,
    );
  }

  return Object.freeze({ source: "local default", url: localFallbackUrl });
}

/** The host a command will act on, with the credentials removed. */
export function describeDatasource(datasource: MigrationDatasource): string {
  try {
    const parsed = new URL(datasource.url);
    return `${parsed.hostname}:${parsed.port || "5432"} (${datasource.source})`;
  } catch {
    return `unparseable URL (${datasource.source})`;
  }
}

const datasource = resolveMigrationDatasource(process.env);

// Printed on every Prisma command so an operator sees which database is about
// to change before it changes. The URL itself carries a password and is never
// printed.
console.log(`Prisma target: ${describeDatasource(datasource)}`);

export default defineConfig({
  datasource: {
    url: datasource.url,
  },
  migrations: {
    path: "prisma/migrations",
    seed: "tsx prisma/seed.ts",
  },
  schema: "prisma/schema.prisma",
});
