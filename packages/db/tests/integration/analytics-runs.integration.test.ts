import { loadDatabaseConfig } from "@studio-parallel/config";
import type { InstagramMetricObservation } from "@studio-parallel/domain";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  buildFeatureRequests,
  loadAnalyticsInputs,
  loadBestAnalyticsInputs,
} from "../../src/analytics-features.js";
import {
  listTrendFeaturePaths,
  loadAccountTrends,
  loadTrendDetail,
} from "../../src/analytics-trends.js";
import {
  activateAnalyticsRun,
  analyticsDebounceMs,
  createRunInputFingerprint,
  findActiveAnalyticsRun,
  listAccountsDueForAnalytics,
  markAnalyticsDirty,
  startAnalyticsRun,
} from "../../src/analytics-runs.js";
import { createDatabaseClient, type DatabaseClient } from "../../src/client.js";
import { calculateFeatureFamily, storeFeatureStatistics } from "../../src/feature-statistics.js";
import { createId } from "../../src/id.js";
import { recordInstagramMetricSnapshot } from "../../src/instagram-insights.js";
import { developmentWorkspace } from "../../src/seed-data.js";
import { createWorkspaceContext } from "../../src/workspace-context.js";

/**
 * The recalculation run, end to end against real SQL.
 *
 * Three things need a database. The debounce has to survive a burst without
 * either producing a run per change or postponing itself forever. Activation has
 * to be atomic, which means the partial unique index doing the work rather than
 * ordering in the caller. And a run over unchanged inputs has to publish the
 * complete set even though almost none of it was written by that run — the case
 * that made an earlier version refuse every run after the first.
 */

const databaseConfig = loadDatabaseConfig();
let database: DatabaseClient;

const context = createWorkspaceContext(developmentWorkspace.id);
const publishedFrom = new Date("2026-01-01T00:00:00.000Z");
const publishedTo = new Date("2026-07-31T00:00:00.000Z");
const calculatedAt = new Date("2026-08-03T06:00:00.000Z");

let accountId: string;

/** An intent records who uploaded, so the fixture needs a real user. */
const uploaderId = "01900000-0000-7000-8000-0000000004a1";

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

async function clear(): Promise<void> {
  await database.accountAnalyticsRunStatistic.deleteMany();
  await database.accountFeatureStatisticPost.deleteMany();
  await database.accountFeatureStatistic.deleteMany();
  await database.accountAnalyticsRun.deleteMany();
  // The current-analysis pointer restricts deleting the analysis it points at,
  // so it is released before the analyses go.
  await database.instagramPost.updateMany({ data: { currentAnalysisId: null }, where: {} });
  await database.postAnalysis.deleteMany();
  await database.analysisJob.deleteMany();
  await database.videoAsset.deleteMany();
  await database.videoUploadIntent.deleteMany();
  await database.instagramMetricSnapshot.deleteMany();
  await database.instagramPost.deleteMany();
  await database.backgroundJob.deleteMany();
  await database.instagramAccount.deleteMany();
}

/**
 * One analysed post with one snapshot.
 *
 * `hookCategory` is what the comparisons group on and `likes` is what separates
 * them, so a caller says only those two things and gets a post the statistics
 * engine can actually measure.
 */
