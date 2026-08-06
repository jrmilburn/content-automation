import { loadDatabaseConfig } from "@studio-parallel/config";
import {
  createStrategyManifestHash,
  type InstagramMetricObservation,
} from "@studio-parallel/domain";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { buildFeatureRequests, loadAnalyticsInputs } from "../../src/analytics-features.js";
import {
  activateAnalyticsRun,
  analyticsDebounceMs,
  startAnalyticsRun,
} from "../../src/analytics-runs.js";
import { createDatabaseClient, type DatabaseClient } from "../../src/client.js";
import { calculateFeatureFamily, storeFeatureStatistics } from "../../src/feature-statistics.js";
import { createId } from "../../src/id.js";
import { recordInstagramMetricSnapshot } from "../../src/instagram-insights.js";
import { developmentWorkspace } from "../../src/seed-data.js";
import {
  buildStrategyManifest,
  loadStrategyEvidenceCandidates,
} from "../../src/strategy-evidence.js";
import {
  listStrategyGenerations,
  loadCurrentStrategy,
  loadStrategyGeneration,
} from "../../src/strategy-read.js";
import {
  previewStrategyRequest,
  requestStrategyGeneration,
} from "../../src/strategy-request-command.js";
import { createWorkspaceContext } from "../../src/workspace-context.js";

/**
 * Freezing a strategy's evidence, end to end against real SQL.
 *
 * Four things need a database. A refused request must leave no background job at
 * all, which is a statement about rows rather than about a return value. A
 * duplicate submit must collapse and an explicit regeneration must not, and both
 * are enforced by unique indexes rather than by the caller. The manifest's
 * deduplication is a partial unique index, so a ranking bug has to surface as an
 * insert failure. And a frozen statistic must be undeletable while a strategy
 * still cites it, which only a real foreign key can prove.
 */

const databaseConfig = loadDatabaseConfig();
let database: DatabaseClient;

const context = createWorkspaceContext(developmentWorkspace.id);
const publishedFrom = new Date("2026-01-01T00:00:00.000Z");
const publishedTo = new Date("2026-07-31T00:00:00.000Z");
const calculatedAt = new Date("2026-08-03T06:00:00.000Z");
const uploaderId = "01900000-0000-7000-8000-0000000004a1";

let accountId: string;

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
  await database.strategyEvidence.deleteMany();
  // The current-strategy pointer restricts deleting the generation it points
  // at, the same way the current-analysis pointer does below. Nothing here
  // publishes a strategy yet, so this is not load-bearing today — but it will
  // be the moment a test exercises the worker, and finding out then costs a CI
  // round trip.
  await database.instagramAccount.updateMany({ data: { currentStrategyId: null }, where: {} });
  await database.strategyGeneration.deleteMany();
  await database.accountAnalyticsRunStatistic.deleteMany();
  await database.accountFeatureStatisticPost.deleteMany();
  await database.accountFeatureStatistic.deleteMany();
  await database.accountAnalyticsRun.deleteMany();
  await database.instagramPost.updateMany({ data: { currentAnalysisId: null }, where: {} });
  await database.postAnalysis.deleteMany();
  await database.analysisJob.deleteMany();
  await database.videoAsset.deleteMany();
  await database.videoUploadIntent.deleteMany();
  await database.instagramMetricSnapshot.deleteMany();
  await database.instagramPost.deleteMany();
  // Before the jobs themselves. Requesting a strategy enqueues through the
  // outbox, so unlike fixtures that insert a job row directly this one leaves
  // rows that hold a foreign key to it.
  await database.jobOutbox.deleteMany();
  await database.backgroundJob.deleteMany();
  await database.instagramAccount.deleteMany();
}

/**
 * The user an upload intent records.
 *
 * Upserted rather than assumed. Several integration files clear
 * `internal_users` wholesale, so whether the seeded user still exists depends on
 * the order vitest happens to run files in — and this file sorts after those.
 * Depending on that order is how a fixture passes locally and fails in CI.
 */
async function ensureUploader(): Promise<void> {
  await database.internalUser.upsert({
    create: {
      email: `strategy-${uploaderId}@studioparallel.invalid`,
      id: uploaderId,
      role: "ADMIN",
      workspaceId: developmentWorkspace.id,
    },
    update: {},
    where: { workspaceId_id: { id: uploaderId, workspaceId: developmentWorkspace.id } },
  });
}

