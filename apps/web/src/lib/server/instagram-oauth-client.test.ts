import { describe, expect, it, vi } from "vitest";

import {
  exchangeForLongLivedInstagramToken,
  exchangeInstagramAuthorizationCode,
  fetchInstagramIdentity,
  InstagramProviderError,
} from "./instagram-oauth-client";

const appSecret = "0123456789abcdef0123456789abcdef";
const shortLivedToken = "IGAAshortlivedtokencanaryvalue";
const longLivedToken = "IGAAlonglivedtokencanaryvalue";
const redirectUri = "https://content-automation-web.example/api/integrations/instagram/callback";

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json" },
    status,
  });
}

describe("authorisation code exchange", () => {
  it("posts the code and secret in a form body, never in the URL", async () => {
    const fetchImplementation = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      expect(url).toBe("https://api.instagram.com/oauth/access_token");
      expect(url).not.toContain("authorization-code");
      expect(url).not.toContain(appSecret);
      expect(init?.method).toBe("POST");

      const body = String(init?.body);
      expect(body).toContain("grant_type=authorization_code");
      expect(body).toContain(`redirect_uri=${encodeURIComponent(redirectUri)}`);
      return jsonResponse({
        access_token: shortLivedToken,
        permissions: "instagram_business_basic,instagram_business_manage_insights",
        user_id: 178_414_000,
      });
    });

    const grant = await exchangeInstagramAuthorizationCode({
      appId: "1978896389449694",
      appSecret,
      code: "authorization-code",
      fetchImplementation,
      redirectUri,
    });

    expect(grant.accessToken).toBe(shortLivedToken);
    expect(grant.permissions).toEqual([
      "instagram_business_basic",
      "instagram_business_manage_insights",
    ]);
    expect(grant.responseFields).toEqual(["access_token", "permissions", "user_id"]);
    // The short-lived response carries no expiry.
    expect(grant.expiresAt).toBeNull();
  });

  it("strips the #_=_ fragment browsers retain from the redirect", async () => {
    const fetchImplementation = vi.fn(async (_input: string | URL, init?: RequestInit) => {
      expect(String(init?.body)).toContain("code=authorization-code&");
      expect(String(init?.body)).not.toContain("%23");
      return jsonResponse({ access_token: shortLivedToken });
    });

    await exchangeInstagramAuthorizationCode({
      appId: "1",
      appSecret,
      code: "authorization-code#_=_",
      fetchImplementation,
      redirectUri,
    });

    expect(fetchImplementation).toHaveBeenCalledOnce();
  });

  it("refuses an empty code without contacting the provider", async () => {
    const fetchImplementation = vi.fn();

    await expect(
      exchangeInstagramAuthorizationCode({
        appId: "1",
        appSecret,
        code: "#_=_",
        fetchImplementation,
        redirectUri,
      }),
    ).rejects.toThrowError(expect.objectContaining({ reasonCode: "CODE_MISSING" }));
    expect(fetchImplementation).not.toHaveBeenCalled();
  });

  it.each([
    [400, "provider"],
    [401, "authorisation"],
    [403, "authorisation"],
    [429, "rate_limit"],
    [503, "provider"],
  ])("classifies HTTP %s as %s without echoing the provider body", async (status, errorClass) => {
    const providerCanary = "provider error detail canary";
    const fetchImplementation = vi.fn(async () =>
      jsonResponse({ error_message: providerCanary, error_type: "OAuthException" }, status),
    );

    try {
      await exchangeInstagramAuthorizationCode({
        appId: "1",
        appSecret,
        code: "authorization-code",
        fetchImplementation,
        redirectUri,
      });
      expect.unreachable("expected an InstagramProviderError");
    } catch (error) {
      expect(error).toBeInstanceOf(InstagramProviderError);
      expect((error as InstagramProviderError).errorClass).toBe(errorClass);
      const message = (error as Error).message;
      expect(message).not.toContain(providerCanary);
      expect(message).not.toContain(appSecret);
    }
  });

  it("reports an unreachable provider as a transport failure", async () => {
    await expect(
      exchangeInstagramAuthorizationCode({
        appId: "1",
        appSecret,
        code: "authorization-code",
        fetchImplementation: vi.fn(async () => {
          throw new Error(`socket failure exposing ${appSecret}`);
        }),
        redirectUri,
      }),
    ).rejects.toThrowError(
      expect.objectContaining({ errorClass: "transport", reasonCode: "CODE_EXCHANGE_UNREACHABLE" }),
    );
  });

  it("rejects a success response with no access token", async () => {
    await expect(
      exchangeInstagramAuthorizationCode({
        appId: "1",
        appSecret,
        code: "authorization-code",
        fetchImplementation: vi.fn(async () => jsonResponse({ user_id: 1 })),
        redirectUri,
      }),
    ).rejects.toThrowError(expect.objectContaining({ reasonCode: "CODE_EXCHANGE_TOKEN_ABSENT" }));
  });
});

