import { loadDatabaseConfig } from "@studio-parallel/config";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createDatabaseClient, type DatabaseClient } from "../../src/client.js";
import { createId } from "../../src/id.js";
import { recordInstagramMetricSnapshot } from "../../src/instagram-insights.js";
import {
  instagramSyncRunActive,
  listInstagramAccountsDueForSync,
  listInstagramPostsDueForSnapshot,
  listInstagramSnapshotCoverage,
} from "../../src/instagram-scheduling.js";
import { developmentWorkspace } from "../../src/seed-data.js";
import { createWorkspaceContext } from "../../src/workspace-context.js";

const databaseConfig = loadDatabaseConfig();
let database: DatabaseClient;

const context = createWorkspaceContext(developmentWorkspace.id);
const now = new Date("2026-07-31T00:00:00.000Z");
const hours = (count: number) => count * 3_600_000;

async function clearAll(): Promise<void> {
  await database.instagramMetricSnapshot.deleteMany();
  await database.instagramPost.deleteMany();
  await database.syncRun.deleteMany();
  await database.integrationCredential.deleteMany();
  await database.instagramAccount.deleteMany();
}

async function createAccount(
  overrides: Readonly<{
    connectionStatus?: "ACTIVE" | "DISCONNECTED" | "REAUTHORISATION_REQUIRED";
    lastSuccessfulSyncAt?: Date | null;
  }> = {},
): Promise<string> {
  const id = createId();
  await database.instagramAccount.create({
    data: {
      accountType: "BUSINESS",
      apiVersion: "v25.0",
      connectionStatus: overrides.connectionStatus ?? "ACTIVE",
      grantedScopes: ["instagram_business_basic"],
      id,
      lastSuccessfulSyncAt: overrides.lastSuccessfulSyncAt ?? null,
      providerAccountId: `1784140000000${Math.floor(Math.random() * 9000) + 1000}`,
      username: "studioparallel",
      workspaceId: developmentWorkspace.id,
    },
  });
  return id;
}

async function createPost(accountId: string, publishedAt: Date): Promise<string> {
  const id = createId();
  await database.instagramPost.create({
    data: {
      firstImportedAt: now,
      id,
      instagramAccountId: accountId,
      lastImportedAt: now,
      mediaKind: "REEL",
      mediaProductType: "REELS",
      mediaType: "VIDEO",
      providerMediaId: `media-${id.slice(-12)}`,
      publishedAt,
      rawApiVersion: "v25.0",
      rawPayload: {},
      rawPayloadHash: "0".repeat(64),
      rawRetrievedAt: now,
      workspaceId: developmentWorkspace.id,
    },
  });
  return id;
}

function snapshot(postId: string, postAgeSeconds: number) {
  return recordInstagramMetricSnapshot(database, context, {
    apiVersion: "v25.0",
    capturedAt: now,
    instagramPostId: postId,
    observations: [
      {
        availability: "available",
        canonical: "views",
        description: null,
        period: "lifetime",
        providerName: "views",
        providerUnit: "count",
        title: null,
        unit: "count",
        value: 10,
      },
    ],
    postAgeSeconds,
    rawPayload: {},
  });
}

beforeAll(() => {
  database = createDatabaseClient(databaseConfig.DATABASE_URL);
});

beforeEach(async () => {
  await clearAll();
});

afterAll(async () => {
  await clearAll();
  await database.$disconnect();
});

