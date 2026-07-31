import { instagramInsightGroups, instagramApiVersion } from "@studio-parallel/domain";
import { describe, expect, it, vi } from "vitest";

import {
  fetchInstagramInsightGroup,
  type FetchLike,
  type InstagramInsightsError,
} from "./insights-client.js";

const groups = instagramInsightGroups({ apiVersion: instagramApiVersion, mediaKind: "REEL" });
const distribution = groups[0]!;
const providerMediaId = "17841400000000000";
const accessToken = "IGQVJnotarealtokencanary";

function jsonResponse(
  body: unknown,
  init: Readonly<{ headers?: Record<string, string>; status?: number }> = {},
) {
  return new Response(JSON.stringify(body), {
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
    status: init.status ?? 200,
  });
}

/**
 * Types the mock as `FetchLike` rather than inferring it from the
 * implementation. An inferred zero-argument mock gets an empty call tuple, so
 * asserting on the request URL or its init does not compile.
 */
function fetchOnce(response: Response | Promise<Response>) {
  return vi.fn<FetchLike>(async () => response);
}

describe("fetchInstagramInsightGroup request", () => {
  it("requests exactly the group's provider metric names", async () => {
    const fetchImplementation = fetchOnce(jsonResponse({ data: [] }));

    await fetchInstagramInsightGroup({
      accessToken,
      fetchImplementation,
      group: distribution,
      providerMediaId,
    });

    const url = new URL(String(fetchImplementation.mock.calls[0]?.[0]));
    expect(url.pathname).toBe(`/${instagramApiVersion}/${providerMediaId}/insights`);
    expect(url.searchParams.get("metric")).toBe("views,reach");
  });

  it("sends the token as a bearer header and never in the URL", async () => {
    const fetchImplementation = fetchOnce(jsonResponse({ data: [] }));

    await fetchInstagramInsightGroup({
      accessToken,
      fetchImplementation,
      group: distribution,
      providerMediaId,
    });

    const [url, init] = fetchImplementation.mock.calls[0] ?? [];
    // A token in a query string would be captured by any proxy or access log.
    expect(String(url)).not.toContain(accessToken);
    expect((init as RequestInit).headers).toMatchObject({
      Authorization: `Bearer ${accessToken}`,
    });
  });

  it("refuses to follow a redirect off the pinned Graph host", async () => {
    const fetchImplementation = fetchOnce(jsonResponse({ data: [] }));

    await fetchInstagramInsightGroup({
      accessToken,
      fetchImplementation,
      group: distribution,
      providerMediaId,
    });

    expect((fetchImplementation.mock.calls[0]?.[1] as RequestInit).redirect).toBe("error");
  });

  it.each(["", "not-an-id", "12", "17841400000000000x"])(
    "rejects the crafted media id %p before making a request",
    async (crafted) => {
      const fetchImplementation = vi.fn();

      await expect(
        fetchInstagramInsightGroup({
          accessToken,
          fetchImplementation,
          group: distribution,
          providerMediaId: crafted,
        }),
      ).rejects.toMatchObject({ reasonCode: "MEDIA_ID_INVALID" });
      expect(fetchImplementation).not.toHaveBeenCalled();
    },
  );

  it("refuses an empty metric group rather than requesting everything", async () => {
    const fetchImplementation = vi.fn();

    await expect(
      fetchInstagramInsightGroup({
        accessToken,
        fetchImplementation,
        group: { key: "empty", metrics: [] },
        providerMediaId,
      }),
    ).rejects.toMatchObject({ reasonCode: "METRIC_GROUP_EMPTY" });
    expect(fetchImplementation).not.toHaveBeenCalled();
  });
});