async function createAccount(username = "studioparallel"): Promise<string> {
  const id = createId();
  await database.instagramAccount.create({
    data: {
      accountType: "BUSINESS",
      apiVersion: "v25.0",
      connectionStatus: "ACTIVE",
      grantedScopes: ["instagram_business_basic"],
      id,
      providerAccountId: `1784140000000${String(Math.floor(Math.random() * 9000) + 1000)}`,
      username,
      workspaceId: developmentWorkspace.id,
    },
  });
  return id;
}

async function analysedPost(
  input: Readonly<{
    hookCategory: string | null;
    instagramAccountId?: string;
    likes: number;
    publishedAt: Date;
  }>,
): Promise<string> {
  const postId = createId();
  const owner = input.instagramAccountId ?? accountId;
  await database.instagramPost.create({
    data: {
      firstImportedAt: input.publishedAt,
      id: postId,
      instagramAccountId: owner,
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
      contentPillar: "education",
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

  await recordInstagramMetricSnapshot(database, context, {
    apiVersion: "v25.0",
    capturedAt: new Date(input.publishedAt.getTime() + 30 * 86_400_000),
    instagramPostId: postId,
    // All four engagement components, not just likes. The primary metric here is
    // `engagement_rate_reach`, whose numerator is likes + comments + shares +
    // saves, and the contract forbids calling a partial sum engagement — so one
    // absent component makes the whole metric unavailable rather than smaller.
    // Recording only reach and likes published statistics for `like_rate_reach`
    // and none at all for the metric the manifest was asked to argue from, which
    // is why this file's frozen manifest cited no statistic.
    observations: [
      observation("reach", 1_000),
      observation("likes", input.likes),
      observation("comments", Math.max(1, Math.round(input.likes / 20))),
      observation("shares", Math.max(1, Math.round(input.likes / 40))),
      observation("saves", Math.max(1, Math.round(input.likes / 10))),
    ],
    postAgeSeconds: 30 * 86_400,
    rawPayload: { likes: input.likes },
  });

  return postId;
}

function inputRequest(owner: string = accountId) {
  return {
    ageWindow: "day_30",
    instagramAccountId: owner,
    publishedFrom,
    publishedTo,
  } as const;
}

/** Builds and publishes one calculation, the way the handler does. */
async function publishCalculation(owner: string = accountId): Promise<string> {
  // Activation clears the marker it started from, so the account has to be dirty
  // for the run to publish — which is the state a real recalculation runs in.
  const dirtySince = new Date(calculatedAt.getTime() - 60_000);
  await database.instagramAccount.updateMany({
    data: { analyticsDirtySince: dirtySince },
    where: { id: owner, workspaceId: developmentWorkspace.id },
  });

  const inputs = await loadAnalyticsInputs(database, context, inputRequest(owner));
  const families = buildFeatureRequests(inputRequest(owner), inputs);
  const run = await startAnalyticsRun(database, context, {
    ageWindow: "day_30",
    analysisCount: inputs.posts.length,
    inputFingerprint: "c".repeat(64),
    instagramAccountId: owner,
    now: calculatedAt,
    publishedFrom,
    publishedTo,
  });

  let expected = 0;
  for (const family of families) {
    expected += family.candidates.length;
    await storeFeatureStatistics(
      database,
      context,
      family,
      calculateFeatureFamily(family),
      calculatedAt,
      run.id,
    );
  }

  await activateAnalyticsRun(database, context, {
    dirtySince,
    expectedStatisticCount: expected,
    inputFingerprint: "c".repeat(64),
    instagramAccountId: owner,
    now: calculatedAt,
    runId: run.id,
  });

  return run.id;
}

/** Enough analysed posts, split across two hook values, to compare on. */
async function seedComparableAccount(): Promise<void> {
  await seedComparablePosts(accountId);
  await publishCalculation();
}

/**
 * Two accounts with history, then every calculation the scheduler would run.
 *
 * The per-account runs publish first because activation is what clears an
 * account's debounce marker, and a pooled request is refused while any account
 * it pools is owed a recalculation. That is the order the scheduler produces,
 * and seeding the pooled run alone would leave both accounts permanently dirty —
 * a state the product never actually reaches.
 */
async function seedPooledWorkspace(): Promise<string> {
  const second = await createAccount("haydenrichardsonn");
  await seedComparablePosts(accountId);
  await seedComparablePosts(second);
  await publishCalculation(accountId);
  await publishCalculation(second);
  await publishPooledCalculation();
  return second;
}

async function seedComparablePosts(owner: string): Promise<void> {
  for (let index = 0; index < 12; index += 1) {
    await analysedPost({
      hookCategory: index < 6 ? "question" : "claim",
      instagramAccountId: owner,
      likes: index < 6 ? 200 + index : 100 + index,
      publishedAt: new Date(Date.UTC(2026, 2, 1 + index * 8)),
    });
  }
}

/**
 * The pooled calculation, published the way the recalculation handler publishes
 * one: the account key is absent rather than null, from the window through to
 * activation.
 */
async function publishPooledCalculation(): Promise<string> {
  const pooledRequest = { ageWindow: "day_30", publishedFrom, publishedTo } as const;

  const inputs = await loadAnalyticsInputs(database, context, pooledRequest);
  const families = buildFeatureRequests(pooledRequest, inputs);
  const run = await startAnalyticsRun(database, context, {
    ageWindow: "day_30",
    analysisCount: inputs.posts.length,
    inputFingerprint: "d".repeat(64),
    now: calculatedAt,
    publishedFrom,
    publishedTo,
  });

  let expected = 0;
  for (const family of families) {
    expected += family.candidates.length;
    await storeFeatureStatistics(
      database,
      context,
      family,
      calculateFeatureFamily(family),
      calculatedAt,
      run.id,
    );
  }

  // A pooled run clears no debounce marker, so it passes no `dirtySince`.
  await activateAnalyticsRun(database, context, {
    expectedStatisticCount: expected,
    inputFingerprint: "d".repeat(64),
    now: calculatedAt,
    runId: run.id,
  });

  return run.id;
}

function requestInput(overrides: Record<string, unknown> = {}) {
  return {
    acceptExploratory: true,
    correlationId: createId(),
    editorialConstraint: null,
    formatEmphasis: [],
    instagramAccountId: accountId,
    pillarEmphasis: [],
    primaryMetric: "engagement_rate_reach" as const,
    requestedByUserId: null,
    ...overrides,
  };
}

beforeAll(() => {
  database = createDatabaseClient(databaseConfig.DATABASE_URL);
});

beforeEach(async () => {
  await clear();
  await ensureUploader();
  accountId = await createAccount();
});

afterAll(async () => {
  await clear();
  await database.$disconnect();
});

describe("refusing a request", () => {
  it("creates no background job when nothing is analysed", async () => {
    const outcome = await requestStrategyGeneration(database, context, requestInput());

    expect(outcome).toMatchObject({ reason: "no_analysed_posts", requested: false });
    // The literal reading of "returns no model job": no row, not merely no call.
    await expect(
      database.backgroundJob.count({ where: { queueName: "strategy.generate" } }),
    ).resolves.toBe(0);
  });

  it("creates no background job when no calculation has been published", async () => {
    await analysedPost({
      hookCategory: "question",
      likes: 200,
      publishedAt: new Date("2026-03-01T00:00:00.000Z"),
    });

    const outcome = await requestStrategyGeneration(database, context, requestInput());

    expect(outcome).toMatchObject({ requested: false });
    await expect(
      database.backgroundJob.count({ where: { queueName: "strategy.generate" } }),
    ).resolves.toBe(0);
  });

  it("refuses a metric with no comparable values rather than freezing an empty manifest", async () => {
    await seedComparableAccount();

    const outcome = await requestStrategyGeneration(
      database,
      context,
      requestInput({ primaryMetric: "views" }),
    );

    expect(outcome).toMatchObject({ reason: "metric_not_comparable", requested: false });
  });

  it("refuses while a recalculation is owed", async () => {
    await seedComparableAccount();
    // Both markers or neither: a check constraint pairs them, because a due
    // time without a dirty time is a debounce for a change that never happened.
    // Activation cleared both, so this has to set both back.
    await database.instagramAccount.updateMany({
      data: {
        analyticsDirtySince: calculatedAt,
        analyticsDueAt: new Date(calculatedAt.getTime() + analyticsDebounceMs),
      },
      where: { id: accountId },
    });

    await expect(
      requestStrategyGeneration(database, context, requestInput()),
    ).resolves.toMatchObject({ reason: "stale_calculation", requested: false });
  });

  it("reports the same counts through the preview as the request would use", async () => {
    await seedComparableAccount();

    const preview = await previewStrategyRequest(database, context, {
      acceptExploratory: true,
      instagramAccountId: accountId,
      primaryMetric: "engagement_rate_reach",
    });

    expect(preview.analysedPostCount).toBe(12);
    expect(preview.ageWindow).toBe("day_30");
    expect(preview.reason).toBeNull();
  });
});

describe("freezing a manifest", () => {
  it("writes the generation, its evidence and its job in one transaction", async () => {
    await seedComparableAccount();

    const outcome = await requestStrategyGeneration(database, context, requestInput());
    if (!outcome.requested) throw new Error(`refused: ${outcome.reason}`);

    const generation = await database.strategyGeneration.findFirstOrThrow({
      where: { id: outcome.strategyGenerationId },
    });
    const evidence = await database.strategyEvidence.findMany({
      where: { strategyGenerationId: outcome.strategyGenerationId },
    });

    expect(evidence.length).toBeGreaterThan(0);
    expect(generation.evidenceCount).toBe(evidence.length);
    expect(generation.manifestHash).toBe(outcome.manifestHash);
    await expect(
      database.backgroundJob.count({ where: { queueName: "strategy.generate" } }),
    ).resolves.toBe(1);
  });

  it("pins the generation to the calculation its statistics came from", async () => {
    await seedComparableAccount();
    const activeRun = await database.accountAnalyticsRun.findFirstOrThrow({
      where: { state: "ACTIVE" },
    });

    const outcome = await requestStrategyGeneration(database, context, requestInput());
    if (!outcome.requested) throw new Error(`refused: ${outcome.reason}`);

    const generation = await database.strategyGeneration.findFirstOrThrow({
      where: { id: outcome.strategyGenerationId },
    });

    // Without this, "which numbers did this strategy see" would only be
    // answerable by guessing from timestamps.
    expect(generation.analyticsRunId).toBe(activeRun.id);
    expect(generation.publishedFrom.toISOString()).toBe(activeRun.publishedFrom.toISOString());
  });

  it("collapses a duplicate submit onto one job and one generation", async () => {
    await seedComparableAccount();

    const first = await requestStrategyGeneration(database, context, requestInput());
    const second = await requestStrategyGeneration(database, context, requestInput());
    if (!first.requested || !second.requested) throw new Error("expected both to be requested");

    expect(second.strategyGenerationId).toBe(first.strategyGenerationId);
    expect(second.created).toBe(false);
    await expect(database.strategyGeneration.count()).resolves.toBe(1);
    await expect(
      database.backgroundJob.count({ where: { queueName: "strategy.generate" } }),
    ).resolves.toBe(1);
  });

  it("gives an explicit regeneration its own history over unchanged evidence", async () => {
    await seedComparableAccount();

    const first = await requestStrategyGeneration(database, context, requestInput());
    if (!first.requested) throw new Error("expected a request");

    const again = await requestStrategyGeneration(
      database,
      context,
      requestInput({ regeneratedFromId: first.strategyGenerationId }),
    );
    if (!again.requested) throw new Error("expected a regeneration");

    // Same evidence, so the same manifest hash — but a different question.
    expect(again.manifestHash).toBe(first.manifestHash);
    expect(again.strategyGenerationId).not.toBe(first.strategyGenerationId);
    await expect(database.strategyGeneration.count()).resolves.toBe(2);
  });

  it("produces the same hash when the same evidence is read again", async () => {
    await seedComparableAccount();

    const one = await loadStrategyEvidenceCandidates(database, context, {
      formatEmphasis: [],
      instagramAccountId: accountId,
      pillarEmphasis: [],
      primaryMetric: "engagement_rate_reach",
    });
    const other = await loadStrategyEvidenceCandidates(database, context, {
      formatEmphasis: [],
      instagramAccountId: accountId,
      pillarEmphasis: [],
      primaryMetric: "engagement_rate_reach",
    });
    if (!one || !other) throw new Error("expected candidates");

    const build = (loaded: typeof one) =>
      buildStrategyManifest(loaded, {
        editorialConstraint: null,
        formatEmphasis: [],
        instagramAccountId: accountId,
        mode: "evidence_led",
        pillarEmphasis: [],
        primaryMetric: "engagement_rate_reach",
      });

    expect(build(one).manifestHash).toBe(build(other).manifestHash);
    expect(createStrategyManifestHash(build(one).identity, build(one).entries)).toBe(
      build(other).manifestHash,
    );
  });

  it("selects only evidence belonging to the requested account", async () => {
    await seedComparableAccount();
    const otherAccountId = accountId;
    accountId = await createAccount();
    await seedComparableAccount();

    const outcome = await requestStrategyGeneration(database, context, requestInput());
    if (!outcome.requested) throw new Error(`refused: ${outcome.reason}`);

    const statisticIds = await database.strategyEvidence.findMany({
      select: { featureStatisticId: true },
      where: {
        featureStatisticId: { not: null },
        strategyGenerationId: outcome.strategyGenerationId,
      },
    });

    for (const row of statisticIds) {
      const statistic = await database.accountFeatureStatistic.findFirstOrThrow({
        where: { id: row.featureStatisticId ?? "" },
      });
      expect(statistic.instagramAccountId).toBe(accountId);
      expect(statistic.instagramAccountId).not.toBe(otherAccountId);
    }
  });
});

describe("the frozen manifest's own guarantees", () => {
  it("refuses a second entry for the same opaque key", async () => {
    await seedComparableAccount();
    const outcome = await requestStrategyGeneration(database, context, requestInput());
    if (!outcome.requested) throw new Error(`refused: ${outcome.reason}`);

    const existing = await database.strategyEvidence.findFirstOrThrow({
      where: { strategyGenerationId: outcome.strategyGenerationId },
    });

    // A ranking bug has to surface as an insert failure rather than as an
    // ambiguous citation the model could resolve either way.
    await expect(
      database.strategyEvidence.create({
        data: {
          allowedNumericClaims: [],
          allowedRoles: ["context"],
          category: existing.category,
          dimensions: [],
          evidenceKey: existing.evidenceKey,
          evidenceType: "DATA_QUALITY",
          id: createId(),
          rank: 99,
          retrievalReason: "duplicate_probe",
          strategyGenerationId: outcome.strategyGenerationId,
          summaryHash: "d".repeat(64),
          summaryText: "duplicate probe",
          workspaceId: developmentWorkspace.id,
        },
      }),
    ).rejects.toThrow();
  });

  it("refuses to delete a statistic a frozen manifest still cites", async () => {
    await seedComparableAccount();
    const outcome = await requestStrategyGeneration(database, context, requestInput());
    if (!outcome.requested) throw new Error(`refused: ${outcome.reason}`);

    // Asserted with the published metrics beside it, rather than thrown. The
    // previous message named the symptom and nothing else, and the real cause —
    // no statistic published for the requested metric at all — took several
    // rounds to find from the outside.
    const frozen = await database.strategyEvidence.findMany({
      select: { evidenceType: true, featureStatisticId: true },
      where: { strategyGenerationId: outcome.strategyGenerationId },
    });
    const published = await database.accountFeatureStatistic.findMany({
      select: { metric: true },
    });

    expect({
      citedTypes: [...new Set(frozen.map((row) => row.evidenceType))].sort(),
      publishedMetrics: [...new Set(published.map((row) => row.metric))].sort(),
    }).toMatchObject({ citedTypes: expect.arrayContaining(["FEATURE_STATISTIC"]) });

    const cited = frozen.find((row) => row.featureStatisticId !== null);
    if (!cited?.featureStatisticId) throw new Error("unreachable: asserted above");

    // Removal must not silently retarget the evidence link a strategy depends on.
    await expect(
      database.accountFeatureStatistic.delete({ where: { id: cited.featureStatisticId } }),
    ).rejects.toThrow();
  });

  it("hands the reader the manifest a generation was frozen against", async () => {
    await seedComparableAccount();
    const outcome = await requestStrategyGeneration(database, context, requestInput());
    if (!outcome.requested) throw new Error(`refused: ${outcome.reason}`);

    const generation = await database.strategyGeneration.findFirstOrThrow({
      where: { id: outcome.strategyGenerationId },
    });
    const detail = await loadStrategyGeneration(database, context, outcome.strategyGenerationId);

    // The screen resolves a cited id through this list, so an entry missing here
    // renders as a tombstone on a claim whose evidence is in fact still there.
    expect(detail?.evidence.length).toBe(generation.evidenceCount);
    const statistic = detail?.evidence.find((entry) => entry.evidenceType === "feature_statistic");
    expect(statistic?.referenceId).not.toBeNull();
  });

  it("carries no caption or object key into the frozen summaries", async () => {
    await seedComparableAccount();
    const outcome = await requestStrategyGeneration(database, context, requestInput());
    if (!outcome.requested) throw new Error(`refused: ${outcome.reason}`);

    const evidence = await database.strategyEvidence.findMany({
      select: { summaryText: true },
      where: { strategyGenerationId: outcome.strategyGenerationId },
    });

    for (const row of evidence) {
      expect(row.summaryText).not.toMatch(/source-video|production\/|caption/iu);
    }
  });
});

/**
 * What a reader of another workspace sees, which must be nothing.
 *
 * Every case pairs a real id with a foreign workspace context. That is the shape
 * a crafted identifier actually takes: the attacker has a valid id — from a
 * screenshot, a shared link, a former membership — and the only thing standing
 * between them and the row is the `where` clause.
 */
describe("reading a strategy from another workspace", () => {
  it("returns nothing for a real generation id under a foreign workspace", async () => {
    await seedComparableAccount();
    const outcome = await requestStrategyGeneration(database, context, requestInput());
    if (!outcome.requested) throw new Error(`refused: ${outcome.reason}`);

    const intruder = createWorkspaceContext(createId());

    // Null rather than a thrown error, so a crafted id cannot be told apart from
    // one that never existed by watching which failure comes back.
    await expect(
      loadStrategyGeneration(database, intruder, outcome.strategyGenerationId),
    ).resolves.toBeNull();
    await expect(
      loadStrategyGeneration(database, context, outcome.strategyGenerationId),
    ).resolves.not.toBeNull();
  });

  it("returns no history for a real account id under a foreign workspace", async () => {
    await seedComparableAccount();
    const outcome = await requestStrategyGeneration(database, context, requestInput());
    if (!outcome.requested) throw new Error(`refused: ${outcome.reason}`);

    const intruder = createWorkspaceContext(createId());

    await expect(
      listStrategyGenerations(database, intruder, { instagramAccountId: accountId }),
    ).resolves.toEqual([]);
    await expect(
      listStrategyGenerations(database, context, { instagramAccountId: accountId }),
    ).resolves.toHaveLength(1);
  });

  it("returns no current strategy for a real account id under a foreign workspace", async () => {
    await seedComparableAccount();
    const outcome = await requestStrategyGeneration(database, context, requestInput());
    if (!outcome.requested) throw new Error(`refused: ${outcome.reason}`);

    await database.instagramAccount.updateMany({
      data: { currentStrategyId: outcome.strategyGenerationId },
      where: { id: accountId, workspaceId: developmentWorkspace.id },
    });
    const intruder = createWorkspaceContext(createId());

    await expect(loadCurrentStrategy(database, intruder, accountId)).resolves.toBeNull();
    await expect(loadCurrentStrategy(database, context, accountId)).resolves.not.toBeNull();
  });

  it("does not read a foreign workspace's evidence onto a strategy it can see", async () => {
    // The manifest is a second query. Scoping the generation but not its
    // evidence would leak the summaries while the strategy itself stayed hidden.
    await seedComparableAccount();
    const outcome = await requestStrategyGeneration(database, context, requestInput());
    if (!outcome.requested) throw new Error(`refused: ${outcome.reason}`);

    const intruder = createWorkspaceContext(createId());

    await expect(
      database.strategyEvidence.count({
        where: {
          strategyGenerationId: outcome.strategyGenerationId,
          workspaceId: intruder.workspaceId,
        },
      }),
    ).resolves.toBe(0);
  });
});

/**
 * A strategy about every linked account, rather than about one of them.
 *
 * These need a database because the whole question is which rows a pooled
 * request actually selects. The scope column takes a null, the posts query has
 * to drop its account bound rather than match null against a NOT NULL column,
 * and the generation has to be written with no account connected at all — none
 * of which a stub can be wrong about in the same way SQL can.
 */
describe("pooling every linked account", () => {
  it("draws its evidence from the posts of every account, not the first", async () => {
    await seedPooledWorkspace();

    const loaded = await loadStrategyEvidenceCandidates(database, context, {
      formatEmphasis: [],
      instagramAccountId: null,
      pillarEmphasis: [],
      primaryMetric: "engagement_rate_reach",
    });

    if (loaded === null) throw new Error("expected the pooled calculation to be readable");

    // Twenty-four posts exist and both accounts published twelve. Matching the
    // null against `instagram_posts.instagram_account_id` — a NOT NULL column —
    // would have returned none of them, and the screen would have read that as
    // an account with no history rather than as a query that could never match.
    expect(loaded.counts.analysedPostCount).toBeGreaterThan(12);

    const owners = await database.instagramPost.findMany({
      distinct: ["instagramAccountId"],
      select: { instagramAccountId: true },
      where: { workspaceId: developmentWorkspace.id },
    });
    expect(owners).toHaveLength(2);
  });

  it("freezes a generation that belongs to no account and names the workspace as its resource", async () => {
    await seedPooledWorkspace();

    const outcome = await requestStrategyGeneration(
      database,
      context,
      requestInput({ instagramAccountId: null }),
    );
    if (!outcome.requested) throw new Error(`refused: ${outcome.reason}`);

    const generation = await database.strategyGeneration.findFirstOrThrow({
      where: { id: outcome.strategyGenerationId },
    });

    expect(generation.instagramAccountId).toBeNull();

    const job = await database.backgroundJob.findFirstOrThrow({
      where: { queueName: "strategy.generate" },
    });

    // The workspace, because the pooled scope has no account row to point at.
    // An account-typed resource holding a workspace id would route the job as
    // though the workspace were one of the accounts it pools.
    expect(job.resourceType).toBe("workspace");
    expect(job.resourceId).toBe(developmentWorkspace.id);
  });

  it("keeps a pooled request and an account's apart over the same evidence", async () => {
    await seedPooledWorkspace();

    const pooled = await requestStrategyGeneration(
      database,
      context,
      requestInput({ instagramAccountId: null }),
    );
    const single = await requestStrategyGeneration(database, context, requestInput());
    if (!pooled.requested || !single.requested) throw new Error("expected both to be requested");

    // Two questions about two populations. Collapsing them would hand whoever
    // asked second the other one's answer, and nothing on the page would say so.
    expect(pooled.strategyGenerationId).not.toBe(single.strategyGenerationId);
    expect(pooled.manifestHash).not.toBe(single.manifestHash);
    await expect(
      database.backgroundJob.count({ where: { queueName: "strategy.generate" } }),
    ).resolves.toBe(2);
  });

  it("refuses a pooled request when no pooled calculation has published", async () => {
    await seedComparableAccount();

    // The account's own calculation is ACTIVE, and it is not the pooled one. A
    // request that fell back to it would publish a strategy claiming to be about
    // every linked account while arguing from exactly one.
    //
    // The reason matters as much as the refusal. The counts a request reads are
    // the run's, so a scope with no run has none — and reporting those absent
    // counts as zero told a workspace with twelve analysed posts that it had
    // analysed nothing, which is a different problem with a different remedy.
    await expect(
      requestStrategyGeneration(database, context, requestInput({ instagramAccountId: null })),
    ).resolves.toMatchObject({ reason: "no_active_calculation", requested: false });
  });

  it("still says nothing is analysed when nothing is", async () => {
    // The other side of the same boundary: an empty workspace has to keep the
    // refusal that names the first thing to do, rather than being told to wait
    // for a calculation that has nothing to calculate.
    await expect(
      requestStrategyGeneration(database, context, requestInput({ instagramAccountId: null })),
    ).resolves.toMatchObject({ reason: "no_analysed_posts", requested: false });
  });
});
