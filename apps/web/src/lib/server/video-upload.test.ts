import { beforeEach, describe, expect, it, vi } from "vitest";

const actor = {
  internalUserId: "0192f2a0-0000-7000-8000-000000000001",
  sessionVersion: 1,
  workspaceId: "0192f2a0-0000-7000-8000-0000000000ff",
};

const postId = "019a0000-0000-7000-8000-000000000401";
const intentId = "019a0000-0000-7000-8000-000000000501";
const assetId = "019a0000-0000-7000-8000-000000000601";
const correlationId = "0192f2a0-0000-7000-8000-00000000abcd";
const objectKey = "test/0192f2a0-0000-7000-8000-0000000000ff/source-video/".concat("a".repeat(32));

const auditRecord = vi.fn();
const postFindFirst = vi.fn();
const enqueueBackgroundJob = vi.fn();
const createVideoUploadIntent = vi.fn();
const findVideoUploadIntent = vi.fn();
const closeVideoUploadIntent = vi.fn();
const createVideoAsset = vi.fn();
const findVideoAssetForIntent = vi.fn();

const createMultipartUpload = vi.fn();
const completeMultipartUpload = vi.fn();
const abortMultipartUpload = vi.fn();
const signPartUpload = vi.fn();

vi.mock("@studio-parallel/db", () => ({
  closeVideoUploadIntent: (...args: unknown[]) => closeVideoUploadIntent(...args),
  createVideoAsset: (...args: unknown[]) => createVideoAsset(...args),
  createVideoUploadIntent: (...args: unknown[]) => createVideoUploadIntent(...args),
  createWorkspaceContext: (workspaceId: string) => ({ workspaceId }),
  createWorkspaceRepositories: () => ({
    audit: { record: (...args: unknown[]) => auditRecord(...args) },
  }),
  enqueueBackgroundJob: (...args: unknown[]) => enqueueBackgroundJob(...args),
  findVideoAssetForIntent: (...args: unknown[]) => findVideoAssetForIntent(...args),
  findVideoUploadIntent: (...args: unknown[]) => findVideoUploadIntent(...args),
  isUuidV7: (value: string) =>
    /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value),
  uploadIntentAbortedAction: "video.upload.aborted",
  uploadIntentCompletedAction: "video.upload.completed",
  uploadIntentInitiatedAction: "video.upload.initiated",
  videoAssetResourceType: "video_asset",
  videoUploadIntentResourceType: "video_upload_intent",
}));

vi.mock("./database", () => ({
  getDatabase: () => ({
    instagramPost: { findFirst: (...args: unknown[]) => postFindFirst(...args) },
  }),
}));

vi.mock("./object-storage", () => ({
  getObjectStorage: () => ({
    abortMultipartUpload: (...args: unknown[]) => abortMultipartUpload(...args),
    completeMultipartUpload: (...args: unknown[]) => completeMultipartUpload(...args),
    createMultipartUpload: (...args: unknown[]) => createMultipartUpload(...args),
    signPartUpload: (...args: unknown[]) => signPartUpload(...args),
  }),
  getObjectStorageConfig: () => ({
    APP_ENV: "test",
    STORAGE_BUCKET: "bucket",
    STORAGE_REGION: "auto",
    UPLOAD_ABANDON_AFTER_HOURS: 24,
    UPLOAD_MAX_BYTES: 1_073_741_824,
    UPLOAD_PART_SIZE_BYTES: 8_388_608,
    UPLOAD_SIGNED_URL_TTL_SECONDS: 900,
  }),
}));

const { abortVideoUpload, completeVideoUpload, initiateVideoUpload, signVideoUploadPart } =
  await import("./video-upload");

const pendingIntent = {
  bucket: "bucket",
  declaredBytes: 10_000_000n,
  declaredContentType: "video/mp4",
  expiresAt: new Date("2026-08-02T00:00:00.000Z"),
  id: intentId,
  instagramPostId: postId,
  objectKey,
  partCount: 2,
  partSizeBytes: 8_388_608,
  providerUploadId: "provider-upload-1",
  region: "auto",
  state: "PENDING" as const,
};

const now = new Date("2026-08-01T00:00:00.000Z");

