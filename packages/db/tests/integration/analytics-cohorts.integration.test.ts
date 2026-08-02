import { loadDatabaseConfig } from "@studio-parallel/config";
import type { InstagramMetricObservation } from "@studio-parallel/domain";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { comparePostToCohort, loadCohort } from "../../src/analytics-cohorts.js";
import { createDatabaseClient, type DatabaseClient } from "../../src/client.js";
import { createId } from "../../src/id.js";
import { recordInstagramMetricSnapshot } from "../../src/instagram-insights.js";
import { developmentWorkspace } from "../../src/seed-data.js";
import { createWorkspaceContext } from "../../src/workspace-context.js";

/**
 * Cohort selection against real SQL.
 *
 * The unit tests prove the selection arithmetic. These prove the parts only a
 * database can: that the age tolerance survives into the query, that a second
 * account and a second workspace are invisible, and that a post contributes once
 * however many times it was observed.
 */

const databaseConfig = loadDatabaseConfig();
let database: DatabaseClient;

const context = createWorkspaceContext(developmentWorkspace.id);
const publishedTo = new Date("2026-07-31T00:00:00.000Z");
const publishedFrom = new Date("2026-01-01T00:00:00.000Z");

let accountId: string;
let otherAccountId: string;

function observation(
  canonical: InstagramMetricObservation["canonical"],
  value: number | null,
): InstagramMetricObservation {
  return {
    availability: value === null ? "not_applicable" : "available",
    canonical,
    description: null,
    period: "lifetime",
    providerName: canonical,
    providerUnit: "count",
    title: null,
    unit: "count",
    value,
  };
}

/** Reach and likes only, so `like_rate_reach` is the metric under test. */
function reachAndLikes(reach: number | null, likes: number | null) {
  return [observation("reach", reach), observation("likes", likes)];
}

async function clear(): Promise<void> {
  await database.instagramMetricSnapshot.deleteMany();
  await database.instagramPost.deleteMany();
  await database.syncRun.deleteMany();
  await database.integrationCredential.deleteMany();
  await database.instagramAccount.deleteMany();
}

async function createAccount(): Promise<string> {
  const id = createId();
  await database.instagramAccount.create({
    data: {
      accountType: "BUSINESS",
      apiVersion: "v25.0",
      grantedScopes: ["instagram_business_basic"],
      id,
      providerAccountId: `1784140000000${Math.floor(Math.random() * 9000) + 1000}`,
      username: "studioparallel",
      workspaceId: developmentWorkspace.id,
    },
  });

  return id;
}

async function createPost(
  options: Readonly<{
    accountId?: string;
    mediaProductType?: string;
    publishedAt?: Date;
  }> = {},
): Promise<string> {
  const id = createId();
  const publishedAt = options.publishedAt ?? new Date("2026-06-01T00:00:00.000Z");

  await database.instagramPost.create({
    data: {
      firstImportedAt: publishedAt,
      id,
      instagramAccountId: options.accountId ?? accountId,
      lastImportedAt: publishedAt,
      mediaKind: "REEL",
      mediaProductType: options.mediaProductType ?? "REELS",
      mediaType: "VIDEO",
      providerMediaId: `media-${id.slice(-12)}`,
      publishedAt,
      rawApiVersion: "v25.0",
      rawPayload: {},
      rawPayloadHash: "0".repeat(64),
      rawRetrievedAt: publishedAt,
      workspaceId: developmentWorkspace.id,
    },
  });

  return id;
}

async function snapshot(
  postId: string,
  postAgeSeconds: number,
  observations: readonly InstagramMetricObservation[],
): Promise<string> {
  const result = await recordInstagramMetricSnapshot(database, context, {
    apiVersion: "v25.0",
    capturedAt: new Date(Date.parse("2026-06-01T00:00:00.000Z") + postAgeSeconds * 1_000),
    instagramPostId: postId,
    observations,
    postAgeSeconds,
    rawPayload: {},
  });

  return result.snapshotId;
}

const request = {
  ageWindow: "day_1",
  instagramAccountId: "",
  metric: "like_rate_reach",
  publishedFrom,
  publishedTo,
} as const;

function accountRequest(overrides: Record<string, unknown> = {}) {
  return { ...request, instagramAccountId: accountId, ...overrides };
}

beforeAll(async () => {
  database = createDatabaseClient(databaseConfig.DATABASE_URL);
});