describe("listInstagramAccountsDueForSync", () => {
  it("includes an account that has never synced", async () => {
    const accountId = await createAccount({ lastSuccessfulSyncAt: null });

    const due = await listInstagramAccountsDueForSync(database, {
      dueBefore: new Date(now.getTime() - hours(24)),
      limit: 10,
    });

    // A null watermark means the import has not happened, not that it is not due.
    expect(due.map((entry) => entry.accountId)).toEqual([accountId]);
  });

  it("includes an account whose last sync is older than the interval", async () => {
    const accountId = await createAccount({
      lastSuccessfulSyncAt: new Date(now.getTime() - hours(30)),
    });

    const due = await listInstagramAccountsDueForSync(database, {
      dueBefore: new Date(now.getTime() - hours(24)),
      limit: 10,
    });
    expect(due.map((entry) => entry.accountId)).toEqual([accountId]);
  });

  it("excludes an account synced within the interval", async () => {
    await createAccount({ lastSuccessfulSyncAt: new Date(now.getTime() - hours(2)) });

    await expect(
      listInstagramAccountsDueForSync(database, {
        dueBefore: new Date(now.getTime() - hours(24)),
        limit: 10,
      }),
    ).resolves.toEqual([]);
  });

  it.each(["DISCONNECTED", "REAUTHORISATION_REQUIRED"] as const)(
    "excludes a %s account so it stops being scheduled without a suppression list",
    async (connectionStatus) => {
      await createAccount({ connectionStatus, lastSuccessfulSyncAt: null });

      await expect(
        listInstagramAccountsDueForSync(database, {
          dueBefore: new Date(now.getTime() - hours(24)),
          limit: 10,
        }),
      ).resolves.toEqual([]);
    },
  );

  it("bounds the batch so one backlog cannot starve the sweep", async () => {
    for (let index = 0; index < 4; index += 1) await createAccount({ lastSuccessfulSyncAt: null });

    const due = await listInstagramAccountsDueForSync(database, {
      dueBefore: new Date(now.getTime() - hours(24)),
      limit: 2,
    });
    expect(due).toHaveLength(2);
  });

  it("carries the workspace so the enqueue that follows is scoped", async () => {
    await createAccount({ lastSuccessfulSyncAt: null });

    const due = await listInstagramAccountsDueForSync(database, {
      dueBefore: new Date(now.getTime() - hours(24)),
      limit: 10,
    });
    expect(due[0]?.workspaceId).toBe(developmentWorkspace.id);
  });
});

describe("listInstagramPostsDueForSnapshot", () => {
  it("owes the current bucket for a post that has never been observed", async () => {
    const accountId = await createAccount();
    const postId = await createPost(accountId, new Date(now.getTime() - hours(24)));

    const due = await listInstagramPostsDueForSnapshot(database, { limit: 10, now });

    expect(due).toHaveLength(1);
    expect(due[0]).toMatchObject({ ageBucket: "day_1", postId });
  });

  it("owes nothing once the current bucket has been captured", async () => {
    const accountId = await createAccount();
    const postId = await createPost(accountId, new Date(now.getTime() - hours(24)));
    await snapshot(postId, 86_400);

    // The column is an upper-case enum and the contract is lower-case; comparing
    // them unconverted would leave every post looking permanently due.
    await expect(listInstagramPostsDueForSnapshot(database, { limit: 10, now })).resolves.toEqual(
      [],
    );
  });

  it("owes the next bucket once the post ages into it", async () => {
    const accountId = await createAccount();
    const postId = await createPost(accountId, new Date(now.getTime() - hours(24)));
    await snapshot(postId, 3_600);

    const due = await listInstagramPostsDueForSnapshot(database, { limit: 10, now });
    expect(due[0]).toMatchObject({ ageBucket: "day_1", postId });
  });

  it("owes nothing for a mature post", async () => {
    const accountId = await createAccount();
    await createPost(accountId, new Date(now.getTime() - hours(24 * 60)));

    await expect(listInstagramPostsDueForSnapshot(database, { limit: 10, now })).resolves.toEqual(
      [],
    );
  });

  it("excludes posts whose account is no longer connected", async () => {
    const accountId = await createAccount({ connectionStatus: "DISCONNECTED" });
    await createPost(accountId, new Date(now.getTime() - hours(24)));

    await expect(listInstagramPostsDueForSnapshot(database, { limit: 10, now })).resolves.toEqual(
      [],
    );
  });

  it("reports the age it measured rather than the bucket's nominal target", async () => {
    const accountId = await createAccount();
    await createPost(accountId, new Date(now.getTime() - hours(34)));

    const due = await listInstagramPostsDueForSnapshot(database, { limit: 10, now });
    // A capture at 34 hours is a 34-hour observation that happens to fall in
    // day_1. Reporting 24 hours would backdate a missed target.
    expect(due[0]).toMatchObject({ ageBucket: "day_1", postAgeSeconds: 122_400 });
  });

  it("bounds the batch", async () => {
    const accountId = await createAccount();
    for (let index = 0; index < 4; index += 1) {
      await createPost(accountId, new Date(now.getTime() - hours(24) - index * 1000));
    }

    await expect(
      listInstagramPostsDueForSnapshot(database, { limit: 2, now }),
    ).resolves.toHaveLength(2);
  });
});

