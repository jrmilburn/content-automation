import { describe, expect, it } from "vitest";

import {
  buildPostsHref,
  captionExcerpt,
  hasActiveFilters,
  parsePostsFilters,
  presentMediaKind,
  type PostsFilterValues,
} from "./posts-list";

const accountId = "019a0000-0000-7000-8000-000000000301";

function values(overrides: Partial<PostsFilterValues> = {}): PostsFilterValues {
  return { account: "", from: "", kind: "all", search: "", to: "", ...overrides };
}

describe("parsePostsFilters", () => {
  it("returns no filters for an empty query", () => {
    const parsed = parsePostsFilters({});

    expect(parsed.filters).toEqual({});
    expect(parsed.cursor).toBeNull();
    expect(parsed.values).toEqual(values());
  });

  it("accepts a known media kind", () => {
    expect(parsePostsFilters({ kind: "REEL" }).filters).toEqual({ mediaKind: "REEL" });
  });

  it("treats an unknown media kind as matching nothing rather than ignoring it", () => {
    // Dropping it would silently widen the result to every post, which reads as
    // "these are your matches" when the filter was really discarded.
    expect(parsePostsFilters({ kind: "REELS" }).filters).toMatchObject({ matchesNothing: true });
  });

  it("accepts a well-formed account and rejects a crafted one", () => {
    expect(parsePostsFilters({ account: accountId }).filters).toEqual({
      instagramAccountId: accountId,
    });
    expect(parsePostsFilters({ account: "../../etc/passwd" }).filters).toMatchObject({
      matchesNothing: true,
    });
  });

  it("treats 'all' as unset rather than invalid", () => {
    expect(parsePostsFilters({ account: "all", kind: "all" }).filters).toEqual({});
  });

  it("includes the whole of the end day in a date range", () => {
    const parsed = parsePostsFilters({ from: "2026-07-01", to: "2026-07-31" });

    expect(parsed.filters.publishedFrom?.toISOString()).toBe("2026-07-01T00:00:00.000Z");
    // An end bound of midnight would exclude everything published that day.
    expect(parsed.filters.publishedTo?.toISOString()).toBe("2026-07-31T23:59:59.999Z");
  });

  it.each(["31-07-2026", "2026-13-01", "yesterday", "2026-07"])(
    "rejects the malformed date %p",
    (from) => {
      expect(parsePostsFilters({ from }).filters).toMatchObject({ matchesNothing: true });
    },
  );

  it("rejects an inverted date range", () => {
    expect(parsePostsFilters({ from: "2026-07-31", to: "2026-07-01" }).filters).toMatchObject({
      matchesNothing: true,
    });
  });

  it("trims and bounds the search term", () => {
    const parsed = parsePostsFilters({ q: `   ${"a".repeat(400)}   ` });

    expect(parsed.filters.search).toHaveLength(120);
    expect(parsed.values.search).toHaveLength(120);
  });

  it("reads only the first value of a repeated parameter", () => {
    expect(parsePostsFilters({ kind: ["IMAGE", "REEL"] }).filters).toEqual({ mediaKind: "IMAGE" });
  });

  it("carries the page anchor through separately from the filters", () => {
    const parsed = parsePostsFilters({ after: accountId, kind: "REEL" });

    expect(parsed.cursor).toBe(accountId);
    expect(parsed.filters).toEqual({ mediaKind: "REEL" });
  });
});

describe("hasActiveFilters", () => {
  it("is false only when nothing is set", () => {
    expect(hasActiveFilters(values())).toBe(false);
  });

  it.each([
    ["search", values({ search: "lighting" })],
    ["kind", values({ kind: "REEL" })],
    ["account", values({ account: accountId })],
    ["from", values({ from: "2026-07-01" })],
    ["to", values({ to: "2026-07-31" })],
  ])("is true when %s is set", (_label, candidate) => {
    expect(hasActiveFilters(candidate)).toBe(true);
  });
});

describe("buildPostsHref", () => {
  it("returns the bare path when nothing is set", () => {
    expect(buildPostsHref(values(), null)).toBe("/posts");
  });

  it("preserves every active filter when paging, so a page link cannot widen the result", () => {
    const href = buildPostsHref(
      values({ from: "2026-07-01", kind: "REEL", search: "lighting" }),
      accountId,
    );

    expect(href).toContain("q=lighting");
    expect(href).toContain("kind=REEL");
    expect(href).toContain("from=2026-07-01");
    expect(href).toContain(`after=${accountId}`);
  });

  it("encodes a search term that would otherwise break the query string", () => {
    expect(buildPostsHref(values({ search: "a&b=c d" }), null)).toBe("/posts?q=a%26b%3Dc+d");
  });
});

describe("presentMediaKind", () => {
  it("names a Reel from its product type rather than its media type", () => {
    // A published Reel reports media_type=VIDEO, so the kind column is the
    // only trustworthy signal.
    expect(presentMediaKind({ mediaKind: "REEL", mediaProductType: "REELS" })).toEqual({
      label: "Reel",
      tone: "information",
    });
  });

  it("flags retained unsupported media as a real triage bucket", () => {
    expect(presentMediaKind({ mediaKind: "UNSUPPORTED", mediaProductType: null })).toEqual({
      label: "Unsupported media",
      tone: "warning",
    });
  });

  it("labels ordinary media without raising attention", () => {
    expect(presentMediaKind({ mediaKind: "IMAGE", mediaProductType: "FEED" }).tone).toBe("neutral");
  });
});

describe("captionExcerpt", () => {
  it("names a missing caption instead of rendering an empty string", () => {
    expect(captionExcerpt(null)).toBe("No caption");
    expect(captionExcerpt("   ")).toBe("No caption");
  });

  it("collapses newlines so a multi-line caption stays one row", () => {
    expect(captionExcerpt("first\n\nsecond   third")).toBe("first second third");
  });

  it("truncates long captions with an ellipsis", () => {
    const excerpt = captionExcerpt("word ".repeat(100), 20);

    expect(excerpt).toHaveLength(20);
    expect(excerpt.endsWith("…")).toBe(true);
  });

  it("leaves a caption at the limit untouched", () => {
    expect(captionExcerpt("exactly ten", 11)).toBe("exactly ten");
  });
});
