import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  assertSanitizedProof,
  loadMetaContractConfiguration,
  MetaContractConfigurationError,
  MetaContractRequestError,
  runMetaContractProof,
} from "./meta-contract.js";

const selectedMediaIds = ["17841400000000001", "17841400000000002", "17841400000000003"] as const;
const accessToken = "synthetic-meta-contract-access-token-value";

function configurationEnvironment(overrides: Readonly<Record<string, string | undefined>> = {}) {
  return {
    META_CONTRACT_ACCESS_LEVEL: "standard",
    META_CONTRACT_ACCESS_TOKEN: accessToken,
    META_CONTRACT_ACCOUNT_OWNERSHIP: "owned",
    META_CONTRACT_GRANTED_SCOPES: "instagram_business_basic,instagram_business_manage_insights",
    META_CONTRACT_REDIRECT_URI:
      "https://development.example.invalid/api/integrations/instagram/callback",
    META_CONTRACT_REEL_IDS: selectedMediaIds.join(","),
    META_CONTRACT_TOKEN_EXPIRES_IN_SECONDS: "5184000",
    META_CONTRACT_TOKEN_RESPONSE_FIELDS: "access_token,user_id,token_type,expires_in",
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    headers: {
      "content-type": "application/json",
      "instagram-api-version": "v25.0",
      "x-app-usage": JSON.stringify({ call_volume: 7, cpu_time: 2 }),
    },
    status,
  });
}

