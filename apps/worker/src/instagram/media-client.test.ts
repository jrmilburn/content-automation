import { describe, expect, it, vi } from "vitest";

import {
  fetchInstagramMediaItem,
  fetchInstagramMediaPage,
  InstagramMediaError,
} from "./media-client.js";

const accessToken = "IGAAcanaryTokenValueThatMustNeverLeak";
const providerAccountId = "17841400000000001";

function jsonResponse(
  body: unknown,
  init: Readonly<{ headers?: Record<string, string>; status?: number }> = {},
): Response {
  return new Response(JSON.stringify(body), {
    headers: { "Content-Type": "application/json", ...init.headers },
    status: init.status ?? 200,
  });
}

function mediaItem(id: string) {
  return {
    id,
    media_product_type: "REELS",
    media_type: "VIDEO",
    permalink: `https://www.instagram.com/reel/${id}/`,
    timestamp: "2026-07-01T04:12:33+0000",
  };
}

describe("fetchInstagramMediaPage", () => {
  it("sends the token as a bearer header and never in the URL", async () => {
    const fetchImplementation = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = new URL(input);
      expect(url.toString()).not.toContain(accessToken);
      expect(url.searchParams.get("access_token")).toBeNull();
      expect(new Headers(init?.headers).get("Authorization")).toBe(`Bearer ${accessToken}`);
      return jsonResponse({ data: [] });
    });

    await fetchInstagramMediaPage({ accessToken, fetchImplementation, providerAccountId });

    expect(fetchImplementation).toHaveBeenCalledOnce();
  });

  it("requests the pinned version, account edge and documented fields", async () => {
    const fetchImplementation = vi.fn(async (input: string | URL) => {
      const url = new URL(input);
      expect(url.host).toBe("graph.instagram.com");
      expect(url.pathname).toBe(`/v25.0/${providerAccountId}/media`);
      expect(url.searchParams.get("fields")).toContain("media_product_type");
      expect(url.searchParams.get("limit")).toBe("50");
      return jsonResponse({ data: [] });
    });

    await fetchInstagramMediaPage({ accessToken, fetchImplementation, providerAccountId });
  });

  it("refuses to follow a redirect and bounds the request", async () => {
    const fetchImplementation = vi.fn(async (_input: string | URL, init?: RequestInit) => {
      expect(init?.redirect).toBe("error");
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      return jsonResponse({ data: [] });
    });

    await fetchInstagramMediaPage({ accessToken, fetchImplementation, providerAccountId });
  });

  it("pages forward using the returned cursor", async () => {
    const requested: (string | null)[] = [];
    const fetchImplementation = vi.fn(async (input: string | URL) => {
      const url = new URL(input);
      requested.push(url.searchParams.get("after"));

      return url.searchParams.get("after") === null
        ? jsonResponse({
            data: [mediaItem("17912345678901234")],
            paging: { cursors: { after: "QVFIUmZAt" }, next: "https://graph.instagram.com/next" },
          })
        : jsonResponse({ data: [mediaItem("17912345678901235")] });
    });

    const first = await fetchInstagramMediaPage({
      accessToken,
      fetchImplementation,
      providerAccountId,
    });
    expect(first.page.hasNextPage).toBe(true);
    expect(first.page.after).toBe("QVFIUmZAt");

    const second = await fetchInstagramMediaPage({
      accessToken,
      after: first.page.after,
      fetchImplementation,
      providerAccountId,
    });
    expect(second.page.hasNextPage).toBe(false);
    expect(requested).toEqual([null, "QVFIUmZAt"]);
  });

  it("captures safe usage headers", async () => {
    const fetchImplementation = vi.fn(async () =>
      jsonResponse(
        { data: [] },
        { headers: { "x-app-usage": JSON.stringify({ call_count: 9, total_time: 44 }) } },
      ),
    );

    const result = await fetchInstagramMediaPage({
      accessToken,
      fetchImplementation,
      providerAccountId,
    });

    expect(result.usage).toEqual([{ header: "x-app-usage", maximumPercentage: 44 }]);
  });

  it.each([
    ["an account id that is not a provider identifier", "../me", "ACCOUNT_ID_INVALID"],
    ["an empty account id", "", "ACCOUNT_ID_INVALID"],
  ])("rejects %s before making a request", async (_label, badAccountId, reasonCode) => {
    const fetchImplementation = vi.fn(async () => jsonResponse({ data: [] }));

    await expect(
      fetchInstagramMediaPage({
        accessToken,
        fetchImplementation,
        providerAccountId: badAccountId,
      }),
    ).rejects.toThrowError(expect.objectContaining({ reasonCode }));
    expect(fetchImplementation).not.toHaveBeenCalled();
  });

  it("rejects a cursor that is not an opaque provider token", async () => {
    const fetchImplementation = vi.fn(async () => jsonResponse({ data: [] }));

    await expect(
      fetchInstagramMediaPage({
        accessToken,
        after: "https://attacker.invalid/steal",
        fetchImplementation,
        providerAccountId,
      }),
    ).rejects.toThrowError(expect.objectContaining({ reasonCode: "CURSOR_INVALID" }));
    expect(fetchImplementation).not.toHaveBeenCalled();
  });

  it.each([
    [429, {}, "rate_limit"],
    [401, {}, "authorisation"],
    [403, {}, "authorisation"],
    [500, {}, "transient"],
    [400, { error: { code: 190 } }, "authorisation"],
    [400, { error: { code: 100 } }, "unsupported"],
    [400, { error: { code: 2207026 } }, "invalid_request"],
  ])("classifies HTTP %s as %s", async (status, body, responseClass) => {
    const fetchImplementation = vi.fn(async () => jsonResponse(body, { status }));

    await expect(
      fetchInstagramMediaPage({ accessToken, fetchImplementation, providerAccountId }),
    ).rejects.toThrowError(
      expect.objectContaining({ reasonCode: "MEDIA_PAGE_REJECTED", responseClass }),
    );
  });

  it("carries the provider retry hint on a rate limit", async () => {
    const fetchImplementation = vi.fn(async () =>
      jsonResponse({}, { headers: { "retry-after": "45" }, status: 429 }),
    );

    await expect(
      fetchInstagramMediaPage({ accessToken, fetchImplementation, providerAccountId }),
    ).rejects.toThrowError(expect.objectContaining({ retryAfterMs: 45_000 }));
  });

  it("treats an unreachable provider as transient", async () => {
    const fetchImplementation = vi.fn(async () => {
      throw new TypeError("network down");
    });

    await expect(
      fetchInstagramMediaPage({ accessToken, fetchImplementation, providerAccountId }),
    ).rejects.toThrowError(
      expect.objectContaining({
        reasonCode: "MEDIA_PAGE_UNREACHABLE",
        responseClass: "transient",
      }),
    );
  });

  it("rejects a body that is not JSON", async () => {
    const fetchImplementation = vi.fn(async () => new Response("<html>maintenance</html>"));

    await expect(
      fetchInstagramMediaPage({ accessToken, fetchImplementation, providerAccountId }),
    ).rejects.toThrowError(expect.objectContaining({ reasonCode: "MEDIA_PAGE_NOT_JSON" }));
  });

  it("refuses a page that promises a successor it cannot resume from", async () => {
    const fetchImplementation = vi.fn(async () =>
      jsonResponse({ data: [], paging: { next: "https://graph.instagram.com/next" } }),
    );

    await expect(
      fetchInstagramMediaPage({ accessToken, fetchImplementation, providerAccountId }),
    ).rejects.toThrowError(expect.objectContaining({ reasonCode: "MEDIA_PAGE_CURSOR_ABSENT" }));
  });

  it("never places the token or a provider body in the error", async () => {
    const fetchImplementation = vi.fn(async () =>
      jsonResponse(
        { error: { code: 190, message: `Invalid token ${accessToken}` } },
        { status: 400 },
      ),
    );

    try {
      await fetchInstagramMediaPage({ accessToken, fetchImplementation, providerAccountId });
      expect.unreachable("expected an InstagramMediaError");
    } catch (error) {
      expect(error).toBeInstanceOf(InstagramMediaError);
      const serialised = `${(error as Error).name}${(error as Error).message}${JSON.stringify(error)}`;
      expect(serialised).not.toContain(accessToken);
      expect(serialised).not.toContain("Invalid token");
    }
  });
});

