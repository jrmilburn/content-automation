import { loadDatabaseConfig } from "@studio-parallel/config";
import {
  createStrategyManifestHash,
  type InstagramMetricObservation,
} from "@studio-parallel/domain";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { buildFeatureRequests, loadAnalyticsInputs } from "../../src/analytics-features.js";
import { activateAnalyticsRun, startAnalyticsRun } from "../../src/analytics-runs.js";
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
  await database.backgroundJob.deleteMany();
  await database.instagramAccount.deleteMany();
}

async function createAccount(): Promise<string> {
  const id = createId();
  await database.instagramAccount.create({
    data: {
      accountType: "BUSINESS",
      apiVersion: "v25.0",
      connectionStatus: "ACTIVE",
      grantedScopes: ["instagram_business_basic"],
      id,
      providerAccountId: `1784140000000${String(Math.floor(Math.random() * 9000) + 1000)}`,
      username: "studioparallel",
      workspaceId: developmentWorkspace.id,
    },
  });
  return id;
}

async function analysedPost(
  input: Readonly<{ hookCategory: string | null; likes: number; publishedAt: Date }>,
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
      schemaVersion: "post-creative-analysis-v1.0.0",
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
      schemaVersion: "post-creative-analysis-v1.0.0",
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
    observations: [observation("reach", 1_000), observation("likes", input.likes)],
    postAgeSeconds: 30 * 86_400,
    rawPayload: { likes: input.likes },
  });

  return postId;
}

function inputRequest() {
  return {
    ageWindow: "day_30",
    instagramAccountId: accountId,
    publishedFrom,
    publishedTo,
  } as const;
}

/** Builds and publishes one calculation, the way the handler does. */
async function publishCalculation(): Promise<string> {
  // Activation clears the marker it started from, so the account has to be dirty
  // for the run to publish — which is the state a real recalculation runs in.
  const dirtySince = new Date(calculatedAt.getTime() - 60_000);
  await database.instagramAccount.updateMany({
    data: { analyticsDirtySince: dirtySince },
    where: { id: accountId, workspaceId: developmentWorkspace.id },
  });

  const inputs = await loadAnalyticsInputs(database, context, inputRequest());
  const families = buildFeatureRequests(inputRequest(), inputs);
  const run = await startAnalyticsRun(database, context, {
    ageWindow: "day_30",
    analysisCount: inputs.posts.length,
    inputFingerprint: "c".repeat(64),
    instagramAccountId: accountId,
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
    instagramAccountId: accountId,
    now: calculatedAt,
    runId: run.id,
  });

  return run.id;
}

/** Enough analysed posts, split across two hook values, to compare on. */
async function seedComparableAccount(): Promise<void> {
  for (let index = 0; index < 12; index += 1) {
    await analysedPost({
      hookCategory: index < 6 ? "question" : "claim",
      likes: index < 6 ? 200 + index : 100 + index,
      publishedAt: new Date(Date.UTC(2026, 2, 1 + index * 8)),
    });
  }
  await publishCalculation();
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
    await database.instagramAccount.updateMany({
      data: { analyticsDirtySince: calculatedAt },
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

    const cited = await database.strategyEvidence.findFirst({
      where: {
        featureStatisticId: { not: null },
        strategyGenerationId: outcome.strategyGenerationId,
      },
    });
    if (!cited?.featureStatisticId) throw new Error("expected a cited statistic");

    // Removal must not silently retarget the evidence link a strategy depends on.
    await expect(
      database.accountFeatureStatistic.delete({ where: { id: cited.featureStatisticId } }),
    ).rejects.toThrow();
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
