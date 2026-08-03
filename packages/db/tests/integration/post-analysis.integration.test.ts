import { loadDatabaseConfig } from "@studio-parallel/config";
import type { PostCreativeAnalysisV1 } from "@studio-parallel/domain";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createDatabaseClient, type DatabaseClient } from "../../src/client.js";
import { createId } from "../../src/id.js";
import {
  analysisExistsForJob,
  createAnalysisJob,
  findAnalysisJobForBackgroundJob,
  publishPostAnalysis,
  recordAnalysisProviderFile,
} from "../../src/post-analysis.js";
import { developmentWorkspace } from "../../src/seed-data.js";
import { createWorkspaceContext } from "../../src/workspace-context.js";

/**
 * The two guarantees that only a database can prove.
 *
 * One logical request produces at most one analysis, and the current pointer
 * moves in the same transaction that inserts it. Both are enforced by unique
 * indexes rather than by handler ordering, so they have to be exercised against
 * real constraints.
 */

const databaseConfig = loadDatabaseConfig();
let database: DatabaseClient;

const context = createWorkspaceContext(developmentWorkspace.id);
const analysedAt = new Date("2026-08-03T02:00:00.000Z");

let accountId: string;
let postId: string;
let assetId: string;
let backgroundJobId: string;
const uploaderId = "01900000-0000-7000-8000-0000000004a1";

function observation<T>(value: T, availability = "available") {
  return {
    availability,
    basis: "observed",
    confidence: "high",
    evidence: [],
    limitation: null,
    value,
  };
}

function analysis(overrides: Record<string, unknown> = {}): PostCreativeAnalysisV1 {
  return {
    callToAction: {
      present: observation(true),
      text: observation("Follow"),
      type: observation("follow"),
    },
    content: {
      contentFormat: observation("educational"),
      contentPillar: observation("education_and_insight"),
      durationSeconds: observation(30),
      hook: { category: observation("question") },
      presenterMode: observation("founder_led"),
    },
    contract: {
      modelRequested: "gemini-3.6-flash",
      promptVersion: "post-creative-analysis-prompt-v1.1.0",
      schemaVersion: "post-creative-analysis-v1.0.0",
    },
    quality: { overallConfidence: "high" },
    ...overrides,
  } as unknown as PostCreativeAnalysisV1;
}

function publishInput(analysisJobId: string, overrides: Record<string, unknown> = {}) {
  return {
    analysedAt,
    analysis: analysis(),
    analysisJobId,
    finishReason: "STOP",
    inputTokens: 1_000,
    instagramPostId: postId,
    modelVersion: "gemini-3.6-flash",
    outputTokens: 200,
    promptSha256: "b".repeat(64),
    providerLatencyMs: 4_200,
    requestSignature: "c".repeat(64),
    schemaSha256: "a".repeat(64),
    totalTokens: 1_200,
    transcriptRevisionId: null,
    validationWarnings: [],
    videoAssetId: assetId,
    ...overrides,
  };
}

async function clear(): Promise<void> {
  await database.instagramPost.updateMany({ data: { currentAnalysisId: null } });
  await database.postAnalysis.deleteMany();
  await database.analysisJob.deleteMany();
  await database.jobAttempt.deleteMany();
  await database.jobOutbox.deleteMany();
  await database.backgroundJob.deleteMany();
  await database.videoAsset.deleteMany();
  await database.videoUploadIntent.deleteMany();
  await database.instagramMetricSnapshot.deleteMany();
  await database.instagramPost.deleteMany();
  await database.syncRun.deleteMany();
  await database.integrationCredential.deleteMany();
  await database.instagramAccount.deleteMany();
}

beforeAll(async () => {
  database = createDatabaseClient(databaseConfig.DATABASE_URL);
});