describe("fetchInstagramMediaItem", () => {
  const providerMediaId = "17900000000000001";

  it("reads the media node for a fresh signed URL, with the token in a header", async () => {
    const fetchImplementation = vi.fn(async (input: string | URL, init?: RequestInit) => {
      const url = new URL(input);
      expect(url.host).toBe("graph.instagram.com");
      expect(url.pathname).toBe(`/v25.0/${providerMediaId}`);
      expect(url.toString()).not.toContain(accessToken);
      expect(new Headers(init?.headers).get("Authorization")).toBe(`Bearer ${accessToken}`);
      // A redirect off the pinned host would carry the bearer token with it.
      expect(init?.redirect).toBe("error");

      return jsonResponse({
        id: providerMediaId,
        media_product_type: "REELS",
        media_type: "VIDEO",
        media_url: "https://scontent.cdninstagram.com/v/reel.mp4?oe=SIGNATURE",
      });
    });

    const item = await fetchInstagramMediaItem({
      accessToken,
      fetchImplementation,
      providerMediaId,
    });

    expect(item.mediaUrl).toBe("https://scontent.cdninstagram.com/v/reel.mp4?oe=SIGNATURE");
    expect(item.mediaType).toBe("VIDEO");
  });

  it("validates the media id before it reaches the path", async () => {
    const fetchImplementation = vi.fn();

    for (const crafted of ["../me", "17900000000000001/insights", "", "abc"]) {
      await expect(
        fetchInstagramMediaItem({ accessToken, fetchImplementation, providerMediaId: crafted }),
      ).rejects.toBeInstanceOf(InstagramMediaError);
    }

    expect(fetchImplementation).not.toHaveBeenCalled();
  });

  it("reports an absent media_url rather than inventing one", async () => {
    const fetchImplementation = vi.fn(async () =>
      jsonResponse({ id: providerMediaId, media_type: "IMAGE" }),
    );

    const item = await fetchInstagramMediaItem({
      accessToken,
      fetchImplementation,
      providerMediaId,
    });

    expect(item.mediaUrl).toBeNull();
  });

  it("classifies a rejected read without echoing provider text", async () => {
    const fetchImplementation = vi.fn(async () =>
      jsonResponse({ error: { code: 190, message: "Invalid token canary" } }, { status: 400 }),
    );

    try {
      await fetchInstagramMediaItem({ accessToken, fetchImplementation, providerMediaId });
      expect.unreachable("the read should have been refused");
    } catch (error) {
      expect(error).toBeInstanceOf(InstagramMediaError);
      // Code 190 on a 400 is an authorisation problem, so it asks for a
      // reconnect rather than being retried into a lockout.
      expect((error as InstagramMediaError).responseClass).toBe("authorisation");
      const serialised = JSON.stringify(error, Object.getOwnPropertyNames(error));
      expect(serialised).not.toContain(accessToken);
      expect(serialised).not.toContain("Invalid token canary");
    }
  });
});