beforeEach(async () => {
  await clear();
  accountId = await createAccount();
  otherAccountId = await createAccount();
});

afterAll(async () => {
  await clear();
  await database.$disconnect();
});

describe("loadCohort", () => {
  it("derives a median and spread from one snapshot per post", async () => {
    for (const likes of [100, 200, 300]) {
      const postId = await createPost();
      await snapshot(postId, 86_400, reachAndLikes(1_000, likes));
    }

    const cohort = await loadCohort(database, context, "account", accountRequest());

    expect(cohort.members).toHaveLength(3);
    expect(cohort.spread.median).toBeCloseTo(0.2, 10);
    expect(cohort.spread.count).toBe(3);
    expect(cohort.coverage).toMatchObject({ eligiblePosts: 3, postsWithValue: 3, missingRatio: 0 });
  });

  it("contributes one snapshot per post however often it was observed", async () => {
    const postId = await createPost();
    await snapshot(postId, 70_000, reachAndLikes(1_000, 100));
    await snapshot(postId, 86_400, reachAndLikes(1_000, 500));
    await snapshot(postId, 120_000, reachAndLikes(1_000, 900));

    const cohort = await loadCohort(database, context, "account", accountRequest());

    expect(cohort.members).toHaveLength(1);
    // The snapshot closest to the 24h target, not the newest and not the first.
    expect(cohort.members[0]?.value).toBeCloseTo(0.5, 10);
  });

  it("excludes snapshots outside the age tolerance in SQL", async () => {
    const inside = await createPost();
    await snapshot(inside, 86_400, reachAndLikes(1_000, 100));

    const tooYoung = await createPost();
    // Stored as DAY_1 by the partition, but ten hours is outside the 18-36h
    // tolerance, so it must not reach the cohort.
    await snapshot(tooYoung, 36_000, reachAndLikes(1_000, 900));

    const cohort = await loadCohort(database, context, "account", accountRequest());

    expect(cohort.members.map((member) => member.postId)).toEqual([inside]);
    expect(cohort.coverage).toMatchObject({ eligiblePosts: 2, postsMissingSnapshot: 1 });
  });

  it("counts a post observed but missing the metric apart from one never observed", async () => {
    const withMetric = await createPost();
    await snapshot(withMetric, 86_400, reachAndLikes(1_000, 100));

    const observedWithoutReach = await createPost();
    await snapshot(observedWithoutReach, 86_400, reachAndLikes(null, 100));

    await createPost();

    const cohort = await loadCohort(database, context, "account", accountRequest());

    expect(cohort.coverage).toMatchObject({
      eligiblePosts: 3,
      postsMissingMetric: 1,
      postsMissingSnapshot: 1,
      postsWithValue: 1,
    });
    expect(cohort.coverage.missingRatio).toBeCloseTo(2 / 3, 10);
  });

  it("never divides by a zero reach", async () => {
    const postId = await createPost();
    await snapshot(postId, 86_400, reachAndLikes(0, 5));

    const cohort = await loadCohort(database, context, "account", accountRequest());

    expect(cohort.members).toHaveLength(0);
    expect(cohort.coverage.postsMissingMetric).toBe(1);
  });

  it("is bounded to one account", async () => {
    const mine = await createPost();
    await snapshot(mine, 86_400, reachAndLikes(1_000, 100));

    const theirs = await createPost({ accountId: otherAccountId });
    await snapshot(theirs, 86_400, reachAndLikes(1_000, 900));

    const cohort = await loadCohort(database, context, "account", accountRequest());

    expect(cohort.members.map((member) => member.postId)).toEqual([mine]);
  });

  it("is bounded to the publication window", async () => {
    const inside = await createPost({ publishedAt: new Date("2026-06-01T00:00:00.000Z") });
    await snapshot(inside, 86_400, reachAndLikes(1_000, 100));

    const before = await createPost({ publishedAt: new Date("2025-06-01T00:00:00.000Z") });
    await snapshot(before, 86_400, reachAndLikes(1_000, 900));

    const cohort = await loadCohort(database, context, "account", accountRequest());

    expect(cohort.members.map((member) => member.postId)).toEqual([inside]);
  });

  it("finds nothing for another workspace's context", async () => {
    const postId = await createPost();
    await snapshot(postId, 86_400, reachAndLikes(1_000, 100));

    const cohort = await loadCohort(
      database,
      createWorkspaceContext(createId()),
      "account",
      accountRequest(),
    );

    expect(cohort.members).toHaveLength(0);
    expect(cohort.coverage.eligiblePosts).toBe(0);
  });

  it("excludes the focal post from its own comparison", async () => {
    const focal = await createPost();
    await snapshot(focal, 86_400, reachAndLikes(1_000, 900));

    for (const likes of [100, 200]) {
      const postId = await createPost();
      await snapshot(postId, 86_400, reachAndLikes(1_000, likes));
    }

    const cohort = await loadCohort(
      database,
      context,
      "account",
      accountRequest({ focalPostId: focal }),
    );

    expect(cohort.members.map((member) => member.postId)).not.toContain(focal);
    expect(cohort.spread.median).toBeCloseTo(0.15, 10);
  });

  it("narrows a category cohort to one media category", async () => {
    const reel = await createPost({ mediaProductType: "REELS" });
    await snapshot(reel, 86_400, reachAndLikes(1_000, 100));

    const feed = await createPost({ mediaProductType: "FEED" });
    await snapshot(feed, 86_400, reachAndLikes(1_000, 900));

    const cohort = await loadCohort(
      database,
      context,
      "category",
      accountRequest({ mediaCategory: "REELS" }),
    );

    expect(cohort.members.map((member) => member.postId)).toEqual([reel]);
    expect(cohort.definition.categoryValue).toBe("REELS");
  });

  it("limits a recent cohort by both count and period", async () => {
    // Twenty-two posts inside ninety days, plus one outside it.
    for (let index = 0; index < 22; index += 1) {
      const postId = await createPost({
        publishedAt: new Date(Date.parse("2026-07-01T00:00:00.000Z") - index * 86_400_000),
      });
      await snapshot(postId, 86_400, reachAndLikes(1_000, 100));
    }

    const old = await createPost({ publishedAt: new Date("2026-01-05T00:00:00.000Z") });
    await snapshot(old, 86_400, reachAndLikes(1_000, 999));

    const cohort = await loadCohort(database, context, "recent", accountRequest());

    expect(cohort.members).toHaveLength(20);
    expect(cohort.members.map((member) => member.postId)).not.toContain(old);
    expect(Date.parse(cohort.definition.publishedFrom)).toBe(
      publishedTo.getTime() - 90 * 86_400_000,
    );
  });

  it("produces a fingerprint that tracks the contributing snapshots", async () => {
    const postId = await createPost();
    await snapshot(postId, 86_400, reachAndLikes(1_000, 100));

    const before = await loadCohort(database, context, "account", accountRequest());

    const second = await createPost();
    await snapshot(second, 86_400, reachAndLikes(1_000, 200));

    const after = await loadCohort(database, context, "account", accountRequest());

    expect(before.fingerprint).toBe(
      (await loadCohort(database, context, "account", accountRequest({ focalPostId: second })))
        .fingerprint,
    );
    expect(after.fingerprint).not.toBe(before.fingerprint);
  });
});