describe("instagramSyncRunActive", () => {
  it("is false when nothing is running", async () => {
    const accountId = await createAccount();

    await expect(
      instagramSyncRunActive(database, context, {
        instagramAccountId: accountId,
        trigger: "MANUAL",
      }),
    ).resolves.toBe(false);
  });

  it("is true only for the trigger that is actually running", async () => {
    const accountId = await createAccount();
    await database.syncRun.create({
      data: {
        apiVersion: "v25.0",
        correlationId: "0192f2a0-0000-7000-8000-00000000abcd",
        id: createId(),
        idempotencyKey: "manual-run",
        instagramAccountId: accountId,
        startedAt: now,
        state: "RUNNING",
        trigger: "MANUAL",
        workspaceId: developmentWorkspace.id,
      },
    });

    await expect(
      instagramSyncRunActive(database, context, {
        instagramAccountId: accountId,
        trigger: "MANUAL",
      }),
    ).resolves.toBe(true);
    // A manual run must not block a scheduled one; the lock is per purpose.
    await expect(
      instagramSyncRunActive(database, context, {
        instagramAccountId: accountId,
        trigger: "SCHEDULED",
      }),
    ).resolves.toBe(false);
  });

  it("reads nothing for another workspace", async () => {
    const accountId = await createAccount();
    const foreign = createWorkspaceContext("019a0000-0000-7000-8000-0000000006ff");

    await expect(
      instagramSyncRunActive(database, foreign, {
        instagramAccountId: accountId,
        trigger: "MANUAL",
      }),
    ).resolves.toBe(false);
  });
});

describe("listInstagramSnapshotCoverage", () => {
  it("reports buckets the post aged past without being observed", async () => {
    const accountId = await createAccount();
    const postId = await createPost(accountId, new Date(now.getTime() - hours(24)));
    await snapshot(postId, 600);

    const coverage = await listInstagramSnapshotCoverage(database, context, {
      instagramPostId: postId,
      now,
    });

    expect(coverage.currentBucket).toBe("day_1");
    expect(coverage.capturedBuckets).toEqual(["import"]);
    // The current bucket is still open, so it is owed rather than missed.
    expect(coverage.missedBuckets).toEqual(["hour_1"]);
  });

  it("reports nothing missed for a brand new post", async () => {
    const accountId = await createAccount();
    const postId = await createPost(accountId, now);

    const coverage = await listInstagramSnapshotCoverage(database, context, {
      instagramPostId: postId,
      now,
    });
    expect(coverage.missedBuckets).toEqual([]);
  });

  it("returns an empty coverage for another workspace's post", async () => {
    const accountId = await createAccount();
    const postId = await createPost(accountId, new Date(now.getTime() - hours(24)));
    const foreign = createWorkspaceContext("019a0000-0000-7000-8000-0000000006ff");

    const coverage = await listInstagramSnapshotCoverage(database, foreign, {
      instagramPostId: postId,
      now,
    });
    expect(coverage.capturedBuckets).toEqual([]);
  });
});
