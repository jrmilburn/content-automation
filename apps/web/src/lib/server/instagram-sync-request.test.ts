import { beforeEach, describe, expect, it, vi } from "vitest";

const actor = {
  internalUserId: "0192f2a0-0000-7000-8000-000000000001",
  sessionVersion: 1,
  workspaceId: "0192f2a0-0000-7000-8000-0000000000ff",
};

const accountId = "019a0000-0000-7000-8000-000000000301";
const correlationId = "0192f2a0-0000-7000-8000-00000000abcd";

const auditRecord = vi.fn();
const countRecentByActor = vi.fn();
const findActiveAdminPrincipal = vi.fn();
const findFirst = vi.fn();
const enqueueBackgroundJob = vi.fn();
const instagramSyncRunActive = vi.fn();

vi.mock("@studio-parallel/db", () => ({
  createWorkspaceContext: (workspaceId: string) => ({ workspaceId }),
  createWorkspaceRepositories: () => ({
    audit: {
      countRecentByActor: (...args: unknown[]) => countRecentByActor(...args),
      record: (...args: unknown[]) => auditRecord(...args),
    },
  }),
  enqueueBackgroundJob: (...args: unknown[]) => enqueueBackgroundJob(...args),
  findActiveAdminPrincipal: (...args: unknown[]) => findActiveAdminPrincipal(...args),
  instagramAccountResourceType: "instagram_account",
  instagramSyncRunActive: (...args: unknown[]) => instagramSyncRunActive(...args),
  isUuidV7: (value: string) =>
    /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value),
}));

vi.mock("./database", () => ({
  getDatabase: () => ({
    instagramAccount: { findFirst: (...args: unknown[]) => findFirst(...args) },
  }),
}));

const { requestInstagramSync, syncRequestLimit } = await import("./instagram-sync-request");

function request(overrides: Partial<Parameters<typeof requestInstagramSync>[0]> = {}) {
  return requestInstagramSync({ accountId, actor, correlationId, ...overrides });
}

beforeEach(() => {
  vi.clearAllMocks();
  findActiveAdminPrincipal.mockResolvedValue(actor);
  countRecentByActor.mockResolvedValue(0);
  findFirst.mockResolvedValue({ connectionStatus: "ACTIVE", id: accountId });
  instagramSyncRunActive.mockResolvedValue(false);
  enqueueBackgroundJob.mockResolvedValue({ created: true });
});

describe("requestInstagramSync authorisation", () => {
  it("refuses a non-admin and enqueues nothing", async () => {
    findActiveAdminPrincipal.mockResolvedValue(null);

    await expect(request()).resolves.toEqual({ queued: false, reason: "ADMIN_REQUIRED" });
    expect(enqueueBackgroundJob).not.toHaveBeenCalled();
    expect(auditRecord).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "REFUSED", reasonCode: "ADMIN_REQUIRED" }),
    );
  });

  it("re-reads the role from the database rather than trusting the session", async () => {
    await request();
    expect(findActiveAdminPrincipal).toHaveBeenCalledWith(expect.anything(), actor);
  });

  it.each([
    ["a crafted non-uuid", "../../etc/passwd"],
    ["a uuid of the wrong version", "0192f2a0-0000-4000-8000-000000000001"],
  ])("refuses %s without querying for it", async (_label, crafted) => {
    await expect(request({ accountId: crafted })).resolves.toEqual({
      queued: false,
      reason: "ACCOUNT_NOT_FOUND",
    });
    expect(findFirst).not.toHaveBeenCalled();
    expect(enqueueBackgroundJob).not.toHaveBeenCalled();
  });

  it("refuses an account belonging to another workspace with the same reason as an absent one", async () => {
    findFirst.mockResolvedValue(null);

    await expect(request()).resolves.toEqual({ queued: false, reason: "ACCOUNT_NOT_FOUND" });
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: accountId, workspaceId: actor.workspaceId } }),
    );
  });

  it("does not echo a crafted identifier into the audit trail as a resource", async () => {
    findFirst.mockResolvedValue(null);
    await request();

    expect(auditRecord).toHaveBeenCalledWith(
      expect.not.objectContaining({ resourceId: expect.anything() }),
    );
  });

  it("refuses once the per-actor attempt limit is reached", async () => {
    countRecentByActor.mockResolvedValue(syncRequestLimit);

    await expect(request()).resolves.toEqual({ queued: false, reason: "RATE_LIMITED" });
    expect(enqueueBackgroundJob).not.toHaveBeenCalled();
  });

  it("checks the rate limit before it reads the account", async () => {
    countRecentByActor.mockResolvedValue(syncRequestLimit);
    await request();

    // Otherwise the limit could be used to probe which accounts exist.
    expect(findFirst).not.toHaveBeenCalled();
  });
});

describe("requestInstagramSync eligibility", () => {
  it.each(["REAUTHORISATION_REQUIRED", "DISCONNECTED"] as const)(
    "refuses a %s connection instead of queueing work that would fail",
    async (connectionStatus) => {
      findFirst.mockResolvedValue({ connectionStatus, id: accountId });

      await expect(request()).resolves.toEqual({
        queued: false,
        reason: "ACCOUNT_NOT_CONNECTED",
      });
      expect(enqueueBackgroundJob).not.toHaveBeenCalled();
    },
  );

  it("reports an in-flight run instead of enqueueing a second one", async () => {
    instagramSyncRunActive.mockResolvedValue(true);

    await expect(request()).resolves.toEqual({ alreadyRunning: true, queued: true });
    // The unique index would refuse the second run anyway, and that refusal
    // would surface as a failed job rather than as an answer.
    expect(enqueueBackgroundJob).not.toHaveBeenCalled();
    expect(auditRecord).toHaveBeenCalledWith(expect.objectContaining({ outcome: "NO_CHANGE" }));
  });
});

describe("requestInstagramSync enqueue", () => {
  it("queues a manual sync above the scheduled priority", async () => {
    await expect(request()).resolves.toEqual({ alreadyRunning: false, queued: true });

    expect(enqueueBackgroundJob).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        queueName: "instagram.sync.account",
        resourceId: accountId,
        resourceType: "instagram_account",
      }),
    );
    const enqueued = enqueueBackgroundJob.mock.calls[0]?.[2] as { priority: number };
    expect(enqueued.priority).toBeGreaterThan(0);
  });

  it("uses a key that states the trigger, so the run is recorded as manual", async () => {
    await request();

    const enqueued = enqueueBackgroundJob.mock.calls[0]?.[2] as { idempotencyKey: string };
    expect(enqueued.idempotencyKey).toContain("instagram-sync-manual-");
    expect(enqueued.idempotencyKey).toContain(accountId);
    // A dotted key passes the job pattern and then fails the sync-run pattern.
    expect(enqueued.idempotencyKey).not.toContain(".");
  });

  it("audits the request as queued", async () => {
    await request();
    expect(auditRecord).toHaveBeenCalledWith(
      expect.objectContaining({ outcome: "QUEUED", resourceId: accountId }),
    );
  });
});