async function analysedPost(
  input: Readonly<{
    hookCategory: string | null;
    likes: number;
    /** Age at capture. Defaults inside the 30-day window the tests read. */
    postAgeSeconds?: number;
    publishedAt: Date;
    /**
     * Whether to capture anything at all.
     *
     * Analysed but never observed is the only state left in which no window can
     * measure a post: `lifetime` admits an observation of any age, so a captured
     * post is always measurable by something.
     */
    snapshot?: boolean;
  }>,
): Promise<string> {
  const postId = createId();

  await database.instagramPost.create({
    data: {
      firstImportedAt: input.publishedAt,
      id: postId,
      instagramAccountId: accountId,
      lastImportedAt: input.publishedAt,
      mediaKind: "REEL",
      mediaProductType: "REELS",
      mediaType: "VIDEO",
      providerMediaId: `media-${postId.slice(-12)}`,
      publishedAt: input.publishedAt,
      rawApiVersion: "v25.0",
      rawPayload: {},
      rawPayloadHash: "0".repeat(64),
      rawRetrievedAt: input.publishedAt,
      workspaceId: developmentWorkspace.id,
    },
  });

  const intentId = createId();
  await database.videoUploadIntent.create({
    data: {
      bucket: "studio-parallel-source-video",
      createdByUserId: uploaderId,
      declaredBytes: BigInt(1_024),
      declaredContentType: "video/mp4",
      expiresAt: new Date(input.publishedAt.getTime() + 3_600_000),
      id: intentId,
      instagramPostId: postId,
      objectKey: `production/${developmentWorkspace.id}/source-video/${intentId.slice(-16)}`,
      partCount: 1,
      partSizeBytes: 1_024,
      providerUploadId: `upload-${intentId.slice(-12)}`,
      region: "ap-southeast-2",
      state: "COMPLETED",
      workspaceId: developmentWorkspace.id,
    },
  });

  const assetId = createId();
  await database.videoAsset.create({
    data: {
      bucket: "studio-parallel-source-video",
      bytes: BigInt(1_024),
      contentType: "video/mp4",
      durationMs: 30_000,
      etag: `etag-${assetId.slice(-8)}`,
      id: assetId,
      instagramPostId: postId,
      objectKey: `production/${developmentWorkspace.id}/source-video/${assetId.slice(-16)}`,
      region: "ap-southeast-2",
      state: "READY",
      uploadIntentId: intentId,
      workspaceId: developmentWorkspace.id,
    },
  });

  const backgroundJobId = createId();
  await database.backgroundJob.create({
    data: {
      correlationId: createId(),
      handlerVersion: 1,
      id: backgroundJobId,
      idempotencyKey: `analysis-run-${backgroundJobId.slice(-16)}`,
      queueName: "analysis.run",
      workspaceId: developmentWorkspace.id,
    },
  });

  const analysisJobId = createId();
  await database.analysisJob.create({
    data: {
      backgroundJobId,
      id: analysisJobId,
      instagramPostId: postId,
      modelRequested: "gemini-3.6-flash",
      promptVersion: "post-creative-analysis-prompt-v1.1.0",
      requestSignature: analysisJobId.replaceAll("-", "").padEnd(64, "0").slice(0, 64),
      schemaVersion: "post-creative-analysis-v1.1.0",
      videoAssetId: assetId,
      workspaceId: developmentWorkspace.id,
    },
  });

  const analysisId = createId();
  await database.postAnalysis.create({
    data: {
      analysedAt: input.publishedAt,
      analysisJobId,
      durationSeconds: 30,
      hookCategory: input.hookCategory,
      id: analysisId,
      instagramPostId: postId,
      modelRequested: "gemini-3.6-flash",
      overallConfidence: "high",
      promptSha256: "a".repeat(64),
      promptVersion: "post-creative-analysis-prompt-v1.1.0",
      requestSignature: analysisJobId.replaceAll("-", "").padEnd(64, "0").slice(0, 64),
      result: {},
      schemaSha256: "b".repeat(64),
      schemaVersion: "post-creative-analysis-v1.1.0",
      validationWarnings: [],
      videoAssetId: assetId,
      workspaceId: developmentWorkspace.id,
    },
  });

  await database.instagramPost.updateMany({
    data: { currentAnalysisId: analysisId },
    where: { id: postId, workspaceId: developmentWorkspace.id },
  });

  if (input.snapshot === false) return postId;

  // Inside the 30-day window the recalculation reads, unless a test says otherwise.
  const postAgeSeconds = input.postAgeSeconds ?? 30 * 86_400;
  await recordInstagramMetricSnapshot(database, context, {
    apiVersion: "v25.0",
    capturedAt: new Date(input.publishedAt.getTime() + postAgeSeconds * 1_000),
    instagramPostId: postId,
    observations: [observation("reach", 1_000), observation("likes", input.likes)],
    postAgeSeconds,
    rawPayload: { likes: input.likes },
  });

  return postId;
}

const request = {
  ageWindow: "day_30",
  instagramAccountId: "",
  publishedFrom,
  publishedTo,
} as const;

function inputRequest() {
  return { ...request, instagramAccountId: accountId };
}

