import { describe, expect, it } from "vitest";

import { ConfigurationError, loadRuntimeConfig } from "./index.js";

describe("loadRuntimeConfig", () => {
  it("uses safe local fake-provider defaults", () => {
    expect(loadRuntimeConfig({})).toMatchObject({
      APP_ENV: "local",
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
        PROVIDER_MODE: "live",
        PUBLIC_ORIGIN: "https://content.studioparallel.example",
      }),
    ).toMatchObject({
      APP_ENV: "production",
      PROVIDER_MODE: "live",
    });
  });
});
