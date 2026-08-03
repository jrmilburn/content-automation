import {
  analysisModelRequested,
  analysisPromptVersion,
  analysisRunKey,
  analysisSchemaVersion,
  evaluateAnalysisEligibility,
  type AnalysisIneligibilityReason,
} from "@studio-parallel/domain";

import { enqueueBackgroundJobInTransaction } from "./background-jobs.js";
import type { PrismaClient } from "./generated/prisma/client.js";
import { createAnalysisJob } from "./post-analysis.js";
import type { WorkspaceContext } from "./workspace-context.js";

/**
 * Asking for one post to be analysed.
 *
 * The enqueue and the frozen inputs are written in one transaction, so a job
 * can never exist without the record of what it was asked to analyse. Splitting
 * them would leave a handler holding a job ID and nothing to do with it.
 *
 * Duplicate submits collapse on the background job's idempotency key, which is
 * derived from the request signature. Two people pressing analyse on the same
 * post under the same contract produce one job and one provider call.
 */

export const analysisRequestRefusals = [
  "asset_not_ready",
  "no_source_video",
  "post_not_found",
] as const;

export type AnalysisRequestRefusal = AnalysisIneligibilityReason;

export type AnalysisRequestOutcome =
  | Readonly<{
      /** False when this request already existed. */
      created: boolean;
      backgroundJobId: string;
      requested: true;
      signature: string;
    }>
  | Readonly<{ reason: AnalysisRequestRefusal; requested: false }>;

/**
 * Queues an analysis of a post's current source video.
 *
 * The asset is resolved here rather than by the handler, so what was asked for
 * is fixed at the moment of asking. A replacement uploaded a minute later is a
 * different question and needs its own request.
 */
export async function requestPostAnalysis(
  database: PrismaClient,
  context: WorkspaceContext,
  input: Readonly<{ correlationId: string; instagramPostId: string }>,
): Promise<AnalysisRequestOutcome> {
  const post = await database.instagramPost.findFirst({
    select: {
      id: true,
      // Newest first: the current asset is the one a request means, and an
      // older rejected upload must not be analysed in its place.
      videoAssets: {
        orderBy: { createdAt: "desc" },
        select: { id: true, state: true },
        take: 1,
      },
    },
    where: { id: input.instagramPostId, workspaceId: context.workspaceId },
  });

  const asset = post?.videoAssets[0];
  const eligibility = evaluateAnalysisEligibility({
    instagramPostId: post?.id ?? null,
    videoAssetId: asset?.id ?? null,
    videoAssetState: asset?.state ?? null,
  });

  if (!eligibility.eligible) {
    return Object.freeze({ reason: eligibility.reason, requested: false });
  }

  return database.$transaction(async (transaction) => {
    const enqueued = await enqueueBackgroundJobInTransaction(transaction, context, {
      correlationId: input.correlationId,
      handlerVersion: 1,
      idempotencyKey: analysisRunKey(eligibility.signature),
      queueName: "analysis.run",
      resourceId: eligibility.inputs.instagramPostId,
      resourceType: "instagram_post",
    });

    // Idempotent: a repeat submit finds the existing analysis job rather than
    // freezing a second set of inputs against the same background job.
    await createAnalysisJob(transaction, context, {
      backgroundJobId: enqueued.job.id,
      instagramPostId: eligibility.inputs.instagramPostId,
      modelRequested: analysisModelRequested,
      promptVersion: analysisPromptVersion,
      requestSignature: eligibility.signature,
      schemaVersion: analysisSchemaVersion,
      transcriptRevisionId: eligibility.inputs.transcriptRevisionId,
      videoAssetId: eligibility.inputs.videoAssetId,
    });

    return Object.freeze({
      backgroundJobId: enqueued.job.id,
      created: enqueued.created,
      requested: true as const,
      signature: eligibility.signature,
    });
  });
}
