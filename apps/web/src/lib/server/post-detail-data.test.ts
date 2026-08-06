import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The one read behind the post detail screen.
 *
 * Three things are worth proving here and they are all things a green screen
 * would hide. That every query carries the caller's workspace, because the only
 * evidence a reader has that they are looking at their own post is that the
 * loader said so. That an unreported metric arrives as null rather than as a
 * zero, because the screen can only tell those apart if the loader did. And that
 * the transcript is read out of the observation's `value`, because a shape
 * mismatch there returns null silently and looks exactly like a post nobody
 * spoke on.
 *
 * The database is a stand-in shaped like Prisma rather than a mock of the db
 * package, so the arguments asserted below are the ones a real query would
 * receive. The comment reads run through the real `loadInstagramComments` and
 * `countInstagramCommentsByPost` for the same reason.
 */

const actor = {
  internalUserId: "0192f2a0-0000-7000-8000-000000000001",
  sessionVersion: 1,
  workspaceId: "0192f2a0-0000-7000-8000-0000000000ff",
};

const postId = "019a0000-0000-7000-8000-000000000401";

const findFirst = vi.fn();
const findMany = vi.fn();
const groupBy = vi.fn();

// Read on every call, so one test can exercise the browser-fixture branch
// without a second module graph.
let appEnv = "local";

vi.mock("@studio-parallel/config", () => ({
  loadAuthConfig: () => ({ APP_ENV: appEnv }),
}));

vi.mock("./database", () => ({
  getDatabase: () => ({
    instagramComment: {
      findMany: (...args: unknown[]) => findMany(...args),
      groupBy: (...args: unknown[]) => groupBy(...args),
    },
    instagramPost: { findFirst: (...args: unknown[]) => findFirst(...args) },
  }),
}));

const { loadPostDetail } = await import("./post-detail-data");

/** An observation leaf as the analysis contract stores it. */
function observation(value: string | null) {
  return value === null
    ? {
        availability: "unknown",
        basis: null,
        confidence: null,
        evidence: [],
        limitation: "The audio carried no speech.",
        value: null,
      }
    : {
        availability: "available",
        basis: "observed",
        confidence: "high",
        evidence: [],
        limitation: null,
        value,
      };
}

function postRow(overrides: Record<string, unknown> = {}) {
  return {
    caption: "Three lighting mistakes.",
    currentAnalysis: {
      analysedAt: new Date("2026-07-30T04:00:00.000Z"),
      contentFormat: "behind_the_scenes",
      contentPillar: "process_and_craft",
      ctaType: "follow",
      durationSeconds: 42.4,
      hookCategory: "question",
      presenterMode: "founder_on_camera",
      result: { content: { transcript: observation("The first mistake is the key light.") } },
    },
    id: postId,
    mediaKind: "REEL",
    mediaProductType: "REELS",
    permalink: "https://www.instagram.com/reel/abc123/",
    publishedAt: new Date("2026-07-29T22:15:00.000Z"),
    snapshots: [snapshotRow()],
    ...overrides,
  };
}

function snapshotRow(overrides: Record<string, unknown> = {}) {
  return {
    ageBucket: "DAY_7",
    averageWatchTimeMs: 12_400,
    capturedAt: new Date("2026-08-05T22:15:00.000Z"),
    comments: 4,
    likes: 218,
    reach: 4_902,
    saves: 74,
    shares: 31,
    views: 8_140,
    ...overrides,
  };
}

function commentRow(overrides: Record<string, unknown> = {}) {
  return {
    firstImportedAt: new Date("2026-07-30T05:00:00.000Z"),
    id: "019a0000-0000-7000-8000-000000000501",
    instagramPostId: postId,
    lastImportedAt: new Date("2026-07-31T05:00:00.000Z"),
    likeCount: 12,
    parentProviderCommentId: null,
    providerCommentId: "c-100",
    publishedAt: new Date("2026-07-30T01:00:00.000Z"),
    text: "The softbox tip changed how I shoot.",
    username: "lena.makes",
    ...overrides,
  };
}

/** Every key named anywhere in a Prisma `select`, however deeply nested. */
function selectedFields(node: unknown, found: Set<string> = new Set()): Set<string> {
  if (typeof node !== "object" || node === null) return found;

  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (key !== "select" && key !== "where" && key !== "orderBy") found.add(key);
    selectedFields(value, found);
  }

  return found;
}

beforeEach(() => {
  vi.clearAllMocks();
  appEnv = "local";
  findFirst.mockResolvedValue(postRow());
  findMany.mockResolvedValue([]);
  groupBy.mockResolvedValue([]);
});

describe("resolving the post", () => {
  it("refuses a malformed identifier without asking the database", async () => {
    // A crafted identifier must cost nothing and reveal nothing. Querying first
    // and discarding the answer would make the route's timing a signal.
    await expect(loadPostDetail(actor, "not-a-post-id")).resolves.toBeNull();

    expect(findFirst).not.toHaveBeenCalled();
  });

  it("scopes the lookup to the caller's workspace", async () => {
    await loadPostDetail(actor, postId);

    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: postId, workspaceId: actor.workspaceId } }),
    );
  });

  it("reads no comments for a post it could not find", async () => {
    // Another workspace's post and an absent one answer identically, and
    // neither may reach a second query that could be timed or counted.
    findFirst.mockResolvedValue(null);

    await expect(loadPostDetail(actor, postId)).resolves.toBeNull();

    expect(findMany).not.toHaveBeenCalled();
    expect(groupBy).not.toHaveBeenCalled();
  });

  it("scopes both comment reads to the same workspace", async () => {
    await loadPostDetail(actor, postId);

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { instagramPostId: postId, workspaceId: actor.workspaceId },
      }),
    );
    expect(groupBy).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { instagramPostId: { in: [postId] }, workspaceId: actor.workspaceId },
      }),
    );
  });

  it("never asks for the raw provider payload", async () => {
    // It is storage provenance and holds the unsanitised original of every
    // comment. Selecting it would put a stranger's unfiltered text one
    // serialisation away from a browser.
    await loadPostDetail(actor, postId);

    for (const call of [findFirst.mock.calls[0], findMany.mock.calls[0]]) {
      const fields = selectedFields(call?.[0]);
      expect(fields).not.toContain("rawPayload");
      expect(fields).not.toContain("rawPayloadHash");
    }
  });
});

