import { describe, expect, it } from "vitest";

import {
  classifyInstagramMedia,
  classifyInstagramResponse,
  hashInstagramMediaPayload,
  instagramMediaFields,
  normaliseInstagramMediaItem,
  parseInstagramRetryAfterMs,
  parseInstagramTimestamp,
  readInstagramMediaPage,
  summariseInstagramUsage,
} from "./instagram-media.js";

const reelItem = {
  caption: "Behind the scenes of the shoot",
  id: "17912345678901234",
  media_product_type: "REELS",
  media_type: "VIDEO",
  media_url: "https://scontent.cdninstagram.com/v/reel.mp4?oe=SIGNATURE_ONE",
  permalink: "https://www.instagram.com/reel/AbCdEf/",
  thumbnail_url: "https://scontent.cdninstagram.com/v/thumb.jpg?oe=SIGNATURE_ONE",
  timestamp: "2026-07-01T04:12:33+0000",
  username: "studioparallel",
} as const;

function headerLookup(headers: Readonly<Record<string, string>>) {
  return (header: string) => headers[header] ?? null;
}

describe("instagram media field contract", () => {
  it("requests only documented fields and includes the Reel discriminator", () => {
    expect(instagramMediaFields).toContain("media_product_type");
    expect(instagramMediaFields).toContain("timestamp");
    // Publishing, insight and comment fields are a different permission surface.
    expect(instagramMediaFields).not.toContain("comments");
    expect(instagramMediaFields).not.toContain("insights");
  });
});

describe("classifyInstagramMedia", () => {
  it("classifies a VIDEO with product type REELS as a Reel", () => {
    expect(classifyInstagramMedia({ mediaProductType: "REELS", mediaType: "VIDEO" })).toBe("REEL");
  });

  it("treats the product type as authoritative over the media type", () => {
    expect(classifyInstagramMedia({ mediaProductType: "REELS", mediaType: "IMAGE" })).toBe("REEL");
  });

  it.each([
    ["VIDEO", "FEED", "VIDEO"],
    ["IMAGE", "FEED", "IMAGE"],
    ["CAROUSEL_ALBUM", "FEED", "CAROUSEL_ALBUM"],
    ["VIDEO", null, "VIDEO"],
  ])("classifies %s/%s as %s", (mediaType, mediaProductType, expected) => {
    expect(classifyInstagramMedia({ mediaProductType, mediaType })).toBe(expected);
  });

  it("marks an unrecognised media type unsupported rather than discarding it", () => {
    expect(classifyInstagramMedia({ mediaProductType: "AD", mediaType: "HOLOGRAM" })).toBe(
      "UNSUPPORTED",
    );
  });
});

describe("parseInstagramTimestamp", () => {
  it("accepts the compact offset Meta returns", () => {
    expect(parseInstagramTimestamp("2026-07-01T04:12:33+0000")?.toISOString()).toBe(
      "2026-07-01T04:12:33.000Z",
    );
  });

  it("accepts a Zulu timestamp", () => {
    expect(parseInstagramTimestamp("2026-07-01T04:12:33Z")?.toISOString()).toBe(
      "2026-07-01T04:12:33.000Z",
    );
  });

  it.each([null, "", "not-a-timestamp", "1998-01-01T00:00:00Z", "2200-01-01T00:00:00Z"])(
    "rejects %s",
    (value) => {
      expect(parseInstagramTimestamp(value)).toBeNull();
    },
  );
});

