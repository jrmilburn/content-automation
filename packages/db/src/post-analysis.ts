import {
  extractAnalysisFeatures,
  isAnalyticsEligible,
  type AnalysisRequestInputs,
  type PostCreativeAnalysisV1,
} from "@studio-parallel/domain";

import { markAnalyticsDirty } from "./analytics-runs.js";
import type { Prisma, PrismaClient } from "./generated/prisma/client.js";
import { createId } from "./id.js";
import type { WorkspaceContext } from "./workspace-context.js";

/**
 * Analysis job and analysis persistence.
 *
 * Two guarantees live here. A logical request creates at most one analysis, and
 * a published analysis becomes current in the same transaction that inserts it,
 * so nothing ever observes a post between two current analyses.
 *
 * Both are enforced by the database rather than by ordering in the handler:
 * `post_analyses` is unique on `(workspace_id, analysis_job_id)` and on
 * `(workspace_id, request_signature)`, so a redelivered job that races itself
 * loses on insert instead of publishing a duplicate.
 */

export const analysisJobResourceType = "analysis_job" as const;

type Executor = PrismaClient | Prisma.TransactionClient;

export type AnalysisJobRecord = Readonly<{
  id: string;
  instagramPostId: string;
  providerFileName: string | null;
  repairAttempted: boolean;
  requestSignature: string;
  stage: string;
  videoAssetId: string;
}>;

export type AnalysisJobInputs = Readonly<{
  backgroundJobId: string;
  modelRequested: string;
  promptVersion: string;
  requestSignature: string;
  schemaVersion: string;
}> &
  AnalysisRequestInputs;

/**
 * Records the fixed inputs for one logical analysis request.
 *
 * The inputs are frozen now rather than resolved when the handler runs, so a
 * retry days later analyses the video that was asked about even if the post has
 * since gained a newer one.
 */
export async function createAnalysisJob(
  executor: Executor,
  context: WorkspaceContext,
  inputs: AnalysisJobInputs,
): Promise<string> {
  const existing = await executor.analysisJob.findFirst({
    select: { id: true },
    where: { backgroundJobId: inputs.backgroundJobId, workspaceId: context.workspaceId },
  });

  if (existing) return existing.id;

  const id = createId();

  await executor.analysisJob.create({
    data: {
      backgroundJobId: inputs.backgroundJobId,
      id,
      instagramPostId: inputs.instagramPostId,
      modelRequested: inputs.modelRequested,
      promptVersion: inputs.promptVersion,
      requestSignature: inputs.requestSignature,
      schemaVersion: inputs.schemaVersion,
      transcriptRevisionId: inputs.transcriptRevisionId,
      videoAssetId: inputs.videoAssetId,
      workspaceId: context.workspaceId,
    },
  });

  return id;
}

export async function findAnalysisJobForBackgroundJob(
  executor: Executor,
  context: WorkspaceContext,
  backgroundJobId: string,
): Promise<AnalysisJobRecord | null> {
  const job = await executor.analysisJob.findFirst({
    select: {
      id: true,
      instagramPostId: true,
      providerFileName: true,
      repairAttempted: true,
      requestSignature: true,
      stage: true,
      videoAssetId: true,
    },
    where: { backgroundJobId, workspaceId: context.workspaceId },
  });

  return job === null ? null : Object.freeze(job);
}

/**
 * Records the provider file the moment the provider accepts it.
 *
 * Written before the model request rather than after, because the window that
 * matters is the one where a worker dies holding paid bytes. A file name here
 * is the only way a later attempt knows something is owed to the provider.
 */
export async function recordAnalysisProviderFile(
  executor: Executor,
  context: WorkspaceContext,
  input: Readonly<{
    analysisJobId: string;
    expiresAt?: Date | null;
    providerFileName: string | null;
  }>,
): Promise<void> {
  await executor.analysisJob.updateMany({
    data: {
      providerFileExpiresAt: input.expiresAt ?? null,
      providerFileName: input.providerFileName,
    },
    where: { id: input.analysisJobId, workspaceId: context.workspaceId },
  });
}

export async function recordAnalysisStage(
  executor: Executor,
  context: WorkspaceContext,
  input: Readonly<{
    analysisJobId: string;
    repairAttempted?: boolean;
    stage: string;
    /** `CODE at path` entries. Never the response, which is untrusted prose. */
    validationIssues?: readonly string[];
  }>,
): Promise<void> {
  await executor.analysisJob.updateMany({
    data: {
      stage: input.stage as never,
      ...(input.repairAttempted === undefined ? {} : { repairAttempted: input.repairAttempted }),
      ...(input.validationIssues === undefined
        ? {}
        : { lastValidationIssues: [...input.validationIssues] }),
    },
    where: { id: input.analysisJobId, workspaceId: context.workspaceId },
  });
}

export type AnalysisInputsForRun = Readonly<{
  bucket: string;
  durationMs: number | null;
  objectKey: string;
  state: string;
}>;

