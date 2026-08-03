import { describe, expect, it } from "vitest";

import {
  describeDatasource,
  localFallbackUrl,
  resolveMigrationDatasource,
} from "./prisma.config.js";

/**
 * Which database a migration reaches.
 *
 * These exist because both ways of getting this wrong were silent. Running
 * through the transaction pooler produced a bare `Schema engine error:`, and a
 * missing environment produced a successful migration against localhost.
 */

const supabaseSession = "postgresql://user:pw@aws-0.pooler.supabase.com:5432/postgres";
const supabaseTransaction = "postgresql://user:pw@aws-0.pooler.supabase.com:6543/postgres";

describe("resolveMigrationDatasource", () => {
  it("prefers the session pooler, which is the only one the schema engine can use", () => {
    expect(
      resolveMigrationDatasource({
        DATABASE_URL: supabaseTransaction,
        DIRECT_URL: supabaseSession,
      }),
    ).toEqual({ source: "DIRECT_URL", url: supabaseSession });
  });

  it("falls back to DATABASE_URL when no direct URL is configured", () => {
    expect(resolveMigrationDatasource({ DATABASE_URL: supabaseTransaction })).toEqual({
      source: "DATABASE_URL",
      url: supabaseTransaction,
    });
  });

  it("keeps the local default working for a developer with no environment file", () => {
    expect(resolveMigrationDatasource({})).toEqual({
      source: "local default",
      url: localFallbackUrl,
    });
    expect(resolveMigrationDatasource({ APP_ENV: "local" }).url).toBe(localFallbackUrl);
    expect(resolveMigrationDatasource({ APP_ENV: "test" }).url).toBe(localFallbackUrl);
  });

  it.each(["preview", "staging", "production"])(
    "refuses to reach localhost when APP_ENV is %s",
    (appEnvironment) => {
      // A production migration that quietly runs somewhere else and reports
      // success is worse than one that fails.
      expect(() => resolveMigrationDatasource({ APP_ENV: appEnvironment })).toThrow(
        new RegExp(`DIRECT_URL or DATABASE_URL is required .* APP_ENV=${appEnvironment}`),
      );
    },
  );

  it("ignores a blank value rather than connecting to an empty URL", () => {
    expect(
      resolveMigrationDatasource({ DATABASE_URL: supabaseTransaction, DIRECT_URL: "  " }),
    ).toEqual({ source: "DATABASE_URL", url: supabaseTransaction });
  });
});

describe("describeDatasource", () => {
  it("names the host and port without the credentials", () => {
    const described = describeDatasource({ source: "DIRECT_URL", url: supabaseSession });

    expect(described).toBe("aws-0.pooler.supabase.com:5432 (DIRECT_URL)");
    expect(described).not.toContain("pw");
    expect(described).not.toContain("user");
  });

  it("distinguishes the two poolers by port, which is the only visible difference", () => {
    expect(describeDatasource({ source: "DATABASE_URL", url: supabaseTransaction })).toContain(
      ":6543",
    );
  });

  it("says so rather than throwing when the URL cannot be parsed", () => {
    expect(describeDatasource({ source: "DATABASE_URL", url: "not-a-url" })).toBe(
      "unparseable URL (DATABASE_URL)",
    );
  });
});

describe("environment file precedence", () => {
  /**
   * The load order in `prisma.config.ts` is only correct because dotenv keeps
   * the first value it sees, where node's `--env-file` keeps the last. If
   * dotenv ever changed that, `.env` would start winning over `.env.worker`
   * and a migration would quietly target the wrong database again.
   */
  it("keeps the first file's value and never overrides an exported variable", async () => {
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dotenv = (await import("dotenv")).default;

    const directory = mkdtempSync(join(tmpdir(), "prisma-config-"));
    const first = join(directory, "first.env");
    const second = join(directory, "second.env");

    writeFileSync(first, "PRISMA_CONFIG_ORDER=from_first\nPRISMA_CONFIG_EXPORTED=from_file\n");
    writeFileSync(second, "PRISMA_CONFIG_ORDER=from_second\n");

    process.env["PRISMA_CONFIG_EXPORTED"] = "from_shell";
    delete process.env["PRISMA_CONFIG_ORDER"];

    try {
      dotenv.config({ path: [first, second], quiet: true });

      expect(process.env["PRISMA_CONFIG_ORDER"]).toBe("from_first");
      expect(process.env["PRISMA_CONFIG_EXPORTED"]).toBe("from_shell");
    } finally {
      delete process.env["PRISMA_CONFIG_ORDER"];
      delete process.env["PRISMA_CONFIG_EXPORTED"];
    }
  });

  it("tolerates an absent file rather than throwing", async () => {
    const dotenv = (await import("dotenv")).default;
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");

    expect(() =>
      dotenv.config({ path: join(tmpdir(), "prisma-config-absent.env"), quiet: true }),
    ).not.toThrow();
  });
});
