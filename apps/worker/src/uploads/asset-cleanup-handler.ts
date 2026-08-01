import {
  closeVideoUploadIntent,
  createWorkspaceContext,
  findVideoUploadIntent,
  markVideoAssetPurged,
  runIdempotentJobHandler,
  videoAssetResourceType,
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
 * Releases storage this product no longer has a reason to hold.
 *
 * Two resource kinds share this queue because they are the same operation from
 * the provider's side — stop paying for bytes nobody will read — and the job's
 * `resourceType` selects which one an envelope means:
 *
 * - an abandoned multipart upload nobody completed, and
 * - the stored object behind a rejected asset, once its diagnostic retention
 *   window has passed.
 *
 * Order matters for both. The provider is told to release first, and only a
 * successful release updates the row, so a provider outage leaves the record
 * unchanged and the next sweep tries again. Updating the row first would lose
 * the only record of what still needs releasing.
 *
 * Storage the provider has already discarded counts as success: the adapter
 * treats a missing upload or object as the desired end state, so a repeated
 * sweep is free rather than an error.
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

          await execution.recordStage("loading_resource");

          const job = await dependencies.database.backgroundJob.findFirst({
            select: { resourceId: true, resourceType: true },
            where: { id: execution.jobId, workspaceId: workspace.workspaceId },
          });

          if (!job?.resourceId) {
            // Nothing identifiable to release. Succeeding is correct: a retry
            // could not discover a resource the job never carried.
            return Object.freeze({ commit: async () => undefined });
          }

          if (job.resourceType === videoAssetResourceType) {
            const asset = await dependencies.database.videoAsset.findFirst({
              select: { id: true, objectKey: true, purgedAt: true, state: true },
              where: { id: job.resourceId, workspaceId: workspace.workspaceId },
            });

            // Only a rejected asset is ever purged here, and only once. A ready
            // asset reaching this branch would mean a mis-addressed job, so it
            // is left untouched rather than deleted.
            if (asset === null || asset.state !== "REJECTED" || asset.purgedAt !== null) {
              return Object.freeze({ commit: async () => undefined });
            }

            await execution.recordStage("deleting_object");
            await dependencies.storage.deleteObject(asset.objectKey);

            return Object.freeze({
              commit: async (transaction) => {
                const purged = await markVideoAssetPurged(transaction, workspace, {
                  assetId: asset.id,
                  purgedAt: new Date(),
                });

                if (!purged) {
                  return;
                }

                dependencies.logger.info("video.asset.purged", {
                  correlationId,
                  stage: "asset_cleanup",
                  unit: "assets",
                  value: 1,
                });
              },
            });
          }

          if (job.resourceType !== videoUploadIntentResourceType) {
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
        // A redelivered job must not release storage a previous attempt already
        // released. The durable evidence differs by resource kind: an intent
        // leaving PENDING, or an asset gaining a purge timestamp. Either way it
        // is read from the resource itself rather than a separate marker row.
        resultExists: async (executor) => {
          const job = await executor.backgroundJob.findFirst({
            select: { resourceId: true, resourceType: true },
            where: { id: envelope.domainJobId, workspaceId: workspace.workspaceId },
          });

          if (!job?.resourceId) {
            return false;
          }

          if (job.resourceType === videoAssetResourceType) {
            const asset = await executor.videoAsset.findFirst({
              select: { purgedAt: true },
              where: { id: job.resourceId, workspaceId: workspace.workspaceId },
            });

            return asset !== null && asset.purgedAt !== null;
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
