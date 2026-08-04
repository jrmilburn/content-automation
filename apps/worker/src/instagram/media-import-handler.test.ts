import { queueDefinitions } from "@studio-parallel/domain";
import type * as MediaDownload from "./media-download.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The import handler's decisions, driven directly.
 *
 * `runIdempotentJobHandler` is stood in for so the handler body can be run
 * without a database. What is being tested is the order of its refusals and,
 * above all, that a redelivered job does not download the video a second time —
 * the failure mode #166 warns about, where a slow handler is redelivered and
 * repeats its external side effects.
 */

type MediaDownloadModule = typeof MediaDownload;

const workspaceId = "0192f2a0-0000-7000-8000-0000000000ff";
const jobId = "019a0000-0000-7000-8000-0000000000aa";
const postId = "019a0000-0000-7000-8000-000000000401";
const assetId = "019a0000-0000-7000-8000-000000000501";

const backgroundJobFindFirst = vi.fn();
const instagramPostFindFirst = vi.fn();
const findVideoAssetForImportJob = vi.fn();
const createImportedVideoAsset = vi.fn();
const enqueueBackgroundJobInTransaction = vi.fn();
const findActive = vi.fn();
const decryptCredential = vi.fn();

const recordStage = vi.fn();
const heartbeat = vi.fn();

let committed = false;

vi.mock("@studio-parallel/db", () => ({
  createImportedVideoAsset: (...args: unknown[]) => createImportedVideoAsset(...args),
  createWorkspaceContext: (id: string) => ({ workspaceId: id }),
  createWorkspaceRepositories: () => ({
    credentials: { findActive: (...args: unknown[]) => findActive(...args) },
  }),
  decryptCredential: (...args: unknown[]) => decryptCredential(...args),
  enqueueBackgroundJobInTransaction: (...args: unknown[]) =>
    enqueueBackgroundJobInTransaction(...args),
  findVideoAssetForImportJob: (...args: unknown[]) => findVideoAssetForImportJob(...args),
  instagramPostResourceType: "instagram_post",
  runIdempotentJobHandler: async (input: {
    execute: (execution: unknown) => Promise<{ commit: (transaction: unknown) => Promise<void> }>;
  }) => {
    const result = await input.execute({
      heartbeat,
      jobId,
      recordStage,
    });
    committed = true;
    await result.commit({});
  },
  videoAssetResourceType: "video_asset",
}));

const fetchInstagramMediaItem = vi.fn();
const openInstagramMediaDownload = vi.fn();

vi.mock("./media-client.js", () => ({
  fetchInstagramMediaItem: (...args: unknown[]) => fetchInstagramMediaItem(...args),
  InstagramMediaError: class extends Error {
    readonly responseClass = "transient";
    readonly reasonCode = "MEDIA_ITEM_REJECTED";
  },
}));

const { createInstagramMediaImportHandler, instagramMediaImportQueue } =
  await import("./media-import-handler.js");
const { InstagramMediaDownloadError } = await import("./media-download.js");

vi.mock("./media-download.js", async (importOriginal) => {
  const actual = await importOriginal<MediaDownloadModule>();
  return {
    ...actual,
    openInstagramMediaDownload: (...args: unknown[]) => openInstagramMediaDownload(...args),
  };
});

const putObjectStream = vi.fn();
const logger = { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() };

function streamOf(bytes: number): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(bytes));
      controller.close();
    },
  });
}

function handler() {
  return createInstagramMediaImportHandler({
    database: {
      backgroundJob: { findFirst: (...args: unknown[]) => backgroundJobFindFirst(...args) },
      instagramPost: { findFirst: (...args: unknown[]) => instagramPostFindFirst(...args) },
    } as never,
    environment: "test",
    loadMasterKeys: () => new Map(),
    logger: logger as never,
    storage: { putObjectStream } as never,
    storageConfig: {
      STORAGE_BUCKET: "test-bucket",
      STORAGE_REGION: "auto",
      UPLOAD_MAX_BYTES: 1_000,
    } as never,
  }).handler;
}

function run() {
  return handler()(
    {
      correlationId: "0192f2a0-0000-7000-8000-00000000abcd",
      domainJobId: jobId,
      handlerVersion: 1,
      queueName: "instagram.media.import",
      workspaceId,
    },
    { attempt: 1, signal: AbortSignal.timeout(10_000) },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  committed = false;
  backgroundJobFindFirst.mockResolvedValue({ resourceId: postId, resourceType: "instagram_post" });
  findVideoAssetForImportJob.mockResolvedValue(null);
  instagramPostFindFirst.mockResolvedValue({
    id: postId,
    instagramAccountId: "019a0000-0000-7000-8000-000000000301",
    mediaKind: "REEL",
    providerMediaId: "17900000000000001",
  });
  findActive.mockResolvedValue({ ciphertext: "sealed.envelope", keyVersion: 1 });
  decryptCredential.mockReturnValue("IGAAtoken");
  fetchInstagramMediaItem.mockResolvedValue({
    mediaProductType: "REELS",
    mediaType: "VIDEO",
    mediaUrl: "https://scontent.cdninstagram.com/v/reel.mp4?oe=SIG",
    usage: [],
  });
  // A fresh stream per call: a body can only be read once, so reusing one would
  // make the second attempt fail for a reason the handler is not responsible
  // for.
  openInstagramMediaDownload.mockImplementation(() =>
    Promise.resolve({ body: streamOf(120), contentType: "video/mp4", declaredBytes: 120 }),
  );
  putObjectStream.mockResolvedValue({
    bytes: 120,
    contentType: "video/mp4",
    etag: "abc123",
    objectVersion: null,
  });
  createImportedVideoAsset.mockResolvedValue({ id: assetId });
  enqueueBackgroundJobInTransaction.mockResolvedValue(undefined);
});