describe("normaliseInstagramMediaItem", () => {
  it("normalises a Reel and keeps both provider type values", () => {
    const result = normaliseInstagramMediaItem(reelItem);

    expect(result.ok).toBe(true);
    if (!result.ok) expect.unreachable("expected a normalised Reel");

    expect(result.media.providerMediaId).toBe("17912345678901234");
    expect(result.media.kind).toBe("REEL");
    expect(result.media.mediaType).toBe("VIDEO");
    expect(result.media.mediaProductType).toBe("REELS");
    expect(result.media.publishedAt.toISOString()).toBe("2026-07-01T04:12:33.000Z");
    expect(result.media.caption).toBe("Behind the scenes of the shoot");
    expect(result.media.username).toBe("studioparallel");
  });

  it("keeps an unknown product type inspectable on an unsupported item", () => {
    const result = normaliseInstagramMediaItem({
      ...reelItem,
      media_product_type: "AD",
      media_type: "HOLOGRAM",
    });

    if (!result.ok) expect.unreachable("unsupported media must still be retained");
    expect(result.media.kind).toBe("UNSUPPORTED");
    expect(result.media.mediaProductType).toBe("AD");
    expect(result.media.mediaType).toBe("HOLOGRAM");
    expect(result.media.rawPayload.media_product_type).toBe("AD");
  });

  it("surfaces provider URLs only as labelled ephemeral values", () => {
    const result = normaliseInstagramMediaItem(reelItem);
    if (!result.ok) expect.unreachable("expected a normalised Reel");

    expect(result.media.ephemeralMediaUrl).toBe(reelItem.media_url);
    expect(result.media.ephemeralThumbnailUrl).toBe(reelItem.thumbnail_url);
    // There is deliberately no durable asset field for a provider URL to reach.
    expect(Object.keys(result.media)).not.toContain("mediaUrl");
    expect(Object.keys(result.media)).not.toContain("sourceAssetUrl");
  });

  it.each([
    ["a plaintext media url", "media_url", "http://scontent.cdninstagram.com/v/reel.mp4"],
    ["a script permalink", "permalink", "javascript:alert(1)"],
  ])("drops %s", (_label, field, value) => {
    const result = normaliseInstagramMediaItem({ ...reelItem, [field]: value });
    if (!result.ok) expect.unreachable("the item itself remains valid");

    const normalised =
      field === "permalink" ? result.media.permalink : result.media.ephemeralMediaUrl;
    expect(normalised).toBeNull();
  });

  it.each([
    ["ITEM_NOT_OBJECT", "not-an-object"],
    ["ITEM_NOT_OBJECT", null],
    ["ITEM_NOT_OBJECT", ["array"]],
  ])("rejects a non-object item as %s", (reason, item) => {
    const result = normaliseInstagramMediaItem(item);
    expect(result).toEqual({ ok: false, reason });
  });

  it.each([
    ["MEDIA_ID_INVALID", { ...reelItem, id: undefined }],
    ["MEDIA_ID_INVALID", { ...reelItem, id: "" }],
    ["MEDIA_ID_INVALID", { ...reelItem, id: "17912345678901234; DROP TABLE" }],
    ["MEDIA_ID_INVALID", { ...reelItem, id: 17912345678901234 }],
    ["MEDIA_TYPE_INVALID", { ...reelItem, media_type: undefined }],
    ["MEDIA_TYPE_INVALID", { ...reelItem, media_type: "video" }],
    ["TIMESTAMP_INVALID", { ...reelItem, timestamp: undefined }],
    ["TIMESTAMP_INVALID", { ...reelItem, timestamp: "yesterday" }],
  ])("rejects a malformed item as %s", (reason, item) => {
    const result = normaliseInstagramMediaItem(item);
    expect(result).toEqual({ ok: false, reason });
  });

  it("rejects an item too large to be a plausible media record", () => {
    const result = normaliseInstagramMediaItem({ ...reelItem, caption: "x".repeat(70_000) });
    expect(result).toEqual({ ok: false, reason: "ITEM_TOO_LARGE" });
  });
});

describe("hashInstagramMediaPayload", () => {
  it("is stable when the provider reorders fields", () => {
    const reordered = Object.fromEntries(Object.entries(reelItem).reverse());
    expect(hashInstagramMediaPayload(reordered)).toBe(hashInstagramMediaPayload(reelItem));
  });

  it("is stable when only the signed CDN URLs are regenerated", () => {
    const refetched = {
      ...reelItem,
      media_url: "https://scontent.cdninstagram.com/v/reel.mp4?oe=SIGNATURE_TWO",
      thumbnail_url: "https://scontent.cdninstagram.com/v/thumb.jpg?oe=SIGNATURE_TWO",
    };

    expect(hashInstagramMediaPayload(refetched)).toBe(hashInstagramMediaPayload(reelItem));
  });

  it("changes when durable content changes", () => {
    expect(hashInstagramMediaPayload({ ...reelItem, caption: "Edited caption" })).not.toBe(
      hashInstagramMediaPayload(reelItem),
    );
  });
});

