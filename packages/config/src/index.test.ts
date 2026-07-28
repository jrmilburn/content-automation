import { describe, expect, it } from "vitest";

import {
  ConfigurationError,
  loadAuthConfig,
  loadDatabaseConfig,
  loadRuntimeConfig,
} from "./index.js";

describe("loadRuntimeConfig", () => {
  it("uses safe local fake-provider defaults", () => {
    expect(loadRuntimeConfig({})).toMatchObject({
      APP_ENV: "local",
      APP_RELEASE: "development",
      PROVIDER_MODE: "fake",
      PUBLIC_ORIGIN: "http://localhost:3000",
    });
  });

  it("rejects live providers in preview without echoing supplied values", () => {
    const privateValue = "do-not-echo-this-value";

    expect(() =>
      loadRuntimeConfig({
        APP_ENV: "preview",
        PROVIDER_MODE: "live",
        PUBLIC_ORIGIN: privateValue,
      }),
    ).toThrow(ConfigurationError);

    try {
      loadRuntimeConfig({
        APP_ENV: "preview",
        PROVIDER_MODE: "live",
        PUBLIC_ORIGIN: privateValue,
      });
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigurationError);
      expect((error as Error).message).not.toContain(privateValue);
      expect((error as ConfigurationError).fields).toEqual(
        expect.arrayContaining(["PROVIDER_MODE", "PUBLIC_ORIGIN"]),
      );
    }
  });

  it("requires an HTTPS non-loopback origin for production", () => {
    expect(() =>
      loadRuntimeConfig({
        APP_ENV: "production",
        PROVIDER_MODE: "live",
        PUBLIC_ORIGIN: "http://localhost:3000",
      }),
    ).toThrow(/PUBLIC_ORIGIN must use HTTPS/);
  });

  it("does not expose provider credential-shaped inputs in preview configuration", () => {
    const config = loadRuntimeConfig({
      APP_ENV: "preview",
      META_ACCESS_TOKEN: "must-not-enter-runtime-config",
      PROVIDER_MODE: "fake",
    });

    expect(config).not.toHaveProperty("META_ACCESS_TOKEN");
    expect(JSON.stringify(config)).not.toContain("must-not-enter-runtime-config");
  });

  it("accepts valid production-safe base configuration", () => {
    expect(
      loadRuntimeConfig({
        APP_ENV: "production",
        APP_RELEASE: "git-a1b2c3d",
        PROVIDER_MODE: "live",
        PUBLIC_ORIGIN: "https://content.studioparallel.example",
      }),
    ).toMatchObject({
      APP_ENV: "production",
      APP_RELEASE: "git-a1b2c3d",
      PROVIDER_MODE: "live",
    });
  });

  it("rejects release identifiers that could inject structured content", () => {
    expect(() =>
      loadRuntimeConfig({
        APP_RELEASE: 'release"},"token":"canary',
      }),
    ).toThrow(/APP_RELEASE must be a safe release identifier/);
  });
});

describe("loadDatabaseConfig", () => {
  it("requires a PostgreSQL URL without echoing malformed values", () => {
    const privateValue = "private-database-value";

    expect(() => loadDatabaseConfig({ DATABASE_URL: privateValue })).toThrow(ConfigurationError);

    try {
      loadDatabaseConfig({ DATABASE_URL: privateValue });
    } catch (error) {
      expect((error as Error).message).toContain("DATABASE_URL");
      expect((error as Error).message).not.toContain(privateValue);
    }
  });

  it("rejects non-PostgreSQL protocols", () => {
    expect(() => loadDatabaseConfig({ DATABASE_URL: "https://database.example" })).toThrow(
      /DATABASE_URL must use the postgres or postgresql protocol/,
    );
  });
});

describe("loadAuthConfig", () => {
  it("uses fake local OIDC values with a bounded rotating session policy", () => {
    expect(loadAuthConfig({})).toMatchObject({
      APP_ENV: "local",
      AUTH_GOOGLE_ID: "local-google-client.invalid",
      AUTH_SESSION_MAX_AGE_SECONDS: 28_800,
      GOOGLE_WORKSPACE_DOMAIN: "example.invalid",
    });
  });

  it("rejects deployment placeholders without echoing supplied secrets", () => {
    const privateValue = "private-auth-secret-redaction-canary-000000";

    expect(() =>
      loadAuthConfig({
        APP_ENV: "production",
        AUTH_GOOGLE_ID: "production-client",
        AUTH_GOOGLE_SECRET: privateValue,
        AUTH_SECRET: privateValue,
        GOOGLE_WORKSPACE_DOMAIN: "studio.example",
        PUBLIC_ORIGIN: "https://content.studio.example",
      }),
    ).not.toThrow();

    try {
      loadAuthConfig({ APP_ENV: "production" });
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigurationError);
      expect((error as Error).message).not.toContain(privateValue);
      expect((error as ConfigurationError).fields).toEqual(
        expect.arrayContaining(["AUTH_GOOGLE_ID", "AUTH_GOOGLE_SECRET", "AUTH_SECRET"]),
      );
    }
  });

  it("requires a deployment-safe origin with no path or credentials", () => {
    const deployment = {
      APP_ENV: "production",
      AUTH_GOOGLE_ID: "production-client",
      AUTH_GOOGLE_SECRET: "production-client-secret",
      AUTH_SECRET: "production-auth-secret-that-is-long-enough",
      GOOGLE_WORKSPACE_DOMAIN: "studio.example",
    } as const;

    expect(() =>
      loadAuthConfig({ ...deployment, PUBLIC_ORIGIN: "http://content.studio.example" }),
    ).toThrow(/PUBLIC_ORIGIN must use HTTPS/);
    expect(() =>
      loadAuthConfig({ ...deployment, PUBLIC_ORIGIN: "https://content.studio.example/auth" }),
    ).toThrow(/PUBLIC_ORIGIN must contain only/);
  });
});