describe("long-lived token upgrade", () => {
  it("records the sixty-day expiry as an absolute instant", async () => {
    const now = new Date("2026-07-30T00:00:00.000Z");
    const grant = await exchangeForLongLivedInstagramToken({
      appSecret,
      fetchImplementation: vi.fn(async () =>
        jsonResponse({ access_token: longLivedToken, expires_in: 5_184_000, token_type: "bearer" }),
      ),
      now,
      shortLivedToken,
    });

    expect(grant.accessToken).toBe(longLivedToken);
    expect(grant.expiresAt?.toISOString()).toBe("2026-09-28T00:00:00.000Z");
    expect(grant.responseFields).toEqual(["access_token", "expires_in", "token_type"]);
  });

  it("classifies a rejected upgrade without leaking the short-lived token", async () => {
    try {
      await exchangeForLongLivedInstagramToken({
        appSecret,
        fetchImplementation: vi.fn(async () => jsonResponse({ error: { code: 190 } }, 401)),
        shortLivedToken,
      });
      expect.unreachable("expected an InstagramProviderError");
    } catch (error) {
      expect((error as InstagramProviderError).reasonCode).toBe("TOKEN_UPGRADE_REJECTED");
      expect((error as Error).message).not.toContain(shortLivedToken);
    }
  });
});

describe("identity lookup", () => {
  it("sends the token as a bearer header, never as a query parameter", async () => {
    const fetchImplementation = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = new URL(input.toString());
      expect(url.searchParams.has("access_token")).toBe(false);
      expect(url.toString()).not.toContain(longLivedToken);
      expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${longLivedToken}`);
      expect(url.pathname).toBe("/v25.0/me");

      return jsonResponse({
        account_type: "BUSINESS",
        id: "17841400000000001",
        media_count: 48,
        username: "studioparallel",
      });
    });

    await expect(
      fetchInstagramIdentity({ accessToken: longLivedToken, fetchImplementation }),
    ).resolves.toEqual({
      accountType: "BUSINESS",
      mediaCount: 48,
      providerAccountId: "17841400000000001",
      username: "studioparallel",
    });
  });

  it("rejects an identity response missing the id or account type", async () => {
    for (const body of [{ account_type: "BUSINESS" }, { id: "17841400000000001" }]) {
      await expect(
        fetchInstagramIdentity({
          accessToken: longLivedToken,
          fetchImplementation: vi.fn(async () => jsonResponse(body)),
        }),
      ).rejects.toThrowError(expect.objectContaining({ reasonCode: "IDENTITY_INCOMPLETE" }));
    }
  });

  it("rejects a non-JSON response", async () => {
    await expect(
      fetchInstagramIdentity({
        accessToken: longLivedToken,
        fetchImplementation: vi.fn(async () => new Response("<html>error</html>", { status: 200 })),
      }),
    ).rejects.toThrowError(expect.objectContaining({ reasonCode: "RESPONSE_NOT_JSON" }));
  });
});