/** Reads the asset a frozen request names, whatever the post now points at. */
export async function findAnalysisSourceAsset(
  executor: Executor,
  context: WorkspaceContext,
  videoAssetId: string,
): Promise<AnalysisInputsForRun | null> {
  const asset = await executor.videoAsset.findFirst({
    select: { bucket: true, durationMs: true, objectKey: true, state: true },
    where: { id: videoAssetId, workspaceId: context.workspaceId },
  });

  return asset === null ? null : Object.freeze(asset);
}

export type PublishAnalysisInput = Readonly<{
  analysis: PostCreativeAnalysisV1;
  analysisJobId: string;
  analysedAt: Date;
  finishReason: string | null;
  inputTokens: number | null;
  instagramPostId: string;
  modelVersion: string | null;
  outputTokens: number | null;
  promptSha256: string;
  providerLatencyMs: number | null;
  requestSignature: string;
  schemaSha256: string;
  totalTokens: number | null;
  transcriptRevisionId: string | null;
  validationWarnings: readonly string[];
  videoAssetId: string;
}>;

export type PublishAnalysisResult = Readonly<{ analysisId: string; published: boolean }>;

/**
 * Inserts one analysis and makes it current, or does nothing.
 *
 * Both statements are in the caller's transaction, so a reader never sees the
 * row before the pointer moves. A second attempt for the same logical request
 * loses the unique index on `(workspace_id, analysis_job_id)` and returns
 * `published: false` with the existing ID, which is what makes a redelivered
 * job harmless rather than duplicating a paid result.
 *
 * The previous current analysis is left in place as history. Nothing is deleted
 * on publication: a stored strategy that cited the old analysis must still
 * resolve it.
 */
export async function publishPostAnalysis(
  executor: Executor,
  context: WorkspaceContext,
  input: PublishAnalysisInput,
): Promise<PublishAnalysisResult> {
  const existing = await executor.postAnalysis.findFirst({
    select: { id: true },
    where: { analysisJobId: input.analysisJobId, workspaceId: context.workspaceId },
  });

  if (existing) return Object.freeze({ analysisId: existing.id, published: false });

  const features = extractAnalysisFeatures(input.analysis);
  const id = createId();

  await executor.postAnalysis.create({
    data: {
      analysedAt: input.analysedAt,
      analysisJobId: input.analysisJobId,
      analyticsEligible: isAnalyticsEligible(input.analysis),
      contentFormat: features.contentFormat,
      contentPillar: features.contentPillar,
      ctaType: features.ctaType,
      durationSeconds: features.durationSeconds,
      finishReason: input.finishReason,
      hookCategory: features.hookCategory,
      id,
      inputTokens: input.inputTokens,
      instagramPostId: input.instagramPostId,
      modelRequested: input.analysis.contract.modelRequested,
      modelVersion: input.modelVersion,
      outputTokens: input.outputTokens,
      overallConfidence: features.overallConfidence,
      presenterMode: features.presenterMode,
      promptSha256: input.promptSha256,
      promptVersion: input.analysis.contract.promptVersion,
      providerLatencyMs: input.providerLatencyMs,
      requestSignature: input.requestSignature,
      result: input.analysis as unknown as Prisma.InputJsonValue,
      schemaSha256: input.schemaSha256,
      schemaVersion: input.analysis.contract.schemaVersion,
      totalTokens: input.totalTokens,
      transcriptRevisionId: input.transcriptRevisionId,
      validationWarnings: [...input.validationWarnings] as unknown as Prisma.InputJsonValue,
      videoAssetId: input.videoAssetId,
      workspaceId: context.workspaceId,
    },
  });

  await executor.instagramPost.updateMany({
    data: { currentAnalysisId: id },
    where: { id: input.instagramPostId, workspaceId: context.workspaceId },
  });

  await executor.analysisJob.updateMany({
    data: { providerFileName: null, stage: "PUBLISHED" },
    where: { id: input.analysisJobId, workspaceId: context.workspaceId },
  });

  // A newly current analysis changes what every comparison for this account is
  // grouped by, so the account's statistics are now stale. Marked inside the
  // same transaction: a marker written afterwards could be lost to a crash,
  // leaving a published analysis that nothing would ever calculate over.
  const post = await executor.instagramPost.findFirst({
    select: { instagramAccountId: true },
    where: { id: input.instagramPostId, workspaceId: context.workspaceId },
  });

  if (post) {
    await markAnalyticsDirty(executor, context, {
      instagramAccountId: post.instagramAccountId,
      now: input.analysedAt,
    });
  }

  return Object.freeze({ analysisId: id, published: true });
}

/** Whether this logical request already produced an analysis. */
export async function analysisExistsForJob(
  executor: Executor,
  context: WorkspaceContext,
  backgroundJobId: string,
): Promise<boolean> {
  const job = await executor.analysisJob.findFirst({
    select: { analysis: { select: { id: true } } },
    where: { backgroundJobId, workspaceId: context.workspaceId },
  });

  return job?.analysis != null;
}
