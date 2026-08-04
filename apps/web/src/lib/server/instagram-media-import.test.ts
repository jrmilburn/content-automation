import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The request that starts an import.
 *
 * It only enqueues, so what matters is the order of its checks: the rate limit
 * runs before the post is looked up, so the limit itself cannot be used to
 * discover which posts exist, and a crafted identifier is refused with the same
 * reason as an absent one.
 */

const actor = {
  internalUserId: "0192f2a0-0000-7000-8000-000000000001",
  sessionVersion: 1,
  workspaceId: "0192f2a0-0000-7000-8000-0000000000ff",
};

const postId = "019a0000-0000-7000-8000-000000000401";
const correlationId = "0192f2a0-0000-7000-8000-00000000abcd";

const auditRecord = vi.fn();
const countRecentByActor = vi.fn();
const findFirst = vi.fn();
const enqueueBackgroundJob = vi.fn();

vi.mock("@studio-parallel/config", () => ({
  loadAuthConfig: () => ({ APP_ENV: "local" }),
}));

vi.mock("@studio-parallel/db", () => ({
  createWorkspaceContext: (workspaceId: string) => ({ workspaceId }),
  createWorkspaceRepositories: () => ({
    audit: {
      countRecentByActor: (...args: unknown[]) => countRecentByActor(...args),
      record: (...args: unknown[]) => auditRecord(...args),
    },
  }),
  enqueueBackgroundJob: (...args: unknown[]) => enqueueBackgroundJob(...args),
  instagramPostResourceType: "instagram_post",
  isUuidV7: (value: string) =>
    /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value),
}));

vi.mock("./database", () => ({
  getDatabase: () => ({ instagramPost: { findFirst: (...args: unknown[]) => findFirst(...args) } }),
}));

const { mediaImportRequestLimit, requestInstagramMediaImport } =
  await import("./instagram-media-import");

function request(overrides: Partial<Parameters<typeof requestInstagramMediaImport>[0]> = {}) {
  return requestInstagramMediaImport({ actor, correlationId, postId, ...overrides });
}

beforeEach(() => {
  vi.clearAllMocks();
  countRecentByActor.mockResolvedValue(0);
  auditRecord.mockResolvedValue(undefined);
  enqueueBackgroundJob.mockResolvedValue(undefined);
  findFirst.mockResolvedValue({ id: postId, mediaKind: "REEL", videoAssets: [] });
});

describe("requesting an import", () => {
  it("queues the post, anchored on a key a second press reuses", async () => {
    await expect(request()).resolves.toEqual({ queued: true });

    expect(enqueueBackgroundJob).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        idempotencyKey: `instagram-media-import-${postId}`,
        queueName: "instagram.media.import",
        resourceId: postId,
      }),
    );
    expect(auditRecord).toHaveBeenCalledWith(expect.objectContaining({ outcome: "QUEUED" }));
  });

  it("checks the attempt limit before looking the post up", async () => {
    countRecentByActor.mockResolvedValue(mediaImportRequestLimit);

    await expect(request()).resolves.toEqual({ queued: false, reason: "RATE_LIMITED" });

    // Looking first would let the limit report which posts exist.
    expect(findFirst).not.toHaveBeenCalled();
    expect(enqueueBackgroundJob).not.toHaveBeenCalled();
  });

  it("refuses a crafted identifier without querying, and does not audit it as a resource", async () => {
    await expect(request({ postId: "not-a-uuid" })).resolves.toEqual({
      queued: false,
      reason: "POST_NOT_FOUND",
    });

    expect(findFirst).not.toHaveBeenCalled();
    expect(auditRecord).toHaveBeenCalledWith(
      expect.not.objectContaining({ resourceId: expect.anything() }),
    );
  });

  it("refuses a post from another workspace exactly as it refuses an absent one", async () => {
    findFirst.mockResolvedValue(null);

    await expect(request()).resolves.toEqual({ queued: false, reason: "POST_NOT_FOUND" });
    expect(enqueueBackgroundJob).not.toHaveBeenCalled();
  });

  it("refuses a post that has no video to bring across", async () => {
    findFirst.mockResolvedValue({ id: postId, mediaKind: "IMAGE", videoAssets: [] });

    await expect(request()).resolves.toEqual({ queued: false, reason: "NOT_A_VIDEO" });
    expect(enqueueBackgroundJob).not.toHaveBeenCalled();
  });

  it("refuses to import over a video that is already attached", async () => {
    for (const state of ["READY", "PENDING_VALIDATION"]) {
      findFirst.mockResolvedValue({ id: postId, mediaKind: "REEL", videoAssets: [{ state }] });

      await expect(request()).resolves.toEqual({ queued: false, reason: "ALREADY_HAS_SOURCE" });
    }

    // Replacing an attached video is a separate outcome with its own cleanup.
    expect(enqueueBackgroundJob).not.toHaveBeenCalled();
  });

  it("allows an import after a rejection, because that post still needs a video", async () => {
    findFirst.mockResolvedValue({
      id: postId,
      mediaKind: "REEL",
      videoAssets: [{ state: "REJECTED" }],
    });

    await expect(request()).resolves.toEqual({ queued: true });
    expect(enqueueBackgroundJob).toHaveBeenCalled();
  });
});