describe("fetchInstagramInsightGroup responses", () => {
  it("returns the body and the safe usage summary", async () => {
    const fetchImplementation = fetchOnce(
      jsonResponse(
        { data: [{ name: "views", total_value: { value: 5 } }] },
        { headers: { "x-app-usage": '{"call_count":7,"total_time":2}' } },
      ),
    );

    const result = await fetchInstagramInsightGroup({
      accessToken,
      fetchImplementation,
      group: distribution,
      providerMediaId,
    });

    expect(result.body).toMatchObject({ data: [{ name: "views" }] });
    expect(result.usage).toEqual([{ header: "x-app-usage", maximumPercentage: 7 }]);
  });

  it.each([
    [401, "authorisation"],
    [403, "authorisation"],
    [429, "rate_limit"],
    [500, "transient"],
    [503, "transient"],
  ] as const)("classifies HTTP %i as %s", async (status, responseClass) => {
    const fetchImplementation = fetchOnce(jsonResponse({ error: {} }, { status }));

    await expect(
      fetchInstagramInsightGroup({
        accessToken,
        fetchImplementation,
        group: distribution,
        providerMediaId,
      }),
    ).rejects.toMatchObject({ reasonCode: "INSIGHTS_REJECTED", responseClass });
  });

  it("classifies an unsupported metric name as unsupported, not a bad request", async () => {
    // Meta answers a withdrawn metric with a 400 carrying code 100.
    const fetchImplementation = fetchOnce(
      jsonResponse({ error: { code: 100, message: "unsupported" } }, { status: 400 }),
    );

    await expect(
      fetchInstagramInsightGroup({
        accessToken,
        fetchImplementation,
        group: distribution,
        providerMediaId,
      }),
    ).rejects.toMatchObject({ responseClass: "unsupported" });
  });

  it("classifies an expired token reported as a 400 with code 190 as authorisation", async () => {
    const fetchImplementation = fetchOnce(jsonResponse({ error: { code: 190 } }, { status: 400 }));

    await expect(
      fetchInstagramInsightGroup({
        accessToken,
        fetchImplementation,
        group: distribution,
        providerMediaId,
      }),
    ).rejects.toMatchObject({ responseClass: "authorisation" });
  });

  it("carries the provider's retry hint through a rate limit", async () => {
    const fetchImplementation = fetchOnce(
      jsonResponse({ error: {} }, { headers: { "retry-after": "120" }, status: 429 }),
    );

    await expect(
      fetchInstagramInsightGroup({
        accessToken,
        fetchImplementation,
        group: distribution,
        providerMediaId,
      }),
    ).rejects.toMatchObject({ retryAfterMs: 120_000 });
  });

  it("still reports usage when the response was rejected", async () => {
    let captured: InstagramInsightsError | null = null;
    const fetchImplementation = fetchOnce(
      jsonResponse({ error: {} }, { headers: { "x-app-usage": '{"call_count":98}' }, status: 429 }),
    );

    try {
      await fetchInstagramInsightGroup({
        accessToken,
        fetchImplementation,
        group: distribution,
        providerMediaId,
      });
    } catch (error) {
      captured = error as InstagramInsightsError;
    }

    // Usage is summarised before the ok check precisely so a throttled call
    // still reports what it cost.
    expect(captured?.responseClass).toBe("rate_limit");
  });

  it("treats an unreachable provider as transient", async () => {
    const fetchImplementation = vi.fn(async () => {
      throw new Error("socket hang up");
    });

    await expect(
      fetchInstagramInsightGroup({
        accessToken,
        fetchImplementation,
        group: distribution,
        providerMediaId,
      }),
    ).rejects.toMatchObject({ reasonCode: "INSIGHTS_UNREACHABLE", responseClass: "transient" });
  });

  it("treats an unparseable body as transient rather than as no data", async () => {
    const fetchImplementation = fetchOnce(
      new Response("<html>gateway</html>", { headers: { "content-type": "text/html" } }),
    );

    await expect(
      fetchInstagramInsightGroup({
        accessToken,
        fetchImplementation,
        group: distribution,
        providerMediaId,
      }),
    ).rejects.toMatchObject({ reasonCode: "INSIGHTS_NOT_JSON" });
  });

  it("never puts provider text into the error it raises", async () => {
    const canary = "provider detail redaction canary";
    const fetchImplementation = fetchOnce(
      jsonResponse({ error: { code: 100, message: canary } }, { status: 400 }),
    );

    try {
      await fetchInstagramInsightGroup({
        accessToken,
        fetchImplementation,
        group: distribution,
        providerMediaId,
      });
      expect.unreachable("expected a rejection");
    } catch (error) {
      expect(JSON.stringify({ message: (error as Error).message })).not.toContain(canary);
    }
  });
});