/** Calculates and stores every family under one run, the way the handler does. */
async function calculateInto(runId: string): Promise<number> {
  const inputs = await loadAnalyticsInputs(database, context, inputRequest());
  const families = buildFeatureRequests(inputRequest(), inputs);
  let candidates = 0;

  for (const family of families) {
    candidates += family.candidates.length;
    await storeFeatureStatistics(
      database,
      context,
      family,
      calculateFeatureFamily(family),
      calculatedAt,
      runId,
    );
  }

  return candidates;
}

beforeAll(async () => {
  database = createDatabaseClient(databaseConfig.DATABASE_URL);
});

beforeEach(async () => {
  await clear();

  await database.internalUser.upsert({
    create: {
      email: `analytics-${uploaderId}@studioparallel.invalid`,
      id: uploaderId,
      role: "ADMIN",
      workspaceId: developmentWorkspace.id,
    },
    update: {},
    where: { workspaceId_id: { id: uploaderId, workspaceId: developmentWorkspace.id } },
  });

  accountId = createId();
  await database.instagramAccount.create({
    data: {
      accountType: "BUSINESS",
      apiVersion: "v25.0",
      grantedScopes: ["instagram_business_basic"],
      id: accountId,
      providerAccountId: `1784140000000${Math.floor(Math.random() * 9000) + 1000}`,
      workspaceId: developmentWorkspace.id,
    },
  });
});

afterAll(async () => {
  await clear();
  await database.$disconnect();
});

describe("the debounce window", () => {
  it("makes a burst of changes due once, anchored on the first", async () => {
    const first = new Date("2026-08-03T06:00:00.000Z");

    await markAnalyticsDirty(database, context, { instagramAccountId: accountId, now: first });
    for (let index = 1; index <= 5; index += 1) {
      await markAnalyticsDirty(database, context, {
        instagramAccountId: accountId,
        now: new Date(first.getTime() + index * 30_000),
      });
    }

    const account = await database.instagramAccount.findFirstOrThrow({
      where: { id: accountId },
    });

    // Anchored on the first change. Extending on every change is what would let
    // a steadily importing account postpone its recalculation forever.
    expect(account.analyticsDirtySince).toEqual(first);
    expect(account.analyticsDueAt).toEqual(new Date(first.getTime() + analyticsDebounceMs));
  });

  it("is not due until the window closes", async () => {
    const dirtyAt = new Date("2026-08-03T06:00:00.000Z");
    await markAnalyticsDirty(database, context, { instagramAccountId: accountId, now: dirtyAt });

    await expect(
      listAccountsDueForAnalytics(database, {
        limit: 10,
        now: new Date(dirtyAt.getTime() + analyticsDebounceMs - 1_000),
      }),
    ).resolves.toHaveLength(0);

    await expect(
      listAccountsDueForAnalytics(database, {
        limit: 10,
        now: new Date(dirtyAt.getTime() + analyticsDebounceMs),
      }),
    ).resolves.toHaveLength(1);
  });

  it("ignores an account that was never dirtied", async () => {
    await expect(
      listAccountsDueForAnalytics(database, { limit: 10, now: calculatedAt }),
    ).resolves.toHaveLength(0);
  });
});

