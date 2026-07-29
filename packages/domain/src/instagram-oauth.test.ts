import { describe, expect, it } from "vitest";

import {
  buildInstagramRedirectUri,
  createInstagramAuthorizationRequest,
  evaluateInstagramCallback,
  evaluateInstagramGrantedScopes,
  instagramRequiredScopes,
  instagramStateLifetimeSeconds,
  isEligibleInstagramAccountType,
  isValidInstagramRedirectUri,
  resolveTokenExpiry,
  type InstagramStateRecord,
} from "./instagram-oauth.js";

const origin = "https://content-automation-web.example";
const now = new Date("2026-07-30T00:00:00.000Z");

function storedState(overrides: Partial<InstagramStateRecord> = {}): InstagramStateRecord {
  return {
    consumed: false,
    expiresAt: new Date(now.getTime() + 60_000),
    state: "stored-state-value",
    ...overrides,
  };
}

describe("instagram redirect uri", () => {
  it("builds the exact allowlisted HTTPS callback", () => {
    expect(buildInstagramRedirectUri(origin)).toBe(`${origin}/api/integrations/instagram/callback`);
  });

  it("refuses non-HTTPS, path-bearing and credential-bearing origins", () => {
    for (const candidate of [
      "http://content-automation-web.example",
      "https://content-automation-web.example/nested",
      "https://user:pass@content-automation-web.example",
    ]) {
      expect(() => buildInstagramRedirectUri(candidate)).toThrow();
    }
  });

  it("accepts only an exact match, not a prefix or near variant", () => {
    expect(
      isValidInstagramRedirectUri(`${origin}/api/integrations/instagram/callback`, origin),
    ).toBe(true);

    for (const candidate of [
      `${origin}/api/integrations/instagram/callback/`,
      `${origin}/api/integrations/instagram/callback?x=1`,
      `${origin}/api/integrations/instagram/callback2`,
      "https://evil.example/api/integrations/instagram/callback",
      "http://localhost:3000/api/integrations/instagram/callback",
    ]) {
      expect(isValidInstagramRedirectUri(candidate, origin)).toBe(false);
    }
  });
});

describe("authorization request", () => {
  it("requests only the two least-privilege scopes and pins the exact redirect", () => {
    const request = createInstagramAuthorizationRequest({
      appId: "1978896389449694",
      now,
      publicOrigin: origin,
    });
    const url = new URL(request.authorizeUrl);

    expect(url.origin + url.pathname).toBe("https://www.instagram.com/oauth/authorize");
    expect(url.searchParams.get("scope")).toBe(instagramRequiredScopes.join(","));
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe("1978896389449694");
    expect(url.searchParams.get("redirect_uri")).toBe(request.redirectUri);
    // No publishing, messaging or comment scope may ever be requested.
    expect(url.searchParams.get("scope")).not.toMatch(/publish|message|comment/u);
  });

  it("carries a high-entropy state and a bounded lifetime", () => {
    const first = createInstagramAuthorizationRequest({ appId: "1", now, publicOrigin: origin });
    const second = createInstagramAuthorizationRequest({ appId: "1", now, publicOrigin: origin });

    expect(first.state).not.toBe(second.state);
    expect(first.state.length).toBeGreaterThanOrEqual(43);
    expect(first.expiresAt.getTime() - now.getTime()).toBe(instagramStateLifetimeSeconds * 1000);
  });

  it("does not send a PKCE challenge, because the provider path does not document it", () => {
    const url = new URL(
      createInstagramAuthorizationRequest({ appId: "1", now, publicOrigin: origin }).authorizeUrl,
    );

    expect(url.searchParams.has("code_challenge")).toBe(false);
    expect(url.searchParams.has("code_challenge_method")).toBe(false);
  });
});