describe("readInstagramMediaPage", () => {
  it("reads items and the forward cursor", () => {
    const page = readInstagramMediaPage({
      data: [reelItem],
      paging: { cursors: { after: "QVFIUmZAt", before: "QVFIUlpX" }, next: "https://graph" },
    });

    expect(page.items).toHaveLength(1);
    expect(page.after).toBe("QVFIUmZAt");
    expect(page.hasNextPage).toBe(true);
  });

  it("reports the final page", () => {
    const page = readInstagramMediaPage({ data: [], paging: { cursors: { after: "QVFIUmZAt" } } });

    expect(page.hasNextPage).toBe(false);
    expect(page.items).toHaveLength(0);
  });

  it("refuses a cursor that is not an opaque provider token", () => {
    const page = readInstagramMediaPage({
      data: [],
      paging: { cursors: { after: "../../v25.0/other/media" }, next: "https://graph" },
    });

    expect(page.after).toBeNull();
  });

  it("tolerates a body that is not a page", () => {
    expect(readInstagramMediaPage(null)).toEqual({ after: null, hasNextPage: false, items: [] });
  });
});

describe("classifyInstagramResponse", () => {
  it.each([
    [429, {}, "rate_limit"],
    [401, {}, "authorisation"],
    [403, {}, "authorisation"],
    [500, {}, "transient"],
    [503, {}, "transient"],
    [400, { error: { code: 190 } }, "authorisation"],
    [400, { error: { code: 4 } }, "rate_limit"],
    [400, { error: { code: 32 } }, "rate_limit"],
    [400, { error: { code: 100 } }, "unsupported"],
    [400, { error: { error_subcode: 2108006 } }, "unsupported"],
    [400, { error: { code: 2207026 } }, "invalid_request"],
    [404, {}, "invalid_request"],
  ])("classifies HTTP %s as %s", (status, body, expected) => {
    expect(classifyInstagramResponse({ body, status })).toBe(expected);
  });
});

describe("summariseInstagramUsage", () => {
  it("keeps only the peak percentage per header", () => {
    const usage = summariseInstagramUsage(
      headerLookup({
        "x-app-usage": JSON.stringify({ call_count: 12, total_cputime: 31, total_time: 7 }),
      }),
    );

    expect(usage).toEqual([{ header: "x-app-usage", maximumPercentage: 31 }]);
  });

  it("records an unparseable header without discarding the observation", () => {
    const usage = summariseInstagramUsage(headerLookup({ "x-app-usage": "not-json" }));
    expect(usage).toEqual([{ header: "x-app-usage", maximumPercentage: null }]);
  });

  it("omits headers the provider did not send", () => {
    expect(summariseInstagramUsage(headerLookup({}))).toEqual([]);
  });

  it("retains no business-use-case identifier", () => {
    const usage = summariseInstagramUsage(
      headerLookup({
        "x-business-use-case-usage": JSON.stringify({ "17841400000000000": [{ call_count: 5 }] }),
      }),
    );

    expect(JSON.stringify(usage)).not.toContain("17841400000000000");
    expect(usage).toEqual([{ header: "x-business-use-case-usage", maximumPercentage: 5 }]);
  });
});

describe("parseInstagramRetryAfterMs", () => {
  it("reads a delay in seconds", () => {
    expect(parseInstagramRetryAfterMs("30")).toBe(30_000);
  });

  it("clamps an implausible delay to a day", () => {
    expect(parseInstagramRetryAfterMs("999999")).toBe(86_400_000);
  });

  it.each([null, undefined, "", "0", "-5", "Wed, 21 Oct 2026 07:28:00 GMT"])(
    "ignores %s",
    (value) => {
      expect(parseInstagramRetryAfterMs(value)).toBeNull();
    },
  );
});