describe("choosing the window a run publishes", () => {
  function windowRequest() {
    return { instagramAccountId: accountId, publishedFrom, publishedTo };
  }

  it("reads a post that only a mature observation can see", async () => {
    // Already past every closing bucket when the account connected. A pinned
    // 30-day window returned nothing for posts like this, which is most of an
    // established account's history.
    await analysedPost({
      hookCategory: "question",
      likes: 200,
      postAgeSeconds: 200 * 86_400,
      publishedAt: new Date("2026-06-01T00:00:00.000Z"),
    });

    const selection = await loadBestAnalyticsInputs(database, context, windowRequest());

    expect(selection?.ageWindow).toBe("mature");
    expect(selection?.inputs.posts).toHaveLength(1);
  });

  it("reads every analysed post when no matched window holds them all", async () => {
    for (let index = 0; index < 3; index += 1) {
      await analysedPost({
        hookCategory: "question",
        likes: 100 + index,
        postAgeSeconds: 30 * 86_400,
        publishedAt: new Date(Date.UTC(2026, 5, 1 + index * 8)),
      });
    }
    await analysedPost({
      hookCategory: "claim",
      likes: 300,
      postAgeSeconds: 200 * 86_400,
      publishedAt: new Date("2026-06-02T00:00:00.000Z"),
    });

    const selection = await loadBestAnalyticsInputs(database, context, windowRequest());

    // Neither matched window can compare: day_30 holds three of the four and
    // mature holds the fourth, and three is below the floor. `lifetime` sees
    // one more post than the best of them, so it wins — an analysed post that
    // no window can reach is a post the account never sees a trend for.
    expect(selection?.ageWindow).toBe("lifetime");
    expect(selection?.inputs.posts).toHaveLength(4);
  });

  it("reports what every candidate window would have measured", async () => {
    await analysedPost({
      hookCategory: "question",
      likes: 200,
      postAgeSeconds: 200 * 86_400,
      publishedAt: new Date("2026-06-01T00:00:00.000Z"),
    });

    const selection = await loadBestAnalyticsInputs(database, context, windowRequest());

    // A run that publishes a different window than the last one changes what the
    // dashboard means, so the alternatives are recorded rather than inferred.
    expect(selection?.considered).toEqual([
      { ageWindow: "day_7", eligiblePosts: 0 },
      { ageWindow: "day_30", eligiblePosts: 0 },
      { ageWindow: "mature", eligiblePosts: 1 },
      { ageWindow: "lifetime", eligiblePosts: 1 },
    ]);
  });

  it("does not carry a snapshot across a window boundary", async () => {
    // One read spans every candidate, so each window has to reject what falls
    // outside its own edges rather than trusting the query.
    await analysedPost({
      hookCategory: "question",
      likes: 200,
      postAgeSeconds: 30 * 86_400,
      publishedAt: new Date("2026-06-01T00:00:00.000Z"),
    });

    const selection = await loadBestAnalyticsInputs(database, context, windowRequest());
    const mature = selection?.considered.find((entry) => entry.ageWindow === "mature");

    expect(selection?.ageWindow).toBe("day_30");
    expect(mature?.eligiblePosts).toBe(0);
  });

  it("still reads a post too young for any matched window", async () => {
    await analysedPost({
      hookCategory: "question",
      likes: 200,
      // An hour old: outside every matched window's lower edge.
      postAgeSeconds: 3_600,
      publishedAt: new Date("2026-06-01T00:00:00.000Z"),
    });

    const selection = await loadBestAnalyticsInputs(database, context, windowRequest());

    // The observation exists, so something can be said from it. What cannot be
    // said is that it was compared at a matched age, and publishing under
    // `lifetime` is how the run records that.
    expect(selection?.ageWindow).toBe("lifetime");
    expect(selection?.inputs.posts).toHaveLength(1);
  });

  it("returns nothing when a post has never been observed", async () => {
    // Analysed but never captured. `lifetime` admits an observation of any age,
    // so this is the only remaining state in which no window measures anything.
    await analysedPost({
      hookCategory: "question",
      likes: 200,
      publishedAt: new Date("2026-06-01T00:00:00.000Z"),
      snapshot: false,
    });

    await expect(loadBestAnalyticsInputs(database, context, windowRequest())).resolves.toBeNull();
  });
});