function createMetaFetch() {
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    expect(url.origin).toBe("https://graph.instagram.com");
    expect(url.searchParams.has("access_token")).toBe(false);
    expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${accessToken}`);

    if (url.pathname === "/v25.0/me") {
      return jsonResponse({
        account_type: "BUSINESS",
        id: "17841499999999999",
        media_count: 14,
      });
    }

    if (url.pathname.endsWith("/media")) {
      if (!url.searchParams.has("after")) {
        return jsonResponse({
          data: selectedMediaIds.slice(0, 2).map((id, index) => ({
            id,
            media_product_type: "REELS",
            media_type: "VIDEO",
            timestamp: index === 0 ? "2026-07-01T00:00:00+0000" : "2026-06-15T00:00:00+0000",
          })),
          paging: {
            cursors: { after: "synthetic-cursor" },
            next: "https://graph.instagram.com/redacted-next-page",
          },
        });
      }
      return jsonResponse({
        data: [
          {
            id: selectedMediaIds[2],
            media_product_type: "REELS",
            media_type: "VIDEO",
            timestamp: "2026-06-01T00:00:00+0000",
          },
        ],
      });
    }

    if (url.pathname.endsWith("/insights")) {
      const metric = url.searchParams.get("metric");
      if (metric === "studio_parallel_contract_probe") {
        return jsonResponse({ error: { code: 100, type: "OAuthException" } }, 400);
      }
      if (url.pathname.includes(selectedMediaIds[2]) && metric?.includes("likes")) {
        return jsonResponse({ data: [] });
      }
      return jsonResponse({
        data: [
          {
            name: metric?.split(",")[0],
            period: "lifetime",
            values: [{ value: 12 }],
          },
        ],
      });
    }

    return jsonResponse({ error: { code: 100 } }, 404);
  });
}

describe("Meta contract proof", () => {
  it("records a passing, sanitised proof without retaining credentials, IDs or content", async () => {
    const configuration = loadMetaContractConfiguration(configurationEnvironment());
    const fetchImplementation = createMetaFetch();
    const proof = await runMetaContractProof(configuration, {
      fetchImplementation,
      now: () => new Date("2026-07-28T00:00:00.000Z"),
    });

    expect(proof.status).toBe("passed");
    expect(proof.authorization).toMatchObject({
      accountOwnership: "owned",
      accountType: "BUSINESS",
      grantedScopes: ["instagram_business_basic", "instagram_business_manage_insights"],
      redirectUriHttps: true,
      tokenExpiresInObserved: true,
    });
    expect(proof.media).toEqual({
      pagesVisited: 2,
      paginationObserved: true,
      recentNewerThanOlder: true,
      selectedReelCount: 3,
    });
    expect(proof.insights).toHaveLength(3);
    expect(proof.insights[2]?.unavailableMetricCount).toBeGreaterThan(0);
    expect(proof.negativeCases.liveUnsupportedMetricErrorObserved).toBe(true);
    expect(proof.responseMetadata.usage).toEqual([{ header: "x-app-usage", maximumPercentage: 7 }]);

    const serialized = JSON.stringify(proof);
    expect(serialized).not.toContain(accessToken);
    expect(serialized).not.toContain("178414");
    expect(serialized).not.toContain("synthetic-cursor");
    expect(serialized).not.toContain("2026-07-01T00:00:00+0000");
    expect(serialized).not.toContain("redacted-next-page");
    expect(fetchImplementation).toHaveBeenCalledTimes(13);
  });

  it("requires the exact least-privilege scopes, three distinct Reels and HTTPS redirect", () => {
    expect(() =>
      loadMetaContractConfiguration(
        configurationEnvironment({
          META_CONTRACT_GRANTED_SCOPES:
            "instagram_business_basic,instagram_business_manage_insights,instagram_business_content_publish",
          META_CONTRACT_REDIRECT_URI: "http://localhost:3000/callback",
          META_CONTRACT_REEL_IDS: `${selectedMediaIds[0]},${selectedMediaIds[0]}`,
        }),
      ),
    ).toThrowError(MetaContractConfigurationError);

    try {
      loadMetaContractConfiguration(
        configurationEnvironment({
          META_CONTRACT_GRANTED_SCOPES: "instagram_business_basic",
          META_CONTRACT_REDIRECT_URI: "not-a-url",
          META_CONTRACT_REEL_IDS: "one,two,three",
        }),
      );
    } catch (error) {
      expect(error).toBeInstanceOf(MetaContractConfigurationError);
      expect((error as MetaContractConfigurationError).fields).toEqual([
        "META_CONTRACT_REDIRECT_URI",
        "META_CONTRACT_REEL_IDS",
        "META_CONTRACT_GRANTED_SCOPES",
      ]);
      expect(error).not.toHaveProperty("accessToken");
    }
  });

  it("rejects unsafe proof keys and credential-shaped values", () => {
    expect(() =>
      assertSanitizedProof({
        kind: "sanitized-meta-contract-proof",
        account: { username: "private-account" },
      }),
    ).toThrow("forbidden key username");

    expect(() =>
      assertSanitizedProof({
        kind: "sanitized-meta-contract-proof",
        note: `EAA${"A".repeat(64)}`,
      }),
    ).toThrow("access-token-shaped");
  });

  it("replaces transport failures with a safe diagnostic", async () => {
    const configuration = loadMetaContractConfiguration(configurationEnvironment());

    try {
      await runMetaContractProof(configuration, {
        fetchImplementation: async () => {
          throw new Error(`provider failure containing ${accessToken}`);
        },
      });
      expect.unreachable("the provider request should fail");
    } catch (error) {
      expect(error).toBeInstanceOf(MetaContractRequestError);
      expect(error).toMatchObject({ requestName: "provider_transport", status: 0 });
      expect((error as Error).message).not.toContain(accessToken);
    }
  });

  it("does not probe insight endpoints for IDs absent from the owned-media edge", async () => {
    const configuration = loadMetaContractConfiguration(configurationEnvironment());
    const fetchImplementation = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      if (url.pathname === "/v25.0/me") {
        return jsonResponse({ account_type: "CREATOR", id: "17841499999999999" });
      }
      if (url.pathname.endsWith("/media")) return jsonResponse({ data: [] });
      throw new Error("An unverified media ID reached an insight endpoint.");
    });

    const proof = await runMetaContractProof(configuration, { fetchImplementation });

    expect(proof.status).toBe("failed");
    expect(proof.media.selectedReelCount).toBe(0);
    expect(fetchImplementation).toHaveBeenCalledTimes(2);
  });

  it("keeps the committed proof and rate-limit fixtures sanitised and deterministic", () => {
    const proof = JSON.parse(
      readFileSync(resolve("tests/fixtures/meta/instagram-v25/sanitized-proof.json"), "utf8"),
    ) as unknown;
    const rateLimit = JSON.parse(
      readFileSync(resolve("tests/fixtures/meta/instagram-v25/rate-limit.json"), "utf8"),
    ) as Record<string, unknown>;

    expect(() => assertSanitizedProof(proof)).not.toThrow();
    expect(rateLimit).toEqual({
      errorClass: "rate_limit",
      httpStatus: 429,
      retryable: true,
      safeUsage: { header: "x-app-usage", maximumPercentage: 100 },
    });
    expect(JSON.stringify(rateLimit)).not.toMatch(
      /EAA|caption|username|access_token|provider[_-]?id/iu,
    );
  });
});
