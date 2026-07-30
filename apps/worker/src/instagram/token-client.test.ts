import { describe, expect, it, vi } from "vitest";

import {
  InstagramTokenError,
  refreshInstagramToken,
  validateInstagramToken,
} from "./token-client.js";

const accessToken = "IGAAcanaryTokenValueThatMustNeverLeak";
const now = new Date("2026-07-31T00:00:00.000Z");

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json" },
    status,
  });
}

describe("refreshInstagramToken", () => {
  it("calls Meta's documented unversioned refresh endpoint", async () => {
    const fetchImplementation = vi.fn(async (input: string | URL) => {
      const url = new URL(input);
      expect(url.origin).toBe("https://graph.instagram.com");
      expect(url.pathname).toBe("/refresh_access_token");
      expect(url.searchParams.get("grant_type")).toBe("ig_refresh_token");
      expect(url.searchParams.get("access_token")).toBe(accessToken);
      return jsonResponse({ access_token: "IGAArefreshed", expires_in: 5_184_000 });
    });

    const result = await refreshInstagramToken({ accessToken, fetchImplementation, now });

    expect(result.accessToken).toBe("IGAArefreshed");
    expect(result.tokenType).toBe("bearer");
  });

  it("uses the provider's returned expiry rather than assuming sixty days", async () => {
    const fetchImplementation = vi.fn(async () =>
      jsonResponse({ access_token: "IGAArefreshed", expires_in: 3_600 }),
    );

    const result = await refreshInstagramToken({ accessToken, fetchImplementation, now });

    expect(result.expiresAt?.toISOString()).toBe("2026-07-31T01:00:00.000Z");
  });

  it("records no expiry when the provider omits one", async () => {
    const fetchImplementation = vi.fn(async () => jsonResponse({ access_token: "IGAArefreshed" }));

    const result = await refreshInstagramToken({ accessToken, fetchImplementation, now });

    expect(result.expiresAt).toBeNull();
  });

  it("refuses to follow a redirect and bounds the request", async () => {
    const fetchImplementation = vi.fn(async (_input: string | URL, init?: RequestInit) => {
      expect(init?.redirect).toBe("error");
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      return jsonResponse({ access_token: "IGAArefreshed" });
    });

    await refreshInstagramToken({ accessToken, fetchImplementation, now });
  });

  it.each([
    [400, { error: { code: 190 } }, "REAUTHORISATION_REQUIRED"],
    [400, { error: { code: 10 } }, "PERMISSION_REVOKED"],
    [429, {}, "TRANSIENT"],
    [500, {}, "TRANSIENT"],
    [400, { error: { code: 2207026 } }, "UNSUPPORTED"],
  ])("classifies HTTP %s as %s", async (status, body, failure) => {
    const fetchImplementation = vi.fn(async () => jsonResponse(body, status));

    await expect(
      refreshInstagramToken({ accessToken, fetchImplementation, now }),
    ).rejects.toThrowError(expect.objectContaining({ failure, reasonCode: "REFRESH_REJECTED" }));
  });

  it("treats an unreachable provider as transient", async () => {
    const fetchImplementation = vi.fn(async () => {
      throw new TypeError("network down");
    });

    await expect(
      refreshInstagramToken({ accessToken, fetchImplementation, now }),
    ).rejects.toThrowError(
      expect.objectContaining({ failure: "TRANSIENT", reasonCode: "REFRESH_UNREACHABLE" }),
    );
  });

  it("does not treat a missing token in a 200 response as revocation", async () => {
    const fetchImplementation = vi.fn(async () => jsonResponse({ token_type: "bearer" }));

    await expect(
      refreshInstagramToken({ accessToken, fetchImplementation, now }),
    ).rejects.toThrowError(
      expect.objectContaining({ failure: "UNSUPPORTED", reasonCode: "REFRESH_TOKEN_ABSENT" }),
    );
  });

  it("rejects an empty token without calling the provider", async () => {
    const fetchImplementation = vi.fn(async () => jsonResponse({}));

    await expect(
      refreshInstagramToken({ accessToken: "", fetchImplementation, now }),
    ).rejects.toThrowError(expect.objectContaining({ reasonCode: "TOKEN_ABSENT" }));
    expect(fetchImplementation).not.toHaveBeenCalled();
  });

  it("never places the token or provider text in the error", async () => {
    const fetchImplementation = vi.fn(async () =>
      jsonResponse({ error: { code: 190, message: `Invalid token ${accessToken}` } }, 400),
    );

    try {
      await refreshInstagramToken({ accessToken, fetchImplementation, now });
      expect.unreachable("expected an InstagramTokenError");
    } catch (error) {
      expect(error).toBeInstanceOf(InstagramTokenError);
      const serialised = `${(error as Error).message}${JSON.stringify(error)}${(error as Error).stack ?? ""}`;
      expect(serialised).not.toContain(accessToken);
      expect(serialised).not.toContain("Invalid token");
    }
  });
});

describe("validateInstagramToken", () => {
  it("sends the token as a bearer header, never in the URL", async () => {
    const fetchImplementation = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = new URL(input);
      expect(url.toString()).not.toContain(accessToken);
      expect(url.pathname).toBe("/v25.0/me");
      expect(new Headers(init?.headers).get("Authorization")).toBe(`Bearer ${accessToken}`);
      return jsonResponse({ id: "17841400000000001" });
    });

    await validateInstagramToken({ accessToken, fetchImplementation });

    expect(fetchImplementation).toHaveBeenCalledOnce();
  });

  it.each([
    [401, {}, "REAUTHORISATION_REQUIRED"],
    [400, { error: { code: 10 } }, "PERMISSION_REVOKED"],
    [503, {}, "TRANSIENT"],
  ])("classifies HTTP %s as %s", async (status, body, failure) => {
    const fetchImplementation = vi.fn(async () => jsonResponse(body, status));

    await expect(validateInstagramToken({ accessToken, fetchImplementation })).rejects.toThrowError(
      expect.objectContaining({ failure, reasonCode: "VALIDATE_REJECTED" }),
    );
  });

  it("treats an unreachable provider as transient", async () => {
    const fetchImplementation = vi.fn(async () => {
      throw new TypeError("network down");
    });

    await expect(validateInstagramToken({ accessToken, fetchImplementation })).rejects.toThrowError(
      expect.objectContaining({ failure: "TRANSIENT", reasonCode: "VALIDATE_UNREACHABLE" }),
    );
  });
});