describe("reading a run's inputs", () => {
  it("reads only posts whose current analysis is eligible", async () => {
    await analysedPost({
      hookCategory: "question",
      likes: 200,
      publishedAt: new Date("2026-06-01T00:00:00.000Z"),
    });
    const excluded = await analysedPost({
      hookCategory: "claim",
      likes: 100,
      publishedAt: new Date("2026-06-09T00:00:00.000Z"),
    });

    await database.postAnalysis.updateMany({
      data: { analyticsEligible: false },
      where: { instagramPostId: excluded },
    });

    const inputs = await loadAnalyticsInputs(database, context, inputRequest());

    // An analysis the model was not confident enough to group by never reaches a
    // comparison at all, rather than being filtered out later.
    expect(inputs.posts).toHaveLength(1);
  });

  it("counts a post with no feature value as missing rather than dropping it", async () => {
    for (let index = 0; index < 4; index += 1) {
      await analysedPost({
        hookCategory: index < 2 ? "question" : "claim",
        likes: 100 + index,
        publishedAt: new Date(Date.UTC(2026, 5, 1 + index * 8)),
      });
    }
    await analysedPost({
      hookCategory: null,
      likes: 150,
      publishedAt: new Date("2026-06-25T00:00:00.000Z"),
    });

    const inputs = await loadAnalyticsInputs(database, context, inputRequest());
    const families = buildFeatureRequests(inputRequest(), inputs);
    const hooks = families[0]?.candidates.filter(
      (candidate) => candidate.featurePath === "content.hook.category",
    );

    expect(inputs.posts).toHaveLength(5);
    // The unclassifiable post is on neither side but is counted, so "no pattern"
    // stays distinguishable from "we could not see most of these posts".
    expect(hooks?.[0]?.missingCount).toBe(1);
    expect((hooks?.[0]?.group.length ?? 0) + (hooks?.[0]?.comparison.length ?? 0)).toBe(4);
  });

  it("does not compare a feature that only has one value", async () => {
    for (let index = 0; index < 3; index += 1) {
      await analysedPost({
        hookCategory: "question",
        likes: 100 + index,
        publishedAt: new Date(Date.UTC(2026, 5, 1 + index * 8)),
      });
    }

    const inputs = await loadAnalyticsInputs(database, context, inputRequest());
    const families = buildFeatureRequests(inputRequest(), inputs);

    // One value describes the account rather than comparing anything: the
    // comparison side would be empty and the result meaningless, not weak.
    for (const family of families) {
      for (const candidate of family.candidates) {
        expect(candidate.featurePath).not.toBe("content.hook.category");
      }
    }
  });
});

async function seedPosts(): Promise<void> {
  for (let index = 0; index < 8; index += 1) {
    await analysedPost({
      hookCategory: index < 4 ? "question" : "claim",
      likes: index < 4 ? 200 + index : 100 + index,
      publishedAt: new Date(Date.UTC(2026, 4, 1 + index * 8)),
    });
  }
}

async function runOnce(now: Date): Promise<Readonly<{ activated: boolean; runId: string }>> {
  const dirtySince = (
    await database.instagramAccount.findFirstOrThrow({ where: { id: accountId } })
  ).analyticsDirtySince as Date;

  const inputs = await loadAnalyticsInputs(database, context, inputRequest());
  const inputFingerprint = createRunInputFingerprint({
    analysisIds: inputs.analysisIds,
    snapshotIds: inputs.snapshotIds,
  });

  const run = await startAnalyticsRun(database, context, {
    ageWindow: "day_30",
    analysisCount: inputs.posts.length,
    inputFingerprint,
    instagramAccountId: accountId,
    now,
    publishedFrom,
    publishedTo,
  });

  const expectedStatisticCount = await calculateInto(run.id);
  const result = await activateAnalyticsRun(database, context, {
    dirtySince,
    expectedStatisticCount,
    inputFingerprint,
    instagramAccountId: accountId,
    now,
    runId: run.id,
  });

  return { activated: result.activated, runId: run.id };
}