beforeEach(() => {
  vi.clearAllMocks();
  postFindFirst.mockResolvedValue({ id: postId });
  createMultipartUpload.mockResolvedValue({ objectKey, providerUploadId: "provider-upload-1" });
  createVideoUploadIntent.mockResolvedValue(pendingIntent);
  findVideoUploadIntent.mockResolvedValue(pendingIntent);
  findVideoAssetForIntent.mockResolvedValue(null);
  closeVideoUploadIntent.mockResolvedValue(true);
  createVideoAsset.mockResolvedValue({
    bytes: 10_000_000n,
    id: assetId,
    instagramPostId: postId,
    objectKey,
    state: "PENDING_VALIDATION",
  });
  completeMultipartUpload.mockResolvedValue({
    bytes: 10_000_000,
    contentType: "video/mp4",
    etag: "composite-etag-2",
    objectVersion: "v1",
  });
  abortMultipartUpload.mockResolvedValue(undefined);
  signPartUpload.mockResolvedValue({
    expiresAt: new Date("2026-08-01T00:15:00.000Z"),
    partNumber: 1,
    url: "https://storage.invalid/signed",
  });
  enqueueBackgroundJob.mockResolvedValue({ created: true });
});

function initiate(overrides: Record<string, unknown> = {}) {
  return initiateVideoUpload({
    actor,
    correlationId,
    declaredBytes: 10_000_000,
    declaredContentType: "video/mp4",
    now,
    postId,
    ...overrides,
  });
}

describe("initiateVideoUpload authorisation", () => {
  it("refuses a crafted post id without touching the object store", async () => {
    await expect(initiate({ postId: "not-a-uuid" })).resolves.toEqual({
      initiated: false,
      reason: "POST_NOT_FOUND",
    });
    expect(createMultipartUpload).not.toHaveBeenCalled();
  });

  it("refuses a post in another workspace with the same reason as an absent one", async () => {
    postFindFirst.mockResolvedValue(null);

    await expect(initiate()).resolves.toEqual({
      initiated: false,
      reason: "POST_NOT_FOUND",
    });
    expect(createMultipartUpload).not.toHaveBeenCalled();
  });

  it("scopes the post lookup to the actor's workspace", async () => {
    await initiate();

    expect(postFindFirst).toHaveBeenCalledWith({
      select: { id: true },
      where: { id: postId, workspaceId: actor.workspaceId },
    });
  });

  it("never lets the caller choose the object key", async () => {
    await initiate({ objectKey: "attacker/chosen/key" });

    const [request] = createMultipartUpload.mock.calls[0] as [{ objectKey: string }];

    expect(request.objectKey).not.toBe("attacker/chosen/key");
    expect(request.objectKey.startsWith(`test/${actor.workspaceId}/source-video/`)).toBe(true);
  });

  it("returns no bucket, key or credential to the browser", async () => {
    const result = await initiate();
    const serialised = JSON.stringify(result);

    expect(serialised).not.toContain("bucket");
    expect(serialised).not.toContain("source-video");
    expect(serialised).not.toContain("provider-upload-1");
  });
});

describe("initiateVideoUpload admission", () => {
  it("refuses an oversized file before reserving anything", async () => {
    await expect(initiate({ declaredBytes: 1_073_741_825 })).resolves.toEqual({
      initiated: false,
      reason: "TOO_LARGE",
    });
    expect(createMultipartUpload).not.toHaveBeenCalled();
  });

  it("refuses an unsupported container", async () => {
    await expect(initiate({ declaredContentType: "video/x-msvideo" })).resolves.toEqual({
      initiated: false,
      reason: "CONTENT_TYPE_NOT_ACCEPTED",
    });
  });

  it("releases the provider reservation when a second pending upload collides", async () => {
    createVideoUploadIntent.mockRejectedValue(new Error("unique constraint"));

    await expect(initiate()).resolves.toEqual({
      initiated: false,
      reason: "UPLOAD_ALREADY_PENDING",
    });
    expect(abortMultipartUpload).toHaveBeenCalledWith({
      objectKey: expect.stringContaining("source-video/"),
      providerUploadId: "provider-upload-1",
    });
  });

  it("reports storage failure without persisting an intent", async () => {
    createMultipartUpload.mockRejectedValue(new Error("provider down"));

    await expect(initiate()).resolves.toEqual({
      initiated: false,
      reason: "STORAGE_UNAVAILABLE",
    });
    expect(createVideoUploadIntent).not.toHaveBeenCalled();
  });
});

