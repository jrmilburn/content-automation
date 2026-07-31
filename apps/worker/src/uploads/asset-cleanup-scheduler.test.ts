import { beforeEach, describe, expect, it, vi } from "vitest";

const workspaceId = "0192f2a0-0000-7000-8000-0000000000ff";
const otherWorkspaceId = "0192f2a0-0000-7000-8000-0000000000ee";
const intentId = "019a0000-0000-7000-8000-000000000501";

const enqueueBackgroundJob = vi.fn();
const listExpiredVideoUploadIntents = vi.fn();

vi.mock("@studio-parallel/db", () => ({
  createWorkspaceContext: (id: string) => ({ workspaceId: id }),
  enqueueBackgroundJob: (...args: unknown[]) => enqueueBackgroundJob(...args),
  listExpiredVideoUploadIntents: (...args: unknown[]) => listExpiredVideoUploadIntents(...args),
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
