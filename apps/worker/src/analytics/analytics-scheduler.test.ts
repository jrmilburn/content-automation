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

const { analyticsRecalculateKey, createAnalyticsScheduler, pooledAnalyticsRecalculateKey } =
  await import("./analytics-scheduler.js");

type EnqueueInput = Readonly<{ idempotencyKey: string; resourceId: string; resourceType: string }>;

/** Only the fields that say what was scheduled, so equality can be exact. */
function enqueuedJobs(): readonly EnqueueInput[] {
  return enqueueBackgroundJob.mock.calls.map((call) => {
    const input = call[2] as EnqueueInput;

    return {
      idempotencyKey: input.idempotencyKey,
      resourceId: input.resourceId,
      resourceType: input.resourceType,
    };
  });
}

function pooledJobs(): readonly EnqueueInput[] {
  return enqueuedJobs().filter((job) => job.resourceType === "workspace");
}

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

    // Two accounts in two workspaces: a per-account job each, and a pooled job
    // for each workspace they belong to.
    await expect(scheduler.sweep()).resolves.toBe(4);
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
    const first = enqueuedJobs();

    const later = createScheduler(() => new Date("2026-08-03T06:20:00.000Z"));
    await later.scheduler.sweep();
    const second = enqueuedJobs().slice(first.length);

    expect(second.map((job) => job.idempotencyKey)).toEqual(first.map((job) => job.idempotencyKey));
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

    await expect(scheduler.sweep()).resolves.toBe(3);
    expect(errorMonitor.captureException).toHaveBeenCalledTimes(1);
  });

  it("schedules a pooled run alongside the account's", async () => {
    // The pooled scope has no marker of its own, so one dirty account is what
    // makes its workspace due.
    listAccountsDueForAnalytics.mockResolvedValue([dueAccount()]);

    const { scheduler } = createScheduler(() => new Date("2026-08-03T06:10:00.000Z"));

    await expect(scheduler.sweep()).resolves.toBe(2);
    expect(pooledJobs()).toEqual([
      {
        idempotencyKey: pooledAnalyticsRecalculateKey(workspaceId, dirtySince),
        resourceId: workspaceId,
        resourceType: "workspace",
      },
    ]);
    expect(enqueueBackgroundJob.mock.calls[1]?.[1]).toEqual({ workspaceId });
  });

  it("names the pooled job in the form the job store accepts", async () => {
    // The enqueue is mocked here, so a key or a resource type the store would
    // reject has nothing else to catch it before production.
    listAccountsDueForAnalytics.mockResolvedValue([dueAccount()]);

    const { scheduler } = createScheduler(() => new Date("2026-08-03T06:10:00.000Z"));
    await scheduler.sweep();
    const [pooled] = pooledJobs();

    expect(pooled?.idempotencyKey).toMatch(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$/u);
    expect(pooled?.resourceType).toMatch(/^[a-z][a-z0-9_]{0,63}$/u);
  });

  it("collapses a workspace's dirty accounts onto one pooled run", async () => {
    // Two accounts, two per-account runs, one pooled run. A pooled run per dirty
    // account would recalculate the same workspace-wide set twice.
    const later = new Date("2026-08-03T06:04:00.000Z");
    listAccountsDueForAnalytics.mockResolvedValue([
      dueAccount(),
      dueAccount({ dirtySince: later, instagramAccountId: otherAccountId }),
    ]);

    const { scheduler } = createScheduler(() => new Date("2026-08-03T06:10:00.000Z"));

    await expect(scheduler.sweep()).resolves.toBe(3);
    expect(pooledJobs()).toEqual([
      {
        // The newest anchor of the two, so that the later account's changes are
        // not published under a key the earlier one already consumed.
        idempotencyKey: pooledAnalyticsRecalculateKey(workspaceId, later),
        resourceId: workspaceId,
        resourceType: "workspace",
      },
    ]);
  });

  it("leaves per-account scheduling untouched by the pooled run", async () => {
    listAccountsDueForAnalytics.mockResolvedValue([
      dueAccount(),
      dueAccount({ instagramAccountId: otherAccountId }),
    ]);

    const { scheduler } = createScheduler(() => new Date("2026-08-03T06:10:00.000Z"));
    await scheduler.sweep();

    expect(enqueuedJobs().filter((job) => job.resourceType === "instagram_account")).toEqual([
      {
        idempotencyKey: analyticsRecalculateKey(accountId, dirtySince),
        resourceId: accountId,
        resourceType: "instagram_account",
      },
      {
        idempotencyKey: analyticsRecalculateKey(otherAccountId, dirtySince),
        resourceId: otherAccountId,
        resourceType: "instagram_account",
      },
    ]);
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
