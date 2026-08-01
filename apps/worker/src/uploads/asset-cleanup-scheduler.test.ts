import { beforeEach, describe, expect, it, vi } from "vitest";

const workspaceId = "0192f2a0-0000-7000-8000-0000000000ff";
const otherWorkspaceId = "0192f2a0-0000-7000-8000-0000000000ee";
const intentId = "019a0000-0000-7000-8000-000000000501";

const assetId = "019a0000-0000-7000-8000-000000000601";

const enqueueBackgroundJob = vi.fn();
const listExpiredVideoUploadIntents = vi.fn();
const listPurgeableVideoAssets = vi.fn();

vi.mock("@studio-parallel/db", () => ({
  createWorkspaceContext: (id: string) => ({ workspaceId: id }),
  enqueueBackgroundJob: (...args: unknown[]) => enqueueBackgroundJob(...args),
  listExpiredVideoUploadIntents: (...args: unknown[]) => listExpiredVideoUploadIntents(...args),
  listPurgeableVideoAssets: (...args: unknown[]) => listPurgeableVideoAssets(...args),
  videoAssetResourceType: "video_asset",
  videoUploadIntentResourceType: "video_upload_intent",
}));

const { createAssetCleanupScheduler } = await import("./asset-cleanup-scheduler.js");

function expiredIntent(overrides: Record<string, unknown> = {}) {
  return {
    id: intentId,
    objectKey: "test/ws/source-video/abc",
    providerUploadId: "provider-upload-1",
    workspaceId,
    ...overrides,
  };
}

function createScheduler(now: () => Date) {
  const logger = { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() };
  const errorMonitor = { captureException: vi.fn() };
  const scheduler = createAssetCleanupScheduler({
    batchSize: 20,
    database: {} as never,
    errorMonitor: errorMonitor as never,
    intervalMs: 60_000,
    logger: logger as never,
    now,
  });

  return { errorMonitor, logger, scheduler };
}

beforeEach(() => {
  vi.clearAllMocks();
  listExpiredVideoUploadIntents.mockResolvedValue([]);
  listPurgeableVideoAssets.mockResolvedValue([]);
  enqueueBackgroundJob.mockResolvedValue({ created: true });
});

describe("asset cleanup sweep", () => {
  it("enqueues cleanup for an expired intent in its own workspace", async () => {
    listExpiredVideoUploadIntents.mockResolvedValue([expiredIntent()]);
    const { scheduler } = createScheduler(() => new Date("2026-08-02T03:00:00.000Z"));

    await expect(scheduler.sweep()).resolves.toBe(1);

    const [, context, input] = enqueueBackgroundJob.mock.calls[0] as [
      unknown,
      { workspaceId: string },
      { idempotencyKey: string; queueName: string; resourceId: string; resourceType: string },
    ];

    expect(context.workspaceId).toBe(workspaceId);
    expect(input.queueName).toBe("asset.cleanup");
    expect(input.resourceId).toBe(intentId);
    expect(input.resourceType).toBe("video_upload_intent");
  });

  it("asks only for intents whose window has already closed", async () => {
    const at = new Date("2026-08-02T03:00:00.000Z");
    const { scheduler } = createScheduler(() => at);

    await scheduler.sweep();

    expect(listExpiredVideoUploadIntents).toHaveBeenCalledWith(expect.anything(), {
      expiredBefore: at,
      limit: 20,
    });
  });

  it("produces the same key for repeated sweeps on the same day", async () => {
    listExpiredVideoUploadIntents.mockResolvedValue([expiredIntent()]);

    const morning = createScheduler(() => new Date("2026-08-02T01:00:00.000Z"));
    await morning.scheduler.sweep();
    const evening = createScheduler(() => new Date("2026-08-02T23:00:00.000Z"));
    await evening.scheduler.sweep();

    const keys = enqueueBackgroundJob.mock.calls.map(
      (call) => (call[2] as { idempotencyKey: string }).idempotencyKey,
    );

    expect(keys[0]).toBe(keys[1]);
    expect(keys[0]).toBe(`asset-cleanup-${intentId}-2026-08-02`);
  });

  it("produces a new key the next day so a failed release is retried", async () => {
    listExpiredVideoUploadIntents.mockResolvedValue([expiredIntent()]);

    await createScheduler(() => new Date("2026-08-02T23:00:00.000Z")).scheduler.sweep();
    await createScheduler(() => new Date("2026-08-03T00:30:00.000Z")).scheduler.sweep();

    const keys = enqueueBackgroundJob.mock.calls.map(
      (call) => (call[2] as { idempotencyKey: string }).idempotencyKey,
    );

    expect(keys[0]).not.toBe(keys[1]);
  });

  it("counts only jobs the queue actually created", async () => {
    listExpiredVideoUploadIntents.mockResolvedValue([
      expiredIntent(),
      expiredIntent({ id: "019a0000-0000-7000-8000-000000000502" }),
    ]);
    enqueueBackgroundJob.mockResolvedValueOnce({ created: true });
    enqueueBackgroundJob.mockResolvedValueOnce({ created: false });

    const { scheduler } = createScheduler(() => new Date("2026-08-02T03:00:00.000Z"));

    await expect(scheduler.sweep()).resolves.toBe(1);
  });

  it("keeps sweeping other workspaces when one enqueue fails", async () => {
    listExpiredVideoUploadIntents.mockResolvedValue([
      expiredIntent(),
      expiredIntent({ id: "019a0000-0000-7000-8000-000000000502", workspaceId: otherWorkspaceId }),
    ]);
    enqueueBackgroundJob.mockRejectedValueOnce(new Error("workspace one is broken"));

    const { errorMonitor, scheduler } = createScheduler(() => new Date("2026-08-02T03:00:00.000Z"));

    await expect(scheduler.sweep()).resolves.toBe(1);
    expect(errorMonitor.captureException).toHaveBeenCalledTimes(1);
    expect(enqueueBackgroundJob).toHaveBeenCalledTimes(2);
  });

  it("stays silent when nothing is due", async () => {
    const { logger, scheduler } = createScheduler(() => new Date("2026-08-02T03:00:00.000Z"));

    await expect(scheduler.sweep()).resolves.toBe(0);
    expect(logger.info).not.toHaveBeenCalled();
  });
});

