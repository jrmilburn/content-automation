import {
  closeVideoUploadIntent,
  createWorkspaceContext,
  findVideoUploadIntent,
  runIdempotentJobHandler,
  videoUploadIntentResourceType,
  type DatabaseClient,
  type JobHandlerExecutionContext,
  type TransactionalJobResult,
} from "@studio-parallel/db";
import {
  JobHandlerFailure,
  type QueueHandlerRegistration,
  type QueueJobEnvelope,
} from "@studio-parallel/domain";
import type { ObjectStorageAdapter } from "@studio-parallel/integrations";
import { parseCorrelationId, type JsonLogger } from "@studio-parallel/observability";

/**
 * Releases one abandoned multipart upload.
 *
 * The provider has no lifecycle rule doing this for us — the storage policy
 * asks for one, but the parts of an upload nobody completed are billed until
 * something aborts them, so the sweep is the mechanism rather than a backstop.
 *
 * Order matters. The provider is told to abort first, and only a successful
 * abort closes the intent, so a provider outage leaves the row PENDING and the
 * next sweep tries again. Closing the row first would lose the only record of
 * which upload still needs releasing.
 *
 * An upload the provider has already discarded counts as success: the adapter
 * treats a missing upload as the desired end state, so a repeated sweep is
 * free rather than an error.
 */

export const assetCleanupQueue = { name: "asset.cleanup", version: 1 } as const;

export type AssetCleanupDependencies = Readonly<{
  database: DatabaseClient;
  logger: JsonLogger;
  storage: ObjectStorageAdapter;
}>;

export function createAssetCleanupHandler(
  dependencies: AssetCleanupDependencies,
): QueueHandlerRegistration {
  return Object.freeze({
    handler: async (envelope: QueueJobEnvelope, context: { signal: AbortSignal }) => {
      const workspace = createWorkspaceContext(envelope.workspaceId);

      await runIdempotentJobHandler({
        context: workspace,
        database: dependencies.database,
        envelope,
        execute: async (execution: JobHandlerExecutionContext): Promise<TransactionalJobResult> => {
          const correlationId = parseCorrelationId(envelope.correlationId);

          if (!correlationId) {
            throw new JobHandlerFailure({
              errorClass: "INVALID_INPUT",
              errorCode: "ASSET_CLEANUP_CORRELATION_INVALID",
            });
          }

          await execution.recordStage("loading_intent");

          const job = await dependencies.database.backgroundJob.findFirst({
            select: { resourceId: true, resourceType: true },
            where: { id: execution.jobId, workspaceId: workspace.workspaceId },
          });

          if (!job?.resourceId || job.resourceType !== videoUploadIntentResourceType) {
            // Nothing identifiable to release. Succeeding is correct: a retry
            // could not discover a resource the job never carried.
            return Object.freeze({ commit: async () => undefined });
          }

          const intent = await findVideoUploadIntent(
            dependencies.database,
            workspace,
            job.resourceId,
          );

          // Already completed or aborted by the user before the sweep ran.
          if (intent === null || intent.state !== "PENDING") {
            return Object.freeze({ commit: async () => undefined });
          }

          await execution.recordStage("aborting_upload");
          await dependencies.storage.abortMultipartUpload({
            objectKey: intent.objectKey,
            providerUploadId: intent.providerUploadId,
          });

          await execution.recordStage("closing_intent");

          return Object.freeze({
            commit: async () => {
              await closeVideoUploadIntent(dependencies.database, workspace, {
                intentId: intent.id,
                state: "EXPIRED",
              });

              dependencies.logger.info("video.upload.abandoned_released", {
                correlationId,
                stage: "asset_cleanup",
                unit: "bytes",
                // The declared size is what the abandoned parts could have cost
                // at most; nothing observed the object because it never
                // completed.
                value: Number(intent.declaredBytes),
              });
            },
          });
        },
        logger: dependencies.logger,
        // A redelivered job must not re-abort an upload that was already
        // released. The intent leaving PENDING is the durable evidence that
        // this job's work landed, so that is what is checked rather than a
        // separate marker row.
        resultExists: async (executor) => {
          const job = await executor.backgroundJob.findFirst({
            select: { resourceId: true },
            where: { id: envelope.domainJobId, workspaceId: workspace.workspaceId },
          });

          if (!job?.resourceId) {
            return false;
          }

          const intent = await executor.videoUploadIntent.findFirst({
            select: { state: true },
            where: { id: job.resourceId, workspaceId: workspace.workspaceId },
          });

          return intent !== null && intent.state !== "PENDING";
        },
        signal: context.signal,
      });
    },
    queue: assetCleanupQueue,
  });
}