describe("publishing a run", () => {
  it("publishes a complete set and clears the marker", async () => {
    await seedPosts();
    await markAnalyticsDirty(database, context, {
      instagramAccountId: accountId,
      now: calculatedAt,
    });

    const first = await runOnce(calculatedAt);
    expect(first.activated).toBe(true);

    const active = await findActiveAnalyticsRun(database, context, accountId);
    expect(active?.id).toBe(first.runId);
    expect(active?.statisticCount).toBeGreaterThan(0);

    const published = await database.accountAnalyticsRunStatistic.count({
      where: { runId: first.runId },
    });
    expect(published).toBe(active?.statisticCount);

    await expect(
      database.instagramAccount.findFirstOrThrow({ where: { id: accountId } }),
    ).resolves.toMatchObject({ analyticsDirtySince: null, analyticsDueAt: null });
  });

  it("publishes the complete set again when nothing changed", async () => {
    // The case that matters. A second run over unchanged inputs collapses onto
    // the first run's rows, so it writes almost nothing. Counting what it wrote
    // made it refuse to publish and left the account permanently stale.
    await seedPosts();
    await markAnalyticsDirty(database, context, {
      instagramAccountId: accountId,
      now: calculatedAt,
    });

    const first = await runOnce(calculatedAt);
    await markAnalyticsDirty(database, context, {
      instagramAccountId: accountId,
      now: new Date(calculatedAt.getTime() + 60_000),
    });
    const second = await runOnce(new Date(calculatedAt.getTime() + 120_000));

    expect(second.activated).toBe(true);

    const [firstCount, secondCount] = await Promise.all([
      database.accountAnalyticsRunStatistic.count({ where: { runId: first.runId } }),
      database.accountAnalyticsRunStatistic.count({ where: { runId: second.runId } }),
    ]);

    expect(secondCount).toBe(firstCount);
    // Republished, not rewritten: a statistic a strategy cited keeps meaning
    // what it meant.
    expect(
      await database.accountFeatureStatistic.count({ where: { calculationRunId: second.runId } }),
    ).toBe(0);
  });

  it("supersedes the previous run rather than leaving two current", async () => {
    await seedPosts();
    await markAnalyticsDirty(database, context, {
      instagramAccountId: accountId,
      now: calculatedAt,
    });

    const first = await runOnce(calculatedAt);
    await markAnalyticsDirty(database, context, {
      instagramAccountId: accountId,
      now: new Date(calculatedAt.getTime() + 60_000),
    });
    const second = await runOnce(new Date(calculatedAt.getTime() + 120_000));

    await expect(
      database.accountAnalyticsRun.findFirstOrThrow({ where: { id: first.runId } }),
    ).resolves.toMatchObject({ state: "SUPERSEDED" });
    await expect(
      database.accountAnalyticsRun.count({
        where: { instagramAccountId: accountId, state: "ACTIVE" },
      }),
    ).resolves.toBe(1);

    const active = await findActiveAnalyticsRun(database, context, accountId);
    expect(active?.id).toBe(second.runId);
  });

  it("refuses a run whose inputs moved while it was building", async () => {
    await seedPosts();
    await markAnalyticsDirty(database, context, {
      instagramAccountId: accountId,
      now: calculatedAt,
    });

    const run = await startAnalyticsRun(database, context, {
      ageWindow: "day_30",
      analysisCount: 8,
      inputFingerprint: "1".repeat(64),
      instagramAccountId: accountId,
      now: calculatedAt,
      publishedFrom,
      publishedTo,
    });

    const result = await activateAnalyticsRun(database, context, {
      dirtySince: calculatedAt,
      expectedStatisticCount: 0,
      // A different fingerprint is what a mid-calculation change looks like.
      inputFingerprint: "2".repeat(64),
      instagramAccountId: accountId,
      now: calculatedAt,
      runId: run.id,
    });

    expect(result).toEqual({ activated: false, reason: "INPUTS_CHANGED" });
    await expect(
      database.accountAnalyticsRun.findFirstOrThrow({ where: { id: run.id } }),
    ).resolves.toMatchObject({ failureCode: "INPUTS_CHANGED", state: "FAILED" });
    // Nothing was published, so a reader still sees whatever was current.
    await expect(findActiveAnalyticsRun(database, context, accountId)).resolves.toBeNull();
  });

  it("keeps the previous set current when a run fails", async () => {
    await seedPosts();
    await markAnalyticsDirty(database, context, {
      instagramAccountId: accountId,
      now: calculatedAt,
    });

    const first = await runOnce(calculatedAt);

    const failing = await startAnalyticsRun(database, context, {
      ageWindow: "day_30",
      analysisCount: 8,
      inputFingerprint: "1".repeat(64),
      instagramAccountId: accountId,
      now: new Date(calculatedAt.getTime() + 60_000),
      publishedFrom,
      publishedTo,
    });

    await activateAnalyticsRun(database, context, {
      dirtySince: calculatedAt,
      expectedStatisticCount: 99,
      inputFingerprint: "2".repeat(64),
      instagramAccountId: accountId,
      now: new Date(calculatedAt.getTime() + 60_000),
      runId: failing.id,
    });

    // A failure must not leave readers with nothing.
    const active = await findActiveAnalyticsRun(database, context, accountId);
    expect(active?.id).toBe(first.runId);
  });

  it("leaves the account dirty when a change arrived mid-calculation", async () => {
    await seedPosts();
    await markAnalyticsDirty(database, context, {
      instagramAccountId: accountId,
      now: calculatedAt,
    });

    const dirtySince = calculatedAt;
    const inputs = await loadAnalyticsInputs(database, context, inputRequest());
    const inputFingerprint = createRunInputFingerprint({
      analysisIds: inputs.analysisIds,
      snapshotIds: inputs.snapshotIds,
    });
    const run = await startAnalyticsRun(database, context, {
      ageWindow: "day_30",
      analysisCount: inputs.posts.length,
      inputFingerprint,
      instagramAccountId: accountId,
      now: calculatedAt,
      publishedFrom,
      publishedTo,
    });
    const expectedStatisticCount = await calculateInto(run.id);

    // The change lands while the run is building. Its marker moves, so the
    // activation is not allowed to clear it.
    const moved = new Date(calculatedAt.getTime() + 30_000);
    await database.instagramAccount.updateMany({
      data: { analyticsDirtySince: moved, analyticsDueAt: moved },
      where: { id: accountId },
    });

    const result = await activateAnalyticsRun(database, context, {
      dirtySince,
      expectedStatisticCount,
      inputFingerprint,
      instagramAccountId: accountId,
      now: moved,
      runId: run.id,
    });

    expect(result.activated).toBe(true);
    // Published, and still dirty: the next sweep picks the change up rather than
    // losing it.
    await expect(
      database.instagramAccount.findFirstOrThrow({ where: { id: accountId } }),
    ).resolves.toMatchObject({ analyticsDirtySince: moved });
  });

  it("is invisible to another workspace", async () => {
    await seedPosts();
    await markAnalyticsDirty(database, context, {
      instagramAccountId: accountId,
      now: calculatedAt,
    });
    await runOnce(calculatedAt);

    await expect(
      findActiveAnalyticsRun(database, createWorkspaceContext(createId()), accountId),
    ).resolves.toBeNull();
  });
});