describe("metrics", () => {
  it("carries an unreported metric through as null rather than as zero", async () => {
    // Meta documents an unavailable insight as empty data. Coercing it here
    // would make "we do not know" indistinguishable from "nobody watched", and
    // the screen would have nothing left to tell them apart with.
    findFirst.mockResolvedValue(
      postRow({ snapshots: [snapshotRow({ averageWatchTimeMs: null, shares: null, views: 0 })] }),
    );

    const detail = await loadPostDetail(actor, postId);

    expect(detail?.metrics?.averageWatchTimeMs).toBeNull();
    expect(detail?.metrics?.shares).toBeNull();
    // The inverse: a measured zero survives as a zero.
    expect(detail?.metrics?.views).toBe(0);
  });

  it("names the age of the observation it took", async () => {
    // The newest snapshot is the honest answer to "what did this post do", but
    // it is only readable if the reader is told how old the measurement is.
    const detail = await loadPostDetail(actor, postId);

    expect(detail?.metrics?.ageWindow).toBe("day_7");
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        select: expect.objectContaining({
          snapshots: expect.objectContaining({ orderBy: { capturedAt: "desc" }, take: 1 }),
        }),
      }),
    );
  });

  it("reports no metrics at all when nothing has ever been captured", async () => {
    // Distinct from a snapshot whose columns are empty. Nothing was observed,
    // so there is no observation to date or to qualify.
    findFirst.mockResolvedValue(postRow({ snapshots: [] }));

    await expect(loadPostDetail(actor, postId)).resolves.toMatchObject({ metrics: null });
  });
});

describe("the analysis", () => {
  it("reads the transcript out of the observation's value", async () => {
    const detail = await loadPostDetail(actor, postId);

    expect(detail?.analysis?.transcript).toBe("The first mistake is the key light.");
  });

  it("returns no transcript when the observation was not available", async () => {
    // A non-available observation carries a null value. Rendering the wrapper's
    // presence as an empty transcript would claim the video was silent.
    findFirst.mockResolvedValue(
      postRow({
        currentAnalysis: {
          ...postRow().currentAnalysis,
          result: { content: { transcript: observation(null) } },
        },
      }),
    );

    await expect(loadPostDetail(actor, postId)).resolves.toMatchObject({
      analysis: expect.objectContaining({ transcript: null }),
    });
  });

  it("returns no transcript when the stored result has no transcript at all", async () => {
    findFirst.mockResolvedValue(
      postRow({ currentAnalysis: { ...postRow().currentAnalysis, result: {} } }),
    );

    await expect(loadPostDetail(actor, postId)).resolves.toMatchObject({
      analysis: expect.objectContaining({ transcript: null }),
    });
  });

  it("rounds the stored decimal duration to whole seconds", async () => {
    // A Decimal cannot cross the server boundary as-is, and nothing reports a
    // video length to the millisecond.
    await expect(loadPostDetail(actor, postId)).resolves.toMatchObject({
      analysis: expect.objectContaining({ durationSeconds: 42 }),
    });
  });

  it("reports no analysis when none is current", async () => {
    findFirst.mockResolvedValue(postRow({ currentAnalysis: null }));

    await expect(loadPostDetail(actor, postId)).resolves.toMatchObject({ analysis: null });
  });
});

describe("comments", () => {
  it("reports the stored total beside the capped list", async () => {
    // A reader shown two comments and told there are two would draw a
    // conclusion about an audience from a two-hundredth of it.
    findMany.mockResolvedValue([commentRow(), commentRow({ id: "b", providerCommentId: "c-101" })]);
    groupBy.mockResolvedValue([{ _count: { _all: 412 }, instagramPostId: postId }]);

    const detail = await loadPostDetail(actor, postId);

    expect(detail?.comments).toHaveLength(2);
    expect(detail?.commentCount).toBe(412);
  });

  it("caps what it loads rather than trusting the post to be small", async () => {
    await loadPostDetail(actor, postId);

    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ take: expect.any(Number) }));
  });

  it("carries the parent id so a reply can be told from a new thread", async () => {
    findMany.mockResolvedValue([commentRow({ parentProviderCommentId: "c-099" })]);
    groupBy.mockResolvedValue([{ _count: { _all: 1 }, instagramPostId: postId }]);

    const detail = await loadPostDetail(actor, postId);

    expect(detail?.comments[0]?.parentProviderCommentId).toBe("c-099");
  });

  it("reports no comments when none have been imported", async () => {
    await expect(loadPostDetail(actor, postId)).resolves.toMatchObject({
      commentCount: 0,
      comments: [],
    });
  });
});

describe("the browser fixture", () => {
  it("answers without a database, and only for the posts the list fixture shows", async () => {
    // Browser and accessibility runs have no database. Without this the linked
    // page would throw for every fixture post, and the a11y suite would only
    // ever see an error boundary.
    appEnv = "test";

    const detail = await loadPostDetail(actor, postId);

    expect(detail?.id).toBe(postId);
    expect(findFirst).not.toHaveBeenCalled();
    await expect(loadPostDetail(actor, "019a0000-0000-7000-8000-0000000009ff")).resolves.toBeNull();
  });
});
