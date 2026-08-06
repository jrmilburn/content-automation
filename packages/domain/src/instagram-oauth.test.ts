import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  buildInstagramRedirectUri,
  createInstagramAuthorizationRequest,
  evaluateInstagramCallback,
  evaluateInstagramGrantedScopes,
  instagramReconnectSatisfied,
  instagramRequiredScopes,
  instagramStateLifetimeSeconds,
  isValidInstagramRedirectUri,
  loggableInstagramAccountType,
  openInstagramState,
  resolveInstagramAccountType,
  resolveTokenExpiry,
  sealInstagramState,
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
  it("requests only the least-privilege read scopes and pins the exact redirect", () => {
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
    // No publishing or messaging scope may ever be requested.
    //
    // `instagram_business_manage_comments` is the one exception to the "no
    // manage scope" rule and it is deliberate: it is the only scope that grants
    // reading comment bodies, which the strategy and the assistant argue from.
    // Its write half is never called, and the absence of any comment-write
    // client is what enforces that — so this asserts the boundary that is left.
    expect(url.searchParams.get("scope")).not.toMatch(/publish|message/u);
    expect(instagramRequiredScopes).not.toContain("instagram_business_content_publish");
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
  it("maps the provider's name for a creator account onto the one we store", () => {
    // The value that refused every creator account: Instagram says
    // MEDIA_CREATOR, the column says CREATOR, and comparing the two matched
    // only businesses.
    expect(resolveInstagramAccountType("MEDIA_CREATOR")).toBe("CREATOR");
    expect(resolveInstagramAccountType("BUSINESS")).toBe("BUSINESS");
    expect(resolveInstagramAccountType("CREATOR")).toBe("CREATOR");
  });

  it("resolves nothing for an account that is not professional", () => {
    // "business" stays refused deliberately: the provider's enum is upper
    // case, so another casing is a contract change to surface, not a spelling
    // to absorb.
    for (const candidate of ["PERSONAL", "business", "media_creator", "", "UNKNOWN"]) {
      expect(resolveInstagramAccountType(candidate)).toBeNull();
    }
  });

  it("only lets the provider's own enum shape through to a log", () => {
    expect(loggableInstagramAccountType("MEDIA_CREATOR")).toBe("MEDIA_CREATOR");

    for (const candidate of [
      "not an enum",
      '{"error":"..."}',
      "A".repeat(33),
      "",
      "creator\nInjected: line",
    ]) {
      expect(loggableInstagramAccountType(candidate)).toBe("UNRECOGNISED");
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
    expect(result.missing).toEqual([
      "instagram_business_manage_insights",
      "instagram_business_manage_comments",
    ]);
  });

  it("reports a token minted before comments were requested as downgraded", () => {
    // The exact shape of every existing connection at the moment this scope was
    // added. It has to read as unsatisfied, because that is what puts the
    // reconnect prompt on the connection screen; treating it as good enough
    // would leave comment imports failing with an authorisation error nobody
    // was told to fix.
    const result = evaluateInstagramGrantedScopes([
      "instagram_business_basic",
      "instagram_business_manage_insights",
    ]);

    expect(result.satisfied).toBe(false);
    expect(result.missing).toEqual(["instagram_business_manage_comments"]);
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
        " instagram_business_manage_comments",
        "",
      ]).satisfied,
    ).toBe(true);
  });
});

describe("sealed connection state", () => {
  const secret = "test-only-auth-secret-not-for-deployment-000000";
  const internalUserId = "0192f2a0-0000-7000-8000-000000000001";
  const expiresAt = new Date("2026-07-30T00:10:00.000Z");

  function seal(overrides: Partial<Parameters<typeof sealInstagramState>[0]> = {}) {
    return sealInstagramState({
      expiresAt,
      internalUserId,
      secret,
      state: "pending-state-value",
      ...overrides,
    });
  }

  it("round-trips the state, initiating user and expiry", () => {
    expect(openInstagramState(seal(), secret)).toEqual({
      expectedProviderAccountId: null,
      expiresAt,
      internalUserId,
      state: "pending-state-value",
    });
  });

  it("round-trips the account a reconnect was started from", () => {
    expect(
      openInstagramState(seal({ expectedProviderAccountId: "17841400000000001" }), secret),
    ).toEqual({
      expectedProviderAccountId: "17841400000000001",
      expiresAt,
      internalUserId,
      state: "pending-state-value",
    });
  });

  it("refuses a binding that is present but not a usable account id", () => {
    for (const expectedProviderAccountId of [42, "", true, {}]) {
      const encoded = Buffer.from(
        JSON.stringify({
          expectedProviderAccountId,
          expiresAt: expiresAt.toISOString(),
          internalUserId,
          state: "pending-state-value",
        }),
        "utf8",
      ).toString("base64url");
      const signature = createHmac("sha256", secret).update(encoded, "utf8").digest("base64url");

      // Reading a damaged binding as "unbound" would let a tampered cookie
      // downgrade a reconnect into an unrestricted connection.
      expect(openInstagramState(`${encoded}.${signature}`, secret)).toBeNull();
    }
  });

  it("rejects a tampered payload or signature", () => {
    const sealed = seal();
    const [encoded, signature] = sealed.split(".");

    const forgedPayload = Buffer.from(
      JSON.stringify({
        expiresAt: expiresAt.toISOString(),
        internalUserId: "0192f2a0-0000-7000-8000-0000000000ff",
        state: "pending-state-value",
      }),
      "utf8",
    ).toString("base64url");

    // Swapping the payload while keeping a valid-looking signature must fail.
    expect(openInstagramState(`${forgedPayload}.${signature}`, secret)).toBeNull();
    expect(openInstagramState(`${encoded}.${signature}tampered`, secret)).toBeNull();
    expect(openInstagramState(sealed, "a-different-secret-entirely-000000000000000")).toBeNull();
  });

  it("rejects malformed, empty and unsigned values", () => {
    for (const candidate of [null, undefined, "", "no-separator", ".", "only."]) {
      expect(openInstagramState(candidate, secret)).toBeNull();
    }
  });

  it("rejects a payload whose fields are missing or the wrong type", () => {
    for (const payload of [
      { expiresAt: expiresAt.toISOString(), internalUserId },
      { expiresAt: "not-a-date", internalUserId, state: "s" },
      { expiresAt: expiresAt.toISOString(), internalUserId: 42, state: "s" },
    ]) {
      const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
      const signature = createHmac("sha256", secret).update(encoded, "utf8").digest("base64url");
      expect(openInstagramState(`${encoded}.${signature}`, secret)).toBeNull();
    }
  });

  it("does not expose the state value in the sealed representation", () => {
    // The payload is encoded rather than encrypted, so this documents that the
    // cookie must stay httpOnly; it is integrity-protected, not confidential.
    expect(seal()).not.toContain("pending-state-value");
  });
});

describe("reconnect binding", () => {
  it("accepts any account when the attempt is not bound to one", () => {
    // This is what makes connecting an additional account possible at all.
    expect(instagramReconnectSatisfied(null, "17841400000000009")).toBe(true);
  });

  it("accepts only the bound account when the attempt is a reconnect", () => {
    expect(instagramReconnectSatisfied("17841400000000001", "17841400000000001")).toBe(true);
    expect(instagramReconnectSatisfied("17841400000000001", "17841400000000002")).toBe(false);
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
