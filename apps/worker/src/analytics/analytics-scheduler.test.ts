import { beforeEach, describe, expect, it, vi } from "vitest";

const workspaceId = "0192f2a0-0000-7000-8000-0000000000ff";
const otherWorkspaceId = "0192f2a0-0000-7000-8000-0000000000ee";
const accountId = "019a0000-0000-7000-8000-000000000701";
const otherAccountId = "019a0000-0000-7000-8000-000000000702";

const enqueueBackgroundJob = vi.fn();
const listAccountsDueForAnalytics = vi.fn();

vi.mock("@studio-parallel/db", () => ({
  createWorkspaceContext: (id: string) => ({ workspaceId: id }),
  enqueueBackgroundJob: (...args: unknown[]) => enqueueBackgroundJob(...args),
  listAccountsDueForAnalytics: (...args: unknown[]) => listAccountsDueForAnalytics(...args),
}));

const { analyticsRecalculateKey, createAnalyticsScheduler } =
  await import("./analytics-scheduler.js");

const dirtySince = new Date("2026-08-03T06:00:00.000Z");

function dueAccount(overrides: Record<string, unknown> = {}) {
  return { dirtySince, instagramAccountId: accountId, workspaceId, ...overrides };
}

function createScheduler(now: () => Date) {
  const logger = { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() };
  const errorMonitor = { captureException: vi.fn() };
  const scheduler = createAnalyticsScheduler({
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
  listAccountsDueForAnalytics.mockResolvedValue([]);
  enqueueBackgroundJob.mockResolvedValue({ created: true });
});

describe("createAnalyticsScheduler", () => {
  it("enqueues one recalculation per due account", async () => {
    listAccountsDueForAnalytics.mockResolvedValue([
      dueAccount(),
      dueAccount({ instagramAccountId: otherAccountId, workspaceId: otherWorkspaceId }),
    ]);

    const { scheduler } = createScheduler(() => new Date("2026-08-03T06:10:00.000Z"));

    await expect(scheduler.sweep()).resolves.toBe(2);
    expect(enqueueBackgroundJob).toHaveBeenCalledTimes(2);
    expect(enqueueBackgroundJob.mock.calls[0]?.[1]).toEqual({ workspaceId });
    expect(enqueueBackgroundJob.mock.calls[0]?.[2]).toMatchObject({
      queueName: "analytics.recalculate",
      resourceId: accountId,
      resourceType: "instagram_account",
    });
  });

  it("keys on the change rather than the sweep", async () => {
    // Two sweeps over the same unprocessed change must collapse. Keying on the
    // sweep time would enqueue a fresh job every interval until the first ran.
    listAccountsDueForAnalytics.mockResolvedValue([dueAccount()]);

    const { scheduler } = createScheduler(() => new Date("2026-08-03T06:10:00.000Z"));
    await scheduler.sweep();
    const first = enqueueBackgroundJob.mock.calls[0]?.[2] as { idempotencyKey: string };

    const later = createScheduler(() => new Date("2026-08-03T06:20:00.000Z"));
    await later.scheduler.sweep();
    const second = enqueueBackgroundJob.mock.calls[1]?.[2] as { idempotencyKey: string };

    expect(second.idempotencyKey).toBe(first.idempotencyKey);
  });

  it("earns a new job when a later change moves the anchor", async () => {
    listAccountsDueForAnalytics.mockResolvedValue([
      dueAccount({ dirtySince: new Date("2026-08-03T07:00:00.000Z") }),
    ]);

    const { scheduler } = createScheduler(() => new Date("2026-08-03T07:10:00.000Z"));
    await scheduler.sweep();

    expect(
      (enqueueBackgroundJob.mock.calls[0]?.[2] as { idempotencyKey: string }).idempotencyKey,
    ).toBe(analyticsRecalculateKey(accountId, new Date("2026-08-03T07:00:00.000Z")));
  });

  it("counts only jobs it actually created", async () => {
    listAccountsDueForAnalytics.mockResolvedValue([dueAccount()]);
    enqueueBackgroundJob.mockResolvedValue({ created: false });

    const { scheduler } = createScheduler(() => new Date("2026-08-03T06:10:00.000Z"));

    await expect(scheduler.sweep()).resolves.toBe(0);
  });

  it("finishes the sweep when one account fails", async () => {
    // One workspace's problem must not stop the rest. A sweep that aborted on
    // the first failure would starve every account behind it.
    listAccountsDueForAnalytics.mockResolvedValue([
      dueAccount(),
      dueAccount({ instagramAccountId: otherAccountId, workspaceId: otherWorkspaceId }),
    ]);
    enqueueBackgroundJob
      .mockRejectedValueOnce(new Error("enqueue failed"))
      .mockResolvedValue({ created: true });

    const { errorMonitor, scheduler } = createScheduler(() => new Date("2026-08-03T06:10:00.000Z"));

    await expect(scheduler.sweep()).resolves.toBe(1);
    expect(errorMonitor.captureException).toHaveBeenCalledTimes(1);
  });

  it("does not overlap sweeps", async () => {
    let release: (() => void) | undefined;
    listAccountsDueForAnalytics.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve([]);
        }),
    );

    const { scheduler } = createScheduler(() => new Date("2026-08-03T06:10:00.000Z"));
    scheduler.start();
    scheduler.start();

    // A slow sweep would otherwise stack behind itself and re-read the same
    // due accounts.
    expect(listAccountsDueForAnalytics).toHaveBeenCalledTimes(1);

    release?.();
    await scheduler.stop();
  });
});
