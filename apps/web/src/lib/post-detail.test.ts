import { describe, expect, it } from "vitest";

import {
  analysisFacts,
  metricRows,
  postDetailHref,
  presentCommentAuthor,
  presentCommentLikes,
  threadComments,
} from "./post-detail";
import type {
  PostDetailAnalysis,
  PostDetailComment,
  PostDetailMetrics,
} from "./server/post-detail-data";

/**
 * The presentation rules that decide whether a reader is misled.
 *
 * Almost every case below is about one distinction: a number that was observed
 * and happens to be zero, against a number that was never observed at all. Meta
 * documents an unavailable insight as empty data rather than as a zero, so
 * collapsing the two would turn "we do not know" into "nobody did this" — a
 * claim a reader would act on, and one nothing in the data supports.
 */

function metrics(overrides: Partial<PostDetailMetrics> = {}): PostDetailMetrics {
  return {
    ageWindow: "day_7",
    averageWatchTimeMs: 12_400,
    capturedAt: "2026-08-05T22:15:00.000Z",
    comments: 4,
    likes: 218,
    reach: 4_902,
    saves: 74,
    shares: 31,
    views: 8_140,
    ...overrides,
  };
}

function analysis(overrides: Partial<PostDetailAnalysis> = {}): PostDetailAnalysis {
  return {
    analysedAt: "2026-07-30T04:00:00.000Z",
    contentFormat: "behind_the_scenes",
    contentPillar: "process_and_craft",
    ctaType: "follow",
    durationSeconds: 42,
    hookCategory: "question",
    presenterMode: "founder_on_camera",
    transcript: "The first mistake is putting the key light straight on.",
    ...overrides,
  };
}

function comment(overrides: Partial<PostDetailComment> = {}): PostDetailComment {
  return {
    id: "019a0000-0000-7000-8000-000000000501",
    likeCount: 3,
    parentProviderCommentId: null,
    providerCommentId: "c-100",
    publishedAt: "2026-07-30T01:00:00.000Z",
    text: "The softbox tip changed how I shoot.",
    username: "lena.makes",
    ...overrides,
  };
}

function rowFor(source: PostDetailMetrics, key: string) {
  const row = metricRows(source).find((candidate) => candidate.key === key);
  if (row === undefined) throw new Error(`no metric row for ${key}`);

  return row;
}

describe("metricRows", () => {
  it("carries every metric the acceptance criteria name, in a stable order", () => {
    // The order is the reading order the screen depends on, and a row silently
    // disappearing would be indistinguishable from a metric this product does
    // not collect.
    expect(metricRows(metrics()).map((row) => row.label)).toEqual([
      "Views",
      "Reach",
      "Likes",
      "Comments",
      "Shares",
      "Saves",
      "Average watch time",
    ]);
  });

  it("renders an unreported metric as not measured rather than as zero", () => {
    const row = rowFor(metrics({ views: null }), "views");

    expect(row.measured).toBe(false);
    expect(row.value).toBe("Not measured");
    expect(row.value).not.toContain("0");
  });

  it("renders a measured zero as zero, because it is a real observation", () => {
    // The inverse of the case above, and the one that proves the rule is about
    // absence rather than about falsiness. A post nobody shared did get
    // observed, and hiding that behind "not measured" would lose a finding.
    const row = rowFor(metrics({ shares: 0 }), "shares");

    expect(row.measured).toBe(true);
    expect(row.value).toBe("0");
  });

  it("keeps an unreported watch time apart from a watch time of zero", () => {
    expect(rowFor(metrics({ averageWatchTimeMs: null }), "averageWatchTime").value).toBe(
      "Not measured",
    );
    expect(rowFor(metrics({ averageWatchTimeMs: 0 }), "averageWatchTime").value).toBe("0s");
  });

  it("groups large counts and reports watch time in minutes once it passes one", () => {
    expect(rowFor(metrics({ views: 1_204_500 }), "views").value).toBe("1,204,500");
    expect(rowFor(metrics({ averageWatchTimeMs: 12_400 }), "averageWatchTime").value).toBe("12s");
    expect(rowFor(metrics({ averageWatchTimeMs: 95_000 }), "averageWatchTime").value).toBe(
      "1m 35s",
    );
  });
});