describe("reading published trends", () => {
  async function publish(now = calculatedAt): Promise<string> {
    await seedPosts();
    await markAnalyticsDirty(database, context, { instagramAccountId: accountId, now });
    const result = await runOnce(now);
    expect(result.activated).toBe(true);

    return result.runId;
  }

  it("returns the active run's complete set", async () => {
    const runId = await publish();
    const list = await loadAccountTrends(database, context, { instagramAccountId: accountId });

    expect(list.calculation?.id).toBe(runId);
    expect(list.trends.length).toBe(list.calculation?.statisticCount);
    expect(list.trends.length).toBeGreaterThan(0);
  });

  it("shows nothing before anything has been published", async () => {
    // A newly connected account genuinely has no statistics. That is a state the
    // screen explains, not an error, so the calculation is null rather than a
    // throw or an empty run.
    const list = await loadAccountTrends(database, context, { instagramAccountId: accountId });

    expect(list.calculation).toBeNull();
    expect(list.trends).toHaveLength(0);
  });

  it("never mixes a superseded run's statistics into the current set", async () => {
    // The table holds every row every run ever wrote. Reading it directly would
    // pair a current statistic with a superseded one and present the two as a
    // set, which is exactly what atomic publication exists to prevent.
    const firstRunId = await publish();

    await analysedPost({
      hookCategory: "story",
      likes: 900,
      publishedAt: new Date(Date.UTC(2026, 6, 1)),
    });
    await markAnalyticsDirty(database, context, {
      instagramAccountId: accountId,
      now: new Date(calculatedAt.getTime() + 60_000),
    });
    const second = await runOnce(new Date(calculatedAt.getTime() + 120_000));

    const list = await loadAccountTrends(database, context, { instagramAccountId: accountId });
    const publishedByFirst = await database.accountAnalyticsRunStatistic.findMany({
      select: { statisticId: true },
      where: { runId: firstRunId },
    });
    const publishedBySecond = new Set(list.trends.map((trend) => trend.id));

    expect(list.calculation?.id).toBe(second.runId);
    // Rows the first run published and the second did not must be absent, even
    // though they are still in the statistics table.
    const dropped = publishedByFirst.filter((row) => !publishedBySecond.has(row.statisticId));
    expect(dropped.length).toBeGreaterThan(0);
    expect(list.trends.length).toBeGreaterThan(0);
  });

  it("narrows to a metric, a feature and a confidence class", async () => {
    await publish();

    const byMetric = await loadAccountTrends(database, context, {
      instagramAccountId: accountId,
      metric: "like_rate_reach",
    });
    expect(byMetric.trends.every((trend) => trend.metric === "like_rate_reach")).toBe(true);
    expect(byMetric.trends.length).toBeGreaterThan(0);

    const byFeature = await loadAccountTrends(database, context, {
      featurePath: "content.hook.category",
      instagramAccountId: accountId,
    });
    expect(byFeature.trends.every((trend) => trend.featurePath === "content.hook.category")).toBe(
      true,
    );

    const byConfidence = await loadAccountTrends(database, context, {
      confidence: "insufficient_evidence",
      instagramAccountId: accountId,
    });
    expect(byConfidence.trends.every((trend) => trend.confidence === "insufficient_evidence")).toBe(
      true,
    );
  });

  it("returns an empty set rather than everything for an invalid filter", async () => {
    await publish();

    const list = await loadAccountTrends(database, context, {
      instagramAccountId: accountId,
      matchesNothing: true,
    });

    expect(list.trends).toHaveLength(0);
    expect(list.calculation).toBeNull();
  });

  it("resolves one trend with the posts on both sides", async () => {
    await publish();
    const list = await loadAccountTrends(database, context, { instagramAccountId: accountId });
    const target = list.trends.find((trend) => trend.groupCount > 0 && trend.comparisonCount > 0);

    const detail = await loadTrendDetail(database, context, {
      instagramAccountId: accountId,
      statisticId: target?.id as string,
    });

    expect(detail?.trend.id).toBe(target?.id);
    expect(detail?.contributors.filter((post) => post.membership === "group")).toHaveLength(
      target?.groupCount as number,
    );
    // Both sides, so a positive claim cannot hide its own counterexamples.
    expect(detail?.contributors.filter((post) => post.membership === "comparison")).toHaveLength(
      target?.comparisonCount as number,
    );
  });

  it("does not resolve a statistic the active run stopped publishing", async () => {
    const firstRunId = await publish();

    await analysedPost({
      hookCategory: "story",
      likes: 900,
      publishedAt: new Date(Date.UTC(2026, 6, 1)),
    });
    await markAnalyticsDirty(database, context, {
      instagramAccountId: accountId,
      now: new Date(calculatedAt.getTime() + 60_000),
    });
    await runOnce(new Date(calculatedAt.getTime() + 120_000));

    const current = new Set(
      (await loadAccountTrends(database, context, { instagramAccountId: accountId })).trends.map(
        (trend) => trend.id,
      ),
    );
    const superseded = (
      await database.accountAnalyticsRunStatistic.findMany({
        select: { statisticId: true },
        where: { runId: firstRunId },
      })
    ).find((row) => !current.has(row.statisticId));

    // A link to a superseded statistic reads as absent rather than silently
    // showing a reader an old result at a current-looking URL.
    await expect(
      loadTrendDetail(database, context, {
        instagramAccountId: accountId,
        statisticId: superseded?.statisticId as string,
      }),
    ).resolves.toBeNull();
  });

  it("is invisible to another workspace", async () => {
    await publish();
    const other = createWorkspaceContext(createId());

    await expect(
      loadAccountTrends(database, other, { instagramAccountId: accountId }),
    ).resolves.toMatchObject({ calculation: null });
  });

  it("offers only the feature paths the published run produced", async () => {
    await publish();

    const paths = await listTrendFeaturePaths(database, context, accountId);

    expect(paths).toContain("content.hook.category");
    // Every post in the fixture is 30 seconds, so duration has one value and was
    // never compared. Offering it would lead a reader to an empty screen.
    expect(paths).not.toContain("content.durationBand");
  });
});
