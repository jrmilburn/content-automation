import { describe, expect, it } from "vitest";

import {
  classifyInstagramTokenResponse,
  evaluateInstagramTokenHealth,
  instagramConnectionBlocked,
  instagramRefreshTokenUrl,
  instagramTokenRefreshGrantType,
  instagramTokenRefreshMinimumAgeSeconds,
} from "./instagram-token.js";

const now = new Date("2026-07-31T00:00:00.000Z");
const hours = (count: number) => count * 3_600_000;
const days = (count: number) => count * 86_400_000;

function health(
  overrides: Partial<{
    credentialStatus: string;
    expiresAt: Date | null;
    issuedAt: Date;
  }> = {},
) {
  return evaluateInstagramTokenHealth({
    credentialStatus: overrides.credentialStatus ?? "ACTIVE",
    expiresAt:
      overrides.expiresAt === undefined ? new Date(now.getTime() + days(60)) : overrides.expiresAt,
    issuedAt: overrides.issuedAt ?? new Date(now.getTime() - days(2)),
    now,
  });
}

describe("refresh endpoint contract", () => {
  it("pins Meta's documented unversioned refresh endpoint and grant type", () => {
    expect(instagramRefreshTokenUrl).toBe("https://graph.instagram.com/refresh_access_token");
    expect(instagramTokenRefreshGrantType).toBe("ig_refresh_token");
  });

  it("encodes the documented twenty-four hour minimum token age", () => {
    expect(instagramTokenRefreshMinimumAgeSeconds).toBe(86_400);
  });
});

describe("evaluateInstagramTokenHealth", () => {
  it("reports a fresh long-lived token as healthy and not due", () => {
    const result = health();

    expect(result.state).toBe("HEALTHY");
    expect(result.refreshDue).toBe(false);
    expect(result.expiresInSeconds).toBe(60 * 86_400);
  });

  it("becomes due with weeks of runway rather than days", () => {
    expect(health({ expiresAt: new Date(now.getTime() + days(14)) }).state).toBe("REFRESH_DUE");
    expect(health({ expiresAt: new Date(now.getTime() + days(16)) }).state).toBe("HEALTHY");
  });

  it("escalates to expiring as the deadline approaches", () => {
    const result = health({ expiresAt: new Date(now.getTime() + days(3)) });

    expect(result.state).toBe("EXPIRING");
    expect(result.refreshDue).toBe(true);
    expect(result.refreshEligible).toBe(true);
  });

  it("treats an unrecorded expiry as unknown rather than permanent", () => {
    const result = health({ expiresAt: null });

    // This is the whole point: a token is never assumed to last forever.
    expect(result.state).toBe("EXPIRY_UNKNOWN");
    expect(result.refreshDue).toBe(true);
    expect(result.expiresInSeconds).toBeNull();
  });

  it("refuses to refresh a token younger than twenty-four hours", () => {
    const result = health({
      expiresAt: new Date(now.getTime() + days(10)),
      issuedAt: new Date(now.getTime() - hours(3)),
    });

    expect(result.refreshDue).toBe(true);
    // Meta would reject it, so an attempt would be spent learning nothing.
    expect(result.refreshEligible).toBe(false);
  });

  it("becomes eligible exactly at the documented boundary", () => {
    const issuedAt = new Date(now.getTime() - instagramTokenRefreshMinimumAgeSeconds * 1000);

    expect(
      health({ expiresAt: new Date(now.getTime() + days(10)), issuedAt }).refreshEligible,
    ).toBe(true);
  });

  it("reports an expired token as unrefreshable", () => {
    const result = health({ expiresAt: new Date(now.getTime() - days(1)) });

    expect(result.state).toBe("EXPIRED");
    expect(result.refreshEligible).toBe(false);
  });

  it.each([
    ["REVOKED", "REVOKED"],
    ["REAUTHORISATION_REQUIRED", "REAUTHORISATION_REQUIRED"],
  ])("reports a %s credential as %s regardless of expiry", (credentialStatus, state) => {
    const result = health({ credentialStatus, expiresAt: new Date(now.getTime() + days(60)) });

    expect(result.state).toBe(state);
    expect(result.refreshEligible).toBe(false);
  });

  it("never reports a negative token age for a clock skew", () => {
    expect(health({ issuedAt: new Date(now.getTime() + days(1)) }).tokenAgeSeconds).toBe(0);
  });
});

describe("instagramConnectionBlocked", () => {
  it.each(["EXPIRED", "REAUTHORISATION_REQUIRED", "REVOKED"] as const)("blocks %s", (state) => {
    expect(instagramConnectionBlocked(state)).toBe(true);
  });

  it.each(["HEALTHY", "REFRESH_DUE", "EXPIRING", "EXPIRY_UNKNOWN"] as const)(
    "does not block %s",
    (state) => {
      expect(instagramConnectionBlocked(state)).toBe(false);
    },
  );
});

describe("classifyInstagramTokenResponse", () => {
  it.each([
    [400, { error: { code: 190 } }, "REAUTHORISATION_REQUIRED"],
    [400, { error: { code: 102 } }, "REAUTHORISATION_REQUIRED"],
    [401, {}, "REAUTHORISATION_REQUIRED"],
    [403, {}, "REAUTHORISATION_REQUIRED"],
    [400, { error: { code: 10 } }, "PERMISSION_REVOKED"],
    [400, { error: { code: 200 } }, "PERMISSION_REVOKED"],
    [400, { error: { code: 299 } }, "PERMISSION_REVOKED"],
    [429, {}, "TRANSIENT"],
    [500, {}, "TRANSIENT"],
    [503, {}, "TRANSIENT"],
    [400, { error: { code: 2207026 } }, "UNSUPPORTED"],
    [404, {}, "UNSUPPORTED"],
  ])("classifies HTTP %s as %s", (status, body, expected) => {
    expect(classifyInstagramTokenResponse({ body, status })).toBe(expected);
  });

  it("distinguishes a withdrawn permission from an expired token", () => {
    const permission = classifyInstagramTokenResponse({
      body: { error: { code: 10 } },
      status: 403,
    });
    const expired = classifyInstagramTokenResponse({ body: { error: { code: 190 } }, status: 401 });

    // Both need a reconnect, but an operator must be able to tell them apart.
    expect(permission).toBe("PERMISSION_REVOKED");
    expect(expired).toBe("REAUTHORISATION_REQUIRED");
  });
});