beforeEach(async () => {
  await clear();

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

  postId = createId();
  await database.instagramPost.create({
    data: {
      firstImportedAt: analysedAt,
      id: postId,
      instagramAccountId: accountId,
      lastImportedAt: analysedAt,
      mediaKind: "REEL",
      mediaType: "VIDEO",
      providerMediaId: `media-${postId.slice(-12)}`,
      publishedAt: analysedAt,
      rawApiVersion: "v25.0",
      rawPayload: {},
      rawPayloadHash: "0".repeat(64),
      rawRetrievedAt: analysedAt,
      workspaceId: developmentWorkspace.id,
    },
  });

  // An intent records who uploaded, so the fixture needs a real user.
  await database.internalUser.upsert({
    create: {
      email: `analysis-${uploaderId}@studioparallel.invalid`,
      id: uploaderId,
      role: "ADMIN",
      workspaceId: developmentWorkspace.id,
    },
    update: {},
    where: { workspaceId_id: { id: uploaderId, workspaceId: developmentWorkspace.id } },
  });

  const intentId = createId();
  await database.videoUploadIntent.create({
    data: {
      bucket: "studio-parallel-source-video",
      createdByUserId: uploaderId,
      declaredBytes: BigInt(1_024),
      declaredContentType: "video/mp4",
      expiresAt: new Date(analysedAt.getTime() + 3_600_000),
      id: intentId,
      instagramPostId: postId,
      objectKey: `production/${developmentWorkspace.id}/source-video/${intentId.slice(-16)}`,
      partCount: 1,
      partSizeBytes: 8_388_608,
      providerUploadId: `upload-${intentId.slice(-12)}`,
      region: "ap-southeast-2",
      workspaceId: developmentWorkspace.id,
    },
  });

  assetId = createId();
  await database.videoAsset.create({
    data: {
      bucket: "studio-parallel-source-video",
      bytes: BigInt(1_024),
      contentType: "video/mp4",
      durationMs: 30_000,
      etag: "etag-1",
      id: assetId,
      instagramPostId: postId,
      objectKey: `production/${developmentWorkspace.id}/source-video/${assetId.slice(-16)}`,
      region: "ap-southeast-2",
      state: "READY",
      uploadIntentId: intentId,
      workspaceId: developmentWorkspace.id,
    },
  });

  backgroundJobId = createId();
  await database.backgroundJob.create({
    data: {
      correlationId: createId(),
      handlerVersion: 1,
      id: backgroundJobId,
      idempotencyKey: `analysis-run-${"d".repeat(64)}`,
      queueName: "analysis.run",
      workspaceId: developmentWorkspace.id,
    },
  });
});

afterAll(async () => {
  await clear();
  await database.$disconnect();
});

async function createJob(): Promise<string> {
  return createAnalysisJob(database, context, {
    backgroundJobId,
    instagramPostId: postId,
    modelRequested: "gemini-3.6-flash",
    promptVersion: "post-creative-analysis-prompt-v1.1.0",
    requestSignature: "c".repeat(64),
    schemaVersion: "post-creative-analysis-v1.0.0",
    transcriptRevisionId: null,
    videoAssetId: assetId,
  });
}

describe("createAnalysisJob", () => {
  it("freezes the inputs once and returns the same job on a repeat", async () => {
    const first = await createJob();
    const second = await createJob();

    expect(second).toBe(first);
    expect(await database.analysisJob.count()).toBe(1);
  });

  it("reads back the frozen inputs for the handler", async () => {
    const id = await createJob();
    const job = await findAnalysisJobForBackgroundJob(database, context, backgroundJobId);

    expect(job).toMatchObject({
      id,
      instagramPostId: postId,
      providerFileName: null,
      repairAttempted: false,
      stage: "QUEUED",
      videoAssetId: assetId,
    });
  });

  it("is invisible to another workspace", async () => {
    await createJob();

    expect(
      await findAnalysisJobForBackgroundJob(
        database,
        createWorkspaceContext(createId()),
        backgroundJobId,
      ),
    ).toBeNull();
  });
});

describe("recordAnalysisProviderFile", () => {
  it("records and clears the file a crash would otherwise abandon", async () => {
    const id = await createJob();

    await recordAnalysisProviderFile(database, context, {
      analysisJobId: id,
      providerFileName: "files/abc123",
    });
    expect(
      (await findAnalysisJobForBackgroundJob(database, context, backgroundJobId))?.providerFileName,
    ).toBe("files/abc123");

    await recordAnalysisProviderFile(database, context, {
      analysisJobId: id,
      providerFileName: null,
    });
    expect(
      (await findAnalysisJobForBackgroundJob(database, context, backgroundJobId))?.providerFileName,
    ).toBeNull();
  });
});