describe("callback evaluation", () => {
  it("allows a matching, unconsumed, unexpired state with a code", () => {
    expect(
      evaluateInstagramCallback({
        code: "authorization-code",
        now,
        receivedState: "stored-state-value",
        storedState: storedState(),
      }),
    ).toEqual({ allowed: true, code: "authorization-code" });
  });

  it.each([
    [
      "missing stored state",
      { storedState: null, receivedState: "stored-state-value" },
      "STATE_MISSING",
    ],
    [
      "missing received state",
      { storedState: storedState(), receivedState: null },
      "STATE_MISSING",
    ],
    [
      "mismatched state",
      { storedState: storedState(), receivedState: "attacker-supplied-state" },
      "STATE_MISMATCH",
    ],
    [
      "replayed state",
      { storedState: storedState({ consumed: true }), receivedState: "stored-state-value" },
      "STATE_ALREADY_USED",
    ],
    [
      "expired state",
      {
        storedState: storedState({ expiresAt: new Date(now.getTime() - 1) }),
        receivedState: "stored-state-value",
      },
      "STATE_EXPIRED",
    ],
  ])("denies %s", (_label, overrides, reason) => {
    expect(evaluateInstagramCallback({ code: "authorization-code", now, ...overrides })).toEqual({
      allowed: false,
      reason,
    });
  });

  it("validates state before trusting any provider-supplied error or code", () => {
    // A forged callback carrying an error must not be attributed to the user.
    expect(
      evaluateInstagramCallback({
        now,
        providerError: "access_denied",
        receivedState: "attacker-supplied-state",
        storedState: storedState(),
      }),
    ).toEqual({ allowed: false, reason: "STATE_MISMATCH" });
  });

  it("separates a cancelled consent from a provider fault", () => {
    expect(
      evaluateInstagramCallback({
        now,
        providerError: "access_denied",
        receivedState: "stored-state-value",
        storedState: storedState(),
      }),
    ).toEqual({ allowed: false, reason: "CONSENT_CANCELLED" });

    expect(
      evaluateInstagramCallback({
        now,
        providerError: "server_error",
        receivedState: "stored-state-value",
        storedState: storedState(),
      }),
    ).toEqual({ allowed: false, reason: "PROVIDER_ERROR" });
  });

  it("denies a valid state with no code", () => {
    expect(
      evaluateInstagramCallback({
        code: null,
        now,
        receivedState: "stored-state-value",
        storedState: storedState(),
      }),
    ).toEqual({ allowed: false, reason: "CODE_MISSING" });
  });
});

describe("account eligibility and granted scopes", () => {
  it("accepts only professional account types", () => {
    expect(isEligibleInstagramAccountType("BUSINESS")).toBe(true);
    expect(isEligibleInstagramAccountType("CREATOR")).toBe(true);

    for (const candidate of ["PERSONAL", "MEDIA_CREATOR", "business", "", "UNKNOWN"]) {
      expect(isEligibleInstagramAccountType(candidate)).toBe(false);
    }
  });

  it("is satisfied only when every required scope is granted", () => {
    expect(evaluateInstagramGrantedScopes([...instagramRequiredScopes])).toEqual({
      extra: [],
      missing: [],
      satisfied: true,
    });
  });

  it("reports a downgraded grant rather than accepting it", () => {
    const result = evaluateInstagramGrantedScopes(["instagram_business_basic"]);

    expect(result.satisfied).toBe(false);
    expect(result.missing).toEqual(["instagram_business_manage_insights"]);
  });

  it("surfaces an over-broad grant without failing it", () => {
    const result = evaluateInstagramGrantedScopes([
      ...instagramRequiredScopes,
      "instagram_business_content_publish",
    ]);

    expect(result.satisfied).toBe(true);
    expect(result.extra).toEqual(["instagram_business_content_publish"]);
  });

  it("ignores whitespace and blank entries", () => {
    expect(
      evaluateInstagramGrantedScopes([
        " instagram_business_basic ",
        "instagram_business_manage_insights",
        "",
      ]).satisfied,
    ).toBe(true);
  });
});

describe("token expiry", () => {
  it("converts a positive duration to an absolute instant", () => {
    expect(resolveTokenExpiry(5_184_000, now)?.toISOString()).toBe("2026-09-28T00:00:00.000Z");
  });

  it("treats a missing, zero, negative or non-finite duration as no expiry", () => {
    for (const candidate of [null, undefined, 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(resolveTokenExpiry(candidate, now)).toBeNull();
    }
  });
});
