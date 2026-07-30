import { describe, expect, it } from "vitest";

import {
  ConfigurationError,
  loadAuthConfig,
  loadCredentialEncryptionConfig,
  loadDatabaseConfig,
  loadInstagramOAuthConfig,
  loadMetaWebhookConfig,
  loadRuntimeConfig,
} from "./index.js";

describe("loadRuntimeConfig", () => {
  it("uses safe local fake-provider defaults", () => {
    expect(loadRuntimeConfig({})).toMatchObject({
      APP_ENV: "local",
      APP_RELEASE: "development",
      PROVIDER_MODE: "fake",
      PUBLIC_ORIGIN: "http://localhost:3000",
      QUEUE_DISPATCH_BATCH_SIZE: 20,
      QUEUE_RECONCILE_INTERVAL_SECONDS: 5,
      WORKER_SHUTDOWN_GRACE_SECONDS: 30,
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

describe("loadMetaWebhookConfig", () => {
  it("loads only a bounded URL-safe verification secret", () => {
    const verifyToken = "test-only-webhook-verifier-not-a-live-credential";

    expect(
      loadMetaWebhookConfig({
        META_WEBHOOK_VERIFY_TOKEN: verifyToken,
        META_ACCESS_TOKEN: "must-not-enter-webhook-config",
      }),
    ).toEqual({ META_WEBHOOK_VERIFY_TOKEN: verifyToken });
  });

  it("fails closed without echoing missing or malformed secret values", () => {
    const malformedToken = "private webhook token redaction canary";

    expect(() => loadMetaWebhookConfig({})).toThrow(ConfigurationError);

    try {
      loadMetaWebhookConfig({ META_WEBHOOK_VERIFY_TOKEN: malformedToken });
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigurationError);
      expect((error as ConfigurationError).fields).toEqual(["META_WEBHOOK_VERIFY_TOKEN"]);
      expect((error as Error).message).not.toContain(malformedToken);
    }
  });
});

describe("loadInstagramOAuthConfig", () => {
  const appId = "1978896389449694";
  const appSecret = "0123456789abcdef0123456789abcdef";

  it("loads only the Instagram app credentials", () => {
    expect(
      loadInstagramOAuthConfig({
        INSTAGRAM_APP_ID: appId,
        INSTAGRAM_APP_SECRET: appSecret,
        META_WEBHOOK_VERIFY_TOKEN: "must-not-enter-instagram-oauth-config",
      }),
    ).toEqual({ INSTAGRAM_APP_ID: appId, INSTAGRAM_APP_SECRET: appSecret });
  });

  it("rejects a non-numeric app id, because the Facebook app id fails at the token endpoint", () => {
    try {
      loadInstagramOAuthConfig({
        INSTAGRAM_APP_ID: "fb-app-1234",
        INSTAGRAM_APP_SECRET: appSecret,
      });
      expect.unreachable("expected a ConfigurationError");
    } catch (error) {
      expect((error as ConfigurationError).fields).toEqual(["INSTAGRAM_APP_ID"]);
    }
  });

  it("fails closed without echoing the secret value", () => {
    const malformedSecret = "instagram app secret redaction canary";

    expect(() => loadInstagramOAuthConfig({})).toThrow(ConfigurationError);

    try {
      loadInstagramOAuthConfig({ INSTAGRAM_APP_ID: appId, INSTAGRAM_APP_SECRET: malformedSecret });
      expect.unreachable("expected a ConfigurationError");
    } catch (error) {
      expect((error as ConfigurationError).fields).toEqual(["INSTAGRAM_APP_SECRET"]);
      expect((error as Error).message).not.toContain(malformedSecret);
    }
  });
});

describe("loadCredentialEncryptionConfig", () => {
  const key = Buffer.alloc(32, 7).toString("base64");

  it("loads a 32-byte master key and defaults the key version to one", () => {
    expect(
      loadCredentialEncryptionConfig({
        CREDENTIAL_ENCRYPTION_KEY: key,
        DATABASE_URL: "postgresql://must-not-enter-encryption-config/db",
      }),
    ).toEqual({ CREDENTIAL_ENCRYPTION_KEY: key, CREDENTIAL_ENCRYPTION_KEY_VERSION: 1 });
  });

  it("accepts an explicit key version so rotation can be recorded", () => {
    expect(
      loadCredentialEncryptionConfig({
        CREDENTIAL_ENCRYPTION_KEY: key,
        CREDENTIAL_ENCRYPTION_KEY_VERSION: "4",
      }).CREDENTIAL_ENCRYPTION_KEY_VERSION,
    ).toBe(4);
  });

  it("rejects a key that does not decode to exactly 32 bytes", () => {
    for (const candidate of [
      Buffer.alloc(16, 1).toString("base64"),
      Buffer.alloc(64, 1).toString("base64"),
    ]) {
      try {
        loadCredentialEncryptionConfig({ CREDENTIAL_ENCRYPTION_KEY: candidate });
        expect.unreachable("expected a ConfigurationError");
      } catch (error) {
        expect((error as ConfigurationError).fields).toContain("CREDENTIAL_ENCRYPTION_KEY");
      }
    }
  });

  it("fails closed without echoing the key material", () => {
    const malformedKey = "credential encryption key redaction canary";

    expect(() => loadCredentialEncryptionConfig({})).toThrow(ConfigurationError);

    try {
      loadCredentialEncryptionConfig({ CREDENTIAL_ENCRYPTION_KEY: malformedKey });
      expect.unreachable("expected a ConfigurationError");
    } catch (error) {
      expect((error as Error).message).not.toContain(malformedKey);
    }
  });
});