describe("signVideoUploadPart", () => {
  function sign(overrides: Record<string, unknown> = {}) {
    return signVideoUploadPart({
      actor,
      correlationId,
      intentId,
      now,
      partNumber: 1,
      ...overrides,
    });
  }

  it("signs a part inside the reserved range", async () => {
    await expect(sign()).resolves.toMatchObject({ partNumber: 1, signed: true });
  });

  it("refuses a part number beyond the reserved part count", async () => {
    for (const partNumber of [0, -1, 3, 10_001, Number.NaN, 1.5]) {
      await expect(sign({ partNumber })).resolves.toEqual({
        reason: "PART_NUMBER_OUT_OF_RANGE",
        signed: false,
      });
    }

    expect(signPartUpload).not.toHaveBeenCalled();
  });

  it("refuses a crafted or foreign intent id identically", async () => {
    await expect(sign({ intentId: "not-a-uuid" })).resolves.toEqual({
      reason: "INTENT_NOT_FOUND",
      signed: false,
    });

    findVideoUploadIntent.mockResolvedValue(null);

    await expect(sign()).resolves.toEqual({ reason: "INTENT_NOT_FOUND", signed: false });
  });

  it("refuses to sign against an expired upload window", async () => {
    findVideoUploadIntent.mockResolvedValue({
      ...pendingIntent,
      expiresAt: new Date("2026-07-31T00:00:00.000Z"),
    });

    await expect(sign()).resolves.toEqual({ reason: "UPLOAD_EXPIRED", signed: false });
    expect(signPartUpload).not.toHaveBeenCalled();
  });

  it("refuses to sign against an already closed intent", async () => {
    findVideoUploadIntent.mockResolvedValue({ ...pendingIntent, state: "COMPLETED" });

    await expect(sign()).resolves.toEqual({ reason: "INTENT_NOT_PENDING", signed: false });
  });
});

