import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Which scope a recalculation runs for, and when it decides it has nothing to do.
 *
 * The database and `runIdempotentJobHandler` are stood in for so the handler
 * body runs without one. What is being pinned down is the difference between the
 * two scopes' currency tests, because they cannot be the same test: an account
 * asks its debounce marker, and the pooled scope must not, since the per-account
 * runs enqueued by the same sweep clear those markers as they publish. A pooled
 * run that read them would find them clear and skip — every time, forever, with
 * nothing failing to say so.
 */

const workspaceId = "0192f2a0-0000-7000-8000-0000000000ff";
const otherWorkspaceId = "0192f2a0-0000-7000-8000-0000000000ee";
const accountId = "019a0000-0000-7000-8000-000000000701";
const jobId = "019a0000-0000-7000-8000-0000000000aa";
const runId = "019a0000-0000-7000-8000-000000000801";

const backgroundJobFindFirst = vi.fn();
const instagramAccountFindFirst = vi.fn();
const instagramAccountCount = vi.fn();
const findActiveRunFingerprint = vi.fn();
const loadBestAnalyticsInputs = vi.fn();
const startAnalyticsRun = vi.fn();
const storeFeatureStatistics = vi.fn();
const activateAnalyticsRun = vi.fn();
const buildFeatureRequests = vi.fn();
const accountUpdateMany = vi.fn();

vi.mock("@studio-parallel/db", () => ({
  activateAnalyticsRun: (...args: unknown[]) => activateAnalyticsRun(...args),
  buildFeatureRequests: (...args: unknown[]) => buildFeatureRequests(...args),
  calculateFeatureFamily: () => [],
  createRunInputFingerprint: () => "fingerprint-now",
  createWorkspaceContext: (id: string) => ({ workspaceId: id }),
  failAnalyticsRun: vi.fn(),
  findActiveRunFingerprint: (...args: unknown[]) => findActiveRunFingerprint(...args),
  loadBestAnalyticsInputs: (...args: unknown[]) => loadBestAnalyticsInputs(...args),
  runIdempotentJobHandler: async (input: {
    execute: (execution: unknown) => Promise<{ commit: (transaction: unknown) => Promise<void> }>;
  }) => {
    const result = await input.execute({
      heartbeat: vi.fn(),
      jobId,
      recordStage: vi.fn(),
      throwIfCancellationRequested: vi.fn(),
    });

    await result.commit({ instagramAccount: { updateMany: accountUpdateMany } });
  },
  startAnalyticsRun: (...args: unknown[]) => startAnalyticsRun(...args),
  storeFeatureStatistics: (...args: unknown[]) => storeFeatureStatistics(...args),
}));

const { createAnalyticsRecalculateHandler } = await import("./recalculate-handler.js");

const logger = { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() };

function run(resource: Readonly<{ resourceId: string; resourceType: string }>) {
  backgroundJobFindFirst.mockResolvedValue(resource);

  const registration = createAnalyticsRecalculateHandler({
    database: {
      backgroundJob: { findFirst: (...args: unknown[]) => backgroundJobFindFirst(...args) },
      instagramAccount: {
        count: (...args: unknown[]) => instagramAccountCount(...args),
        findFirst: (...args: unknown[]) => instagramAccountFindFirst(...args),
      },
    } as never,
    logger: logger as never,
    now: () => new Date("2026-08-05T00:00:00.000Z"),
  });

  return registration.handler(
    {
      correlationId: "0192f2a0-0000-7000-8000-00000000abcd",
      domainJobId: jobId,
      workspaceId,
    } as never,
    { attempt: 1, signal: new AbortController().signal },
  );
}

/** The reason codes the handler logged, so a skip can be told from a publish. */
function skipReasons(): readonly string[] {
  return logger.info.mock.calls
    .filter((call) => call[0] === "analytics.recalculate.skipped")
    .map((call) => (call[1] as { reasonCode: string }).reasonCode);
}

beforeEach(() => {
  vi.clearAllMocks();

  // Enough of a selection to reach the fingerprint, and no families to store, so
  // every test below turns on the scope decisions rather than on the statistics.
  loadBestAnalyticsInputs.mockResolvedValue({
    ageWindow: "d7",
    considered: [],
    inputs: { analysisIds: ["a"], posts: [{}], snapshotIds: ["s"] },
  });
  buildFeatureRequests.mockReturnValue([]);
  startAnalyticsRun.mockResolvedValue({ id: runId });
  activateAnalyticsRun.mockResolvedValue({ activated: true, supersededRunId: null });
  findActiveRunFingerprint.mockResolvedValue(null);
  instagramAccountCount.mockResolvedValue(2);
});