describe("comparePostToCohort", () => {
  it("reads the focal value through the same window as its baseline", async () => {
    const focal = await createPost();
    // A young observation the window must ignore, and the comparable one it must
    // use. Taking the newest instead would compare different ages.
    await snapshot(focal, 36_000, reachAndLikes(1_000, 10));
    await snapshot(focal, 86_400, reachAndLikes(1_000, 300));

    for (const likes of [100, 200]) {
      const postId = await createPost();
      await snapshot(postId, 86_400, reachAndLikes(1_000, likes));
    }

    const { cohort, comparison } = await comparePostToCohort(database, context, "account", {
      ...accountRequest(),
      focalPostId: focal,
    });

    expect(cohort.members).toHaveLength(2);
    expect(comparison).toMatchObject({ availability: "available", comparisonCount: 2 });
    expect(comparison.focalValue).toBeCloseTo(0.3, 10);
    expect(comparison.baseline).toBeCloseTo(0.15, 10);
    expect(comparison.relativeIndex).toBeCloseTo(2, 10);
  });

  it("reports an absent focal observation rather than a zero", async () => {
    const focal = await createPost();

    const other = await createPost();
    await snapshot(other, 86_400, reachAndLikes(1_000, 100));

    const { comparison } = await comparePostToCohort(database, context, "account", {
      ...accountRequest(),
      focalPostId: focal,
    });

    expect(comparison).toMatchObject({
      availability: "unavailable",
      focalValue: null,
      reason: "focal_value_unavailable",
    });
    expect(other).toBeTruthy();
  });
});