describe("analysisFacts", () => {
  it("labels and words every facet the way trends words it", () => {
    // The same stored value has to read identically wherever it appears. Two
    // spellings of one pillar read as two different findings.
    expect(analysisFacts(analysis()).map((fact) => [fact.label, fact.value])).toEqual([
      ["Content pillar", "Process and craft"],
      ["Format", "Behind the scenes"],
      ["Hook type", "Question"],
      ["Presenter", "Founder on camera"],
      ["Call to action", "Follow"],
      ["Duration", "42s"],
    ]);
  });

  it("names an unobserved facet as not observed rather than dropping it", () => {
    const facts = analysisFacts(analysis({ contentPillar: null, durationSeconds: null }));

    // Dropping the row would leave a reader unable to tell a facet the model
    // could not observe from one this product never asks about. It is worded
    // differently from a metric's absence because the cause is different: the
    // model looked and could not tell, rather than the provider not reporting.
    expect(facts[0]).toEqual({ label: "Content pillar", recorded: false, value: "Not observed" });
    expect(facts.at(-1)).toEqual({ label: "Duration", recorded: false, value: "Not observed" });
  });
});

describe("threadComments", () => {
  it("nests a reply under the comment it answers", () => {
    const parent = comment({ id: "a", providerCommentId: "c-1" });
    const reply = comment({
      id: "b",
      parentProviderCommentId: "c-1",
      providerCommentId: "c-2",
    });

    const threads = threadComments([parent, reply]);

    expect(threads).toHaveLength(1);
    expect(threads[0]?.comment.id).toBe("a");
    expect(threads[0]?.replies.map((entry) => entry.id)).toEqual(["b"]);
  });

  it("orders replies oldest first even though the page arrives most-liked first", () => {
    // The like ordering decides which comments are worth carrying when the list
    // is capped. It is not an order to read a conversation in, and a reply shown
    // above the reply it answers is simply wrong.
    const parent = comment({ id: "a", providerCommentId: "c-1" });
    const liked = comment({
      id: "b",
      likeCount: 40,
      parentProviderCommentId: "c-1",
      providerCommentId: "c-2",
      publishedAt: "2026-07-30T09:00:00.000Z",
    });
    const earlier = comment({
      id: "c",
      likeCount: 1,
      parentProviderCommentId: "c-1",
      providerCommentId: "c-3",
      publishedAt: "2026-07-30T02:00:00.000Z",
    });

    const threads = threadComments([parent, liked, earlier]);

    expect(threads[0]?.replies.map((entry) => entry.id)).toEqual(["c", "b"]);
  });

  it("keeps a reply whose parent is not in the page, and marks it as one", () => {
    // Meta returns replies whose parent falls outside the imported set, and the
    // schema deliberately does not make the parent id a foreign key for that
    // reason. Hiding the reply would lose a stranger's words on the strength of
    // a page boundary; showing it unlabelled would present it as a new thread.
    const orphan = comment({
      id: "b",
      parentProviderCommentId: "c-999",
      providerCommentId: "c-2",
    });

    const threads = threadComments([orphan]);

    expect(threads).toHaveLength(1);
    expect(threads[0]?.orphanedReply).toBe(true);
    expect(threads[0]?.replies).toHaveLength(0);
  });

  it("does not lose a comment that names itself as its own parent", () => {
    // Nothing forbids it at the database level, and a self-parented row would
    // otherwise be filed under itself and never rendered.
    const self = comment({ id: "a", parentProviderCommentId: "c-1", providerCommentId: "c-1" });

    expect(threadComments([self]).map((thread) => thread.comment.id)).toEqual(["a"]);
  });

  it("returns top-level comments in the order they were loaded", () => {
    const first = comment({ id: "a", providerCommentId: "c-1" });
    const second = comment({ id: "b", providerCommentId: "c-2" });

    expect(threadComments([second, first]).map((thread) => thread.comment.id)).toEqual(["b", "a"]);
  });
});

describe("presentCommentAuthor", () => {
  it("states that no account was recorded rather than inventing a handle", () => {
    // Meta omits the username for a deleted or restricted account. A
    // placeholder shaped like a handle would attribute a stranger's words to a
    // name nobody used.
    expect(presentCommentAuthor(null)).toBe("Account not recorded");
    expect(presentCommentAuthor("lena.makes")).toBe("@lena.makes");
  });
});

describe("presentCommentLikes", () => {
  it("keeps an unrecorded like count apart from no likes", () => {
    expect(presentCommentLikes(null)).toBe("Likes not recorded");
    expect(presentCommentLikes(0)).toBe("0 likes");
    expect(presentCommentLikes(1)).toBe("1 like");
    expect(presentCommentLikes(2_400)).toBe("2,400 likes");
  });
});

describe("postDetailHref", () => {
  it("points at the post itself rather than at one of its controls", () => {
    expect(postDetailHref("019a0000-0000-7000-8000-000000000401")).toBe(
      "/posts/019a0000-0000-7000-8000-000000000401",
    );
  });
});