describe("pooled scope", () => {
  it("runs even though every account's marker has already been cleared", async () => {
    // The ordinary case, not an edge one: the per-account jobs are enqueued
    // first and clear their markers as they publish, so by the time the pooled
    // job runs there is no dirty account left in the workspace.
    instagramAccountFindFirst.mockResolvedValue(null);

    await run({ resourceId: workspaceId, resourceType: "workspace" });

    expect(skipReasons()).toEqual([]);
    expect(startAnalyticsRun).toHaveBeenCalledTimes(1);
  });

  it("names no account on the run it starts, or on the activation", async () => {
    await run({ resourceId: workspaceId, resourceType: "workspace" });

    expect(startAnalyticsRun.mock.calls[0]?.[2]).not.toHaveProperty("instagramAccountId");
    expect(activateAnalyticsRun.mock.calls[0]?.[2]).not.toHaveProperty("instagramAccountId");
  });

  it("passes no dirty marker to activation, having consumed none", async () => {
    await run({ resourceId: workspaceId, resourceType: "workspace" });

    expect(activateAnalyticsRun.mock.calls[0]?.[2]).not.toHaveProperty("dirtySince");
  });

  it("clears no account's marker", async () => {
    await run({ resourceId: workspaceId, resourceType: "workspace" });

    expect(accountUpdateMany).not.toHaveBeenCalled();
  });

  it("skips when it has already published exactly these inputs", async () => {
    findActiveRunFingerprint.mockResolvedValue("fingerprint-now");

    await run({ resourceId: workspaceId, resourceType: "workspace" });

    expect(skipReasons()).toEqual(["ALREADY_CURRENT"]);
    expect(startAnalyticsRun).not.toHaveBeenCalled();
  });

  it("asks the pooled scope's own published run, not an account's", async () => {
    await run({ resourceId: workspaceId, resourceType: "workspace" });

    expect(findActiveRunFingerprint.mock.calls[0]?.[2]).toBeNull();
  });

  it("publishes nothing for a workspace with only one linked account", async () => {
    // Pooling one account yields that account's own calculation with every
    // comparison drawing 100% of both sides from a single source, so the
    // dominance rule would demote all of it — a second, worse scope for the
    // trends screen to default to.
    instagramAccountCount.mockResolvedValue(1);

    await run({ resourceId: workspaceId, resourceType: "workspace" });

    expect(skipReasons()).toEqual(["NOTHING_TO_POOL"]);
    expect(startAnalyticsRun).not.toHaveBeenCalled();
  });

  it("refuses a job naming another workspace as its resource", async () => {
    await expect(
      run({ resourceId: otherWorkspaceId, resourceType: "workspace" }),
    ).rejects.toThrow();
    expect(startAnalyticsRun).not.toHaveBeenCalled();
  });
});

describe("account scope", () => {
  const dirtySince = new Date("2026-08-04T00:00:00.000Z");

  beforeEach(() => {
    instagramAccountFindFirst.mockResolvedValue({
      analyticsDirtySince: dirtySince,
      id: accountId,
    });
  });

  it("still skips on its own cleared marker", async () => {
    instagramAccountFindFirst.mockResolvedValue({ analyticsDirtySince: null, id: accountId });

    await run({ resourceId: accountId, resourceType: "instagram_account" });

    expect(skipReasons()).toEqual(["ALREADY_CURRENT"]);
    expect(startAnalyticsRun).not.toHaveBeenCalled();
  });

  it("carries its account and its marker through to activation", async () => {
    await run({ resourceId: accountId, resourceType: "instagram_account" });

    expect(startAnalyticsRun.mock.calls[0]?.[2]).toMatchObject({
      instagramAccountId: accountId,
    });
    expect(activateAnalyticsRun.mock.calls[0]?.[2]).toMatchObject({
      dirtySince,
      instagramAccountId: accountId,
    });
  });

  it("never consults the pooled scope's published fingerprint", async () => {
    // The marker is the account's whole currency test. Asking the fingerprint as
    // well would skip a run whose inputs happened to match the pooled set.
    await run({ resourceId: accountId, resourceType: "instagram_account" });

    expect(findActiveRunFingerprint).not.toHaveBeenCalled();
  });

  it("refuses a resource type it does not recognise", async () => {
    await expect(run({ resourceId: accountId, resourceType: "video_asset" })).rejects.toThrow();
  });
});
