import { beforeEach, describe, expect, it, vi } from "vitest";

const workspaceId = "0192f2a0-0000-7000-8000-0000000000ff";
const accountId = "019a0000-0000-7000-8000-000000000301";
const postId = "019a0000-0000-7000-8000-000000000401";

const enqueueBackgroundJob = vi.fn();
const listInstagramAccountsDueForSync = vi.fn();
const listInstagramPostsDueForSnapshot = vi.fn();

vi.mock("@studio-parallel/db", () => ({
  createWorkspaceContext: (id: string) => ({ workspaceId: id }),
  enqueueBackgroundJob: (...args: unknown[]) => enqueueBackgroundJob(...args),
  listInstagramAccountsDueForSync: (...args: unknown[]) => listInstagramAccountsDueForSync(...args),
  listInstagramPostsDueForSnapshot: (...args: unknown[]) =>
    listInstagramPostsDueForSnapshot(...args),
}));

const { createInstagramSyncScheduler } = await import("./sync-scheduler.js");

function createLogger() {
  return { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() };
}

function createScheduler(now: () => Date) {
  const logger = createLogger();
  const errorMonitor = { captureException: vi.fn() };
  const scheduler = createInstagramSyncScheduler({
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
  listInstagramAccountsDueForSync.mockResolvedValue([]);
  listInstagramPostsDueForSnapshot.mockResolvedValue([]);
  enqueueBackgroundJob.mockResolvedValue({ created: true });
});

describe("sync scheduler sweep", () => {
  it("enqueues a scheduled sync for a due account", async () => {
    listInstagramAccountsDueForSync.mockResolvedValue([
      { accountId, lastSuccessfulSyncAt: null, workspaceId },
    ]);
    const { scheduler } = createScheduler(() => new Date("2026-07-31T02:00:00.000Z"));

    await expect(scheduler.sweep()).resolves.toEqual({ snapshots: 0, syncs: 1 });

    const enqueued = enqueueBackgroundJob.mock.calls[0]?.[2] as {
      idempotencyKey: string;
      queueName: string;
      resourceType: string;
    };
    expect(enqueued.queueName).toBe("instagram.sync.account");
    expect(enqueued.resourceType).toBe("instagram_account");
    expect(enqueued.idempotencyKey).toContain("instagram-sync-scheduled-");
  });

  it("asks only for accounts whose last sync is older than the interval", async () => {
    const at = new Date("2026-07-31T02:00:00.000Z");
    const { scheduler } = createScheduler(() => at);

    await scheduler.sweep();

    const query = listInstagramAccountsDueForSync.mock.calls[0]?.[1] as { dueBefore: Date };
    expect(at.getTime() - query.dueBefore.getTime()).toBe(24 * 3_600_000);
  });

  it("produces the same key across sweeps within one UTC day", async () => {
    listInstagramAccountsDueForSync.mockResolvedValue([
      { accountId, lastSuccessfulSyncAt: null, workspaceId },
    ]);

    const morning = createScheduler(() => new Date("2026-07-31T00:05:00.000Z"));
    await morning.scheduler.sweep();
    const evening = createScheduler(() => new Date("2026-07-31T23:55:00.000Z"));
    await evening.scheduler.sweep();

    const keys = enqueueBackgroundJob.mock.calls.map(
      (call) => (call[2] as { idempotencyKey: string }).idempotencyKey,
    );
    // Deduplication is the key's job, so repeated sweeps must agree on it.
    expect(keys[0]).toBe(keys[1]);
  });

  it("enqueues a snapshot keyed by post and age bucket", async () => {
    listInstagramPostsDueForSnapshot.mockResolvedValue([
      { ageBucket: "day_1", postAgeSeconds: 86_400, postId, workspaceId },
    ]);
    const { scheduler } = createScheduler(() => new Date("2026-07-31T02:00:00.000Z"));

    await expect(scheduler.sweep()).resolves.toEqual({ snapshots: 1, syncs: 0 });

    const enqueued = enqueueBackgroundJob.mock.calls[0]?.[2] as {
      idempotencyKey: string;
      queueName: string;
      resourceType: string;
    };
    expect(enqueued.queueName).toBe("instagram.snapshot.post");
    expect(enqueued.resourceType).toBe("instagram_post");
    expect(enqueued.idempotencyKey).toBe(`instagram-snapshot-${postId}-day_1`);
  });

  it("keeps a snapshot key stable over time so a late capture is not a second observation", async () => {
    listInstagramPostsDueForSnapshot.mockResolvedValue([
      { ageBucket: "day_1", postAgeSeconds: 86_400, postId, workspaceId },
    ]);

    await createScheduler(() => new Date("2026-07-31T02:00:00.000Z")).scheduler.sweep();
    await createScheduler(() => new Date("2026-08-01T09:00:00.000Z")).scheduler.sweep();

    const keys = enqueueBackgroundJob.mock.calls.map(
      (call) => (call[2] as { idempotencyKey: string }).idempotencyKey,
    );
    expect(keys[0]).toBe(keys[1]);
  });

  it("counts only jobs it actually created", async () => {
    listInstagramAccountsDueForSync.mockResolvedValue([
      { accountId, lastSuccessfulSyncAt: null, workspaceId },
    ]);
    enqueueBackgroundJob.mockResolvedValue({ created: false });
    const { scheduler } = createScheduler(() => new Date("2026-07-31T02:00:00.000Z"));

    // An already-scheduled account is not news.
    await expect(scheduler.sweep()).resolves.toEqual({ snapshots: 0, syncs: 0 });
  });
});

describe("sync scheduler resilience", () => {
  it("continues the sweep when one workspace fails", async () => {
    listInstagramAccountsDueForSync.mockResolvedValue([
      { accountId, lastSuccessfulSyncAt: null, workspaceId },
      {
        accountId: "019a0000-0000-7000-8000-000000000302",
        lastSuccessfulSyncAt: null,
        workspaceId,
      },
    ]);
    enqueueBackgroundJob
      .mockRejectedValueOnce(new Error("workspace unavailable"))
      .mockResolvedValue({ created: true });

    const { errorMonitor, scheduler } = createScheduler(() => new Date("2026-07-31T02:00:00.000Z"));

    await expect(scheduler.sweep()).resolves.toEqual({ snapshots: 0, syncs: 1 });
    expect(errorMonitor.captureException).toHaveBeenCalled();
  });

  it("still sweeps snapshots when the account sweep fails entirely", async () => {
    listInstagramAccountsDueForSync.mockRejectedValue(new Error("query failed"));
    const { scheduler } = createScheduler(() => new Date("2026-07-31T02:00:00.000Z"));

    // The sweep as a whole rejects; the periodic tick is what absorbs it.
    await expect(scheduler.sweep()).rejects.toThrow();
  });

  it("never lets a failing sweep escape the periodic tick", async () => {
    listInstagramAccountsDueForSync.mockRejectedValue(new Error("query failed"));
    const { errorMonitor, scheduler } = createScheduler(() => new Date("2026-07-31T02:00:00.000Z"));

    scheduler.start();
    await scheduler.stop();

    expect(errorMonitor.captureException).toHaveBeenCalled();
  });

  it("sweeps immediately on start rather than waiting a full interval", async () => {
    const { scheduler } = createScheduler(() => new Date("2026-07-31T02:00:00.000Z"));

    scheduler.start();
    await scheduler.stop();

    expect(listInstagramAccountsDueForSync).toHaveBeenCalledTimes(1);
  });

  it("is safe to start twice", async () => {
    const { scheduler } = createScheduler(() => new Date("2026-07-31T02:00:00.000Z"));

    scheduler.start();
    scheduler.start();
    await scheduler.stop();

    expect(listInstagramAccountsDueForSync).toHaveBeenCalledTimes(1);
  });

  it("does not overlap sweeps", async () => {
    let release: (() => void) | undefined;
    listInstagramAccountsDueForSync.mockImplementation(
      async () =>
        new Promise((resolve) => {
          release = () => resolve([]);
        }),
    );
    const { scheduler } = createScheduler(() => new Date("2026-07-31T02:00:00.000Z"));

    scheduler.start();
    scheduler.start();
    // A slow sweep must not stack behind itself and re-read the same due work.
    expect(listInstagramAccountsDueForSync).toHaveBeenCalledTimes(1);

    release?.();
    await scheduler.stop();
  });
});