describe("publishPostAnalysis", () => {
  it("inserts the analysis and makes it current in one transaction", async () => {
    const id = await createJob();

    const result = await database.$transaction((transaction) =>
      publishPostAnalysis(transaction, context, publishInput(id)),
    );

    expect(result.published).toBe(true);

    const post = await database.instagramPost.findFirstOrThrow({ where: { id: postId } });
    expect(post.currentAnalysisId).toBe(result.analysisId);

    const stored = await database.postAnalysis.findFirstOrThrow({
      where: { id: result.analysisId },
    });
    expect(stored).toMatchObject({
      analyticsEligible: true,
      contentFormat: "educational",
      contentPillar: "education_and_insight",
      ctaType: "follow",
      finishReason: "STOP",
      hookCategory: "question",
      inputTokens: 1_000,
      overallConfidence: "high",
      presenterMode: "founder_led",
      totalTokens: 1_200,
    });
    expect(Number(stored.durationSeconds)).toBeCloseTo(30, 3);
  });

  it("publishes at most one analysis for a redelivered job", async () => {
    // The unique index on (workspace_id, analysis_job_id) is what makes a
    // redelivery harmless rather than duplicating a paid result.
    const id = await createJob();

    const first = await database.$transaction((transaction) =>
      publishPostAnalysis(transaction, context, publishInput(id)),
    );
    const second = await database.$transaction((transaction) =>
      publishPostAnalysis(transaction, context, publishInput(id)),
    );

    expect(second).toEqual({ analysisId: first.analysisId, published: false });
    expect(await database.postAnalysis.count()).toBe(1);
  });

  it("clears the provider file and marks the job published", async () => {
    const id = await createJob();
    await recordAnalysisProviderFile(database, context, {
      analysisJobId: id,
      providerFileName: "files/abc123",
    });

    await database.$transaction((transaction) =>
      publishPostAnalysis(transaction, context, publishInput(id)),
    );

    const job = await database.analysisJob.findFirstOrThrow({ where: { id } });
    expect(job).toMatchObject({ providerFileName: null, stage: "PUBLISHED" });
  });

  it("keeps the previous analysis as history when a new one becomes current", async () => {
    // A stored strategy that cited the old analysis must still resolve it.
    const firstJob = await createJob();
    const first = await database.$transaction((transaction) =>
      publishPostAnalysis(transaction, context, publishInput(firstJob)),
    );

    const secondBackgroundJobId = createId();
    await database.backgroundJob.create({
      data: {
        correlationId: createId(),
        handlerVersion: 1,
        id: secondBackgroundJobId,
        idempotencyKey: `analysis-run-${"e".repeat(64)}`,
        queueName: "analysis.run",
        workspaceId: developmentWorkspace.id,
      },
    });
    const secondJob = await createAnalysisJob(database, context, {
      backgroundJobId: secondBackgroundJobId,
      instagramPostId: postId,
      modelRequested: "gemini-3.6-flash",
      promptVersion: "post-creative-analysis-prompt-v1.2.0",
      requestSignature: "f".repeat(64),
      schemaVersion: "post-creative-analysis-v1.0.0",
      transcriptRevisionId: null,
      videoAssetId: assetId,
    });

    const second = await database.$transaction((transaction) =>
      publishPostAnalysis(
        transaction,
        context,
        publishInput(secondJob, { requestSignature: "f".repeat(64) }),
      ),
    );

    const post = await database.instagramPost.findFirstOrThrow({ where: { id: postId } });

    expect(post.currentAnalysisId).toBe(second.analysisId);
    expect(await database.postAnalysis.count()).toBe(2);
    expect(
      await database.postAnalysis.findFirst({ where: { id: first.analysisId } }),
    ).not.toBeNull();
  });

  it("marks a low-confidence analysis ineligible for grouping", async () => {
    const id = await createJob();

    const result = await database.$transaction((transaction) =>
      publishPostAnalysis(
        transaction,
        context,
        publishInput(id, { analysis: analysis({ quality: { overallConfidence: "low" } }) }),
      ),
    );

    const stored = await database.postAnalysis.findFirstOrThrow({
      where: { id: result.analysisId },
    });
    expect(stored.analyticsEligible).toBe(false);
  });

  it("refuses a second analysis for the same request signature", async () => {
    // Two different jobs asking the identical question must not both publish.
    const id = await createJob();
    await database.$transaction((transaction) =>
      publishPostAnalysis(transaction, context, publishInput(id)),
    );

    const otherBackgroundJobId = createId();
    await database.backgroundJob.create({
      data: {
        correlationId: createId(),
        handlerVersion: 1,
        id: otherBackgroundJobId,
        idempotencyKey: `analysis-run-${"g".repeat(64)}`,
        queueName: "analysis.run",
        workspaceId: developmentWorkspace.id,
      },
    });
    const otherJob = await createAnalysisJob(database, context, {
      backgroundJobId: otherBackgroundJobId,
      instagramPostId: postId,
      modelRequested: "gemini-3.6-flash",
      promptVersion: "post-creative-analysis-prompt-v1.1.0",
      requestSignature: "c".repeat(64),
      schemaVersion: "post-creative-analysis-v1.0.0",
      transcriptRevisionId: null,
      videoAssetId: assetId,
    });

    await expect(
      database.$transaction((transaction) =>
        publishPostAnalysis(transaction, context, publishInput(otherJob)),
      ),
    ).rejects.toThrow();
    expect(await database.postAnalysis.count()).toBe(1);
  });
});

describe("analysisExistsForJob", () => {
  it("reports whether this logical request already produced an analysis", async () => {
    const id = await createJob();

    expect(await analysisExistsForJob(database, context, backgroundJobId)).toBe(false);

    await database.$transaction((transaction) =>
      publishPostAnalysis(transaction, context, publishInput(id)),
    );

    expect(await analysisExistsForJob(database, context, backgroundJobId)).toBe(true);
  });
});