describe("instagramMediaImportQueue", () => {
  it("matches a declared queue definition", () => {
    expect(queueDefinitions).toContainEqual({
      name: instagramMediaImportQueue.name,
      version: instagramMediaImportQueue.version,
    });
  });
});

describe("importing one post's video", () => {
  it("stores the file and hands it to the ordinary validation job", async () => {
    await run();

    expect(putObjectStream).toHaveBeenCalledOnce();
    expect(createImportedVideoAsset).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ bytes: 120, importJobId: jobId, instagramPostId: postId }),
    );

    // Bytes from the provider get no more trust than bytes from a browser.
    expect(enqueueBackgroundJobInTransaction).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ queueName: "asset.validate", resourceId: assetId }),
    );
  });

  it("writes to a key derived from the job, so a retry cannot orphan bytes", async () => {
    await run();
    const [first] = putObjectStream.mock.calls[0] as [{ objectKey: string }];

    // Only the recorded calls are cleared: this is the same job being retried,
    // so everything it reads must still answer the same way.
    putObjectStream.mockClear();
    await run();
    const [second] = putObjectStream.mock.calls[0] as [{ objectKey: string }];

    expect(second.objectKey).toBe(first.objectKey);
    expect(first.objectKey).toMatch(/^test\/[0-9a-f-]+\/source-video\/[0-9a-f]{32}$/u);
  });

  it("does not download again when this job already produced an asset", async () => {
    findVideoAssetForImportJob.mockResolvedValue({ id: assetId });

    await run();

    // The whole point of the unique anchor: a redelivery must not repeat the
    // transfer or write a second object.
    expect(fetchInstagramMediaItem).not.toHaveBeenCalled();
    expect(openInstagramMediaDownload).not.toHaveBeenCalled();
    expect(putObjectStream).not.toHaveBeenCalled();
    expect(createImportedVideoAsset).not.toHaveBeenCalled();
  });

  it("refuses a post that is not a video before touching the provider", async () => {
    instagramPostFindFirst.mockResolvedValue({
      id: postId,
      instagramAccountId: "019a0000-0000-7000-8000-000000000301",
      mediaKind: "IMAGE",
      providerMediaId: "17900000000000001",
    });

    await expect(run()).rejects.toMatchObject({
      failure: { errorCode: "MEDIA_IMPORT_NOT_A_VIDEO" },
    });
    expect(fetchInstagramMediaItem).not.toHaveBeenCalled();
  });

  it("refuses a media node that carries no URL, without retrying for ever", async () => {
    fetchInstagramMediaItem.mockResolvedValue({
      mediaProductType: "REELS",
      mediaType: "VIDEO",
      mediaUrl: null,
      usage: [],
    });

    await expect(run()).rejects.toMatchObject({
      failure: { errorClass: "INVALID_INPUT", errorCode: "MEDIA_IMPORT_URL_ABSENT" },
    });
    expect(putObjectStream).not.toHaveBeenCalled();
  });

  it("refuses a response larger than the ceiling before storing a byte", async () => {
    openInstagramMediaDownload.mockResolvedValue({
      body: streamOf(10),
      contentType: "video/mp4",
      declaredBytes: 5_000,
    });

    await expect(run()).rejects.toMatchObject({ failure: { errorCode: "MEDIA_IMPORT_TOO_LARGE" } });
    expect(putObjectStream).not.toHaveBeenCalled();
    expect(createImportedVideoAsset).not.toHaveBeenCalled();
  });

  it("keeps a refused host terminal rather than retrying it", async () => {
    openInstagramMediaDownload.mockRejectedValue(
      new InstagramMediaDownloadError("MEDIA_URL_NOT_ALLOWED", false),
    );

    await expect(run()).rejects.toMatchObject({
      failure: { errorClass: "INVALID_INPUT", errorCode: "MEDIA_IMPORT_MEDIA_URL_NOT_ALLOWED" },
    });
  });

  it("keeps a failed transfer retryable, and creates no asset for it", async () => {
    openInstagramMediaDownload.mockRejectedValue(
      new InstagramMediaDownloadError("MEDIA_DOWNLOAD_FAILED", true),
    );

    await expect(run()).rejects.toMatchObject({ failure: { errorClass: "TRANSIENT" } });
    expect(createImportedVideoAsset).not.toHaveBeenCalled();
    expect(committed).toBe(false);
  });

  it("does nothing for a job that carries no post", async () => {
    backgroundJobFindFirst.mockResolvedValue({ resourceId: null, resourceType: "instagram_post" });

    await run();

    expect(fetchInstagramMediaItem).not.toHaveBeenCalled();
    expect(createImportedVideoAsset).not.toHaveBeenCalled();
  });
});