describe("completeVideoUpload", () => {
  const parts = [
    { etag: "etag-1", partNumber: 1 },
    { etag: "etag-2", partNumber: 2 },
  ];

  function complete(request: Record<string, unknown> = {}) {
    return completeVideoUpload({
      actor,
      correlationId,
      intentId,
      now,
      request: { parts, ...request } as never,
    });
  }

  it("publishes a pending-validation asset and queues validation once", async () => {
    await expect(complete()).resolves.toEqual({
      alreadyCompleted: false,
      assetId,
      bytes: 10_000_000,
      completed: true,
    });

    expect(createVideoAsset).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ bytes: 10_000_000, etag: "composite-etag-2" }),
    );
    expect(enqueueBackgroundJob).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        idempotencyKey: `asset-validate-${assetId}`,
        queueName: "asset.validate",
      }),
    );
  });

  it("stores server-observed bytes, not what the browser declared", async () => {
    completeMultipartUpload.mockResolvedValue({
      bytes: 10_000_000,
      contentType: "video/quicktime",
      etag: "e",
      objectVersion: null,
    });

    await complete();

    const [, , input] = createVideoAsset.mock.calls[0] as [
      unknown,
      unknown,
      { contentType: string },
    ];

    expect(input.contentType).toBe("video/quicktime");
  });

  it("refuses and aborts when stored bytes differ from what was admitted", async () => {
    completeMultipartUpload.mockResolvedValue({
      bytes: 999,
      contentType: "video/mp4",
      etag: "e",
      objectVersion: null,
    });

    await expect(complete()).resolves.toEqual({ completed: false, reason: "SIZE_MISMATCH" });
    expect(createVideoAsset).not.toHaveBeenCalled();
    expect(abortMultipartUpload).toHaveBeenCalled();
    expect(closeVideoUploadIntent).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ state: "ABORTED" }),
    );
  });

  it("refuses a resumed upload that lists the same part twice", async () => {
    await expect(
      complete({
        parts: [
          { etag: "first", partNumber: 1 },
          { etag: "second", partNumber: 1 },
        ],
      }),
    ).resolves.toEqual({ completed: false, reason: "DUPLICATE_PART" });
    expect(completeMultipartUpload).not.toHaveBeenCalled();
  });

  it("refuses parts beyond the reserved count", async () => {
    await expect(complete({ parts: [{ etag: "e", partNumber: 9 }] })).resolves.toEqual({
      completed: false,
      reason: "PART_NUMBER_OUT_OF_RANGE",
    });
  });

  it("resolves a replayed completion to the same asset instead of a duplicate", async () => {
    findVideoUploadIntent.mockResolvedValue({ ...pendingIntent, state: "COMPLETED" });
    findVideoAssetForIntent.mockResolvedValue({
      bytes: 10_000_000n,
      id: assetId,
      instagramPostId: postId,
      objectKey,
      state: "PENDING_VALIDATION",
    });

    await expect(complete()).resolves.toEqual({
      alreadyCompleted: true,
      assetId,
      bytes: 10_000_000,
      completed: true,
    });
    expect(createVideoAsset).not.toHaveBeenCalled();
    expect(enqueueBackgroundJob).not.toHaveBeenCalled();
  });

  it("resolves the race where another request closed the intent first", async () => {
    // The intent still read as PENDING, so the conditional close is what loses
    // the race and the asset lookup happens exactly once.
    closeVideoUploadIntent.mockResolvedValue(false);
    findVideoAssetForIntent.mockResolvedValue({
      bytes: 10_000_000n,
      id: assetId,
      instagramPostId: postId,
      objectKey,
      state: "PENDING_VALIDATION",
    });

    await expect(complete()).resolves.toEqual({
      alreadyCompleted: true,
      assetId,
      bytes: 10_000_000,
      completed: true,
    });
    expect(createVideoAsset).not.toHaveBeenCalled();
    expect(findVideoAssetForIntent).toHaveBeenCalledTimes(1);
  });

  it("refuses when the winning request has not yet published its asset", async () => {
    closeVideoUploadIntent.mockResolvedValue(false);
    findVideoAssetForIntent.mockResolvedValue(null);

    await expect(complete()).resolves.toEqual({
      completed: false,
      reason: "INTENT_NOT_PENDING",
    });
    expect(createVideoAsset).not.toHaveBeenCalled();
  });

  it("refuses a crafted intent id", async () => {
    await expect(
      completeVideoUpload({
        actor,
        correlationId,
        intentId: "not-a-uuid",
        now,
        request: { parts } as never,
      }),
    ).resolves.toEqual({ completed: false, reason: "INTENT_NOT_FOUND" });
    expect(completeMultipartUpload).not.toHaveBeenCalled();
  });
});

describe("abortVideoUpload", () => {
  it("releases the provider upload and closes the intent", async () => {
    await expect(abortVideoUpload({ actor, correlationId, intentId })).resolves.toEqual({
      aborted: true,
      alreadyClosed: false,
    });
    expect(abortMultipartUpload).toHaveBeenCalledWith({
      objectKey,
      providerUploadId: "provider-upload-1",
    });
  });

  it("treats an already-closed upload as no change rather than an error", async () => {
    findVideoUploadIntent.mockResolvedValue({ ...pendingIntent, state: "ABORTED" });

    await expect(abortVideoUpload({ actor, correlationId, intentId })).resolves.toEqual({
      aborted: true,
      alreadyClosed: true,
    });
    expect(abortMultipartUpload).not.toHaveBeenCalled();
  });

  it("still closes the intent when the provider abort fails", async () => {
    abortMultipartUpload.mockRejectedValue(new Error("provider down"));

    await expect(abortVideoUpload({ actor, correlationId, intentId })).resolves.toEqual({
      aborted: true,
      alreadyClosed: false,
    });
    expect(closeVideoUploadIntent).toHaveBeenCalled();
  });

  it("refuses a crafted or foreign intent id", async () => {
    await expect(
      abortVideoUpload({ actor, correlationId, intentId: "not-a-uuid" }),
    ).resolves.toEqual({ aborted: false, reason: "INTENT_NOT_FOUND" });

    findVideoUploadIntent.mockResolvedValue(null);

    await expect(abortVideoUpload({ actor, correlationId, intentId })).resolves.toEqual({
      aborted: false,
      reason: "INTENT_NOT_FOUND",
    });
  });
});