describe("rejected asset purge sweep", () => {
  it("enqueues a purge addressed to the asset rather than an intent", async () => {
    listPurgeableVideoAssets.mockResolvedValue([
      { id: assetId, objectKey: "test/ws/source-video/def", workspaceId },
    ]);

    const { scheduler } = createScheduler(() => new Date("2026-08-02T03:00:00.000Z"));

    await expect(scheduler.sweep()).resolves.toBe(1);

    const [, context, input] = enqueueBackgroundJob.mock.calls[0] as [
      unknown,
      { workspaceId: string },
      { idempotencyKey: string; resourceId: string; resourceType: string },
    ];

    expect(context.workspaceId).toBe(workspaceId);
    expect(input.resourceId).toBe(assetId);
    expect(input.resourceType).toBe("video_asset");
    expect(input.idempotencyKey).toBe(`asset-purge-${assetId}-2026-08-02`);
  });

  it("asks only for objects whose retention window has already passed", async () => {
    const { scheduler } = createScheduler(() => new Date("2026-08-02T03:00:00.000Z"));

    await scheduler.sweep();

    const [, input] = listPurgeableVideoAssets.mock.calls[0] as [
      unknown,
      { dueBefore: Date; limit: number },
    ];

    expect(input.dueBefore).toEqual(new Date("2026-08-02T03:00:00.000Z"));
    expect(input.limit).toBe(20);
  });

  it("cannot collide with an intent cleanup key for the same identifier", async () => {
    // Both sweeps share one queue, so two resources that happen to carry the
    // same identifier must still produce distinct idempotency keys.
    const at = new Date("2026-08-02T03:00:00.000Z");
    listExpiredVideoUploadIntents.mockResolvedValue([expiredIntent({ id: assetId })]);
    listPurgeableVideoAssets.mockResolvedValue([
      { id: assetId, objectKey: "test/ws/source-video/def", workspaceId },
    ]);

    const { scheduler } = createScheduler(() => at);

    await expect(scheduler.sweep()).resolves.toBe(2);

    const keys = enqueueBackgroundJob.mock.calls.map(
      (call) => (call[2] as { idempotencyKey: string }).idempotencyKey,
    );

    expect(new Set(keys).size).toBe(2);
  });

  it("counts intents and purges together but reports them separately", async () => {
    listExpiredVideoUploadIntents.mockResolvedValue([expiredIntent()]);
    listPurgeableVideoAssets.mockResolvedValue([
      { id: assetId, objectKey: "test/ws/source-video/def", workspaceId },
    ]);

    const { logger, scheduler } = createScheduler(() => new Date("2026-08-02T03:00:00.000Z"));

    await expect(scheduler.sweep()).resolves.toBe(2);

    // A purge backlog hidden inside the intent count would be invisible in
    // operations, so the two are logged under their own events.
    const events = logger.info.mock.calls.map((call) => call[0] as string);

    expect(events).toContain("video.upload.cleanup_scheduled");
    expect(events).toContain("video.asset.purge_scheduled");
  });

  it("keeps sweeping intents when a purge enqueue fails", async () => {
    listExpiredVideoUploadIntents.mockResolvedValue([expiredIntent()]);
    listPurgeableVideoAssets.mockResolvedValue([
      { id: assetId, objectKey: "test/ws/source-video/def", workspaceId },
    ]);
    enqueueBackgroundJob
      .mockResolvedValueOnce({ created: true })
      .mockRejectedValueOnce(new Error("queue unavailable"));

    const { errorMonitor, scheduler } = createScheduler(() => new Date("2026-08-02T03:00:00.000Z"));

    await expect(scheduler.sweep()).resolves.toBe(1);
    expect(errorMonitor.captureException).toHaveBeenCalledTimes(1);
  });
});

describe("asset cleanup scheduler lifecycle", () => {
  it("does not start a second sweep while one is still running", async () => {
    let release: (() => void) | undefined;
    listExpiredVideoUploadIntents.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve([]);
        }),
    );

    const { scheduler } = createScheduler(() => new Date("2026-08-02T03:00:00.000Z"));

    scheduler.start();
    scheduler.start();

    expect(listExpiredVideoUploadIntents).toHaveBeenCalledTimes(1);

    release?.();
    await scheduler.stop();
  });
});
