import {
  createWorkspaceContext,
  enqueueBackgroundJob,
  listExpiredVideoUploadIntents,
  listPurgeableVideoAssets,
  videoAssetResourceType,
  videoUploadIntentResourceType,
  type DatabaseClient,
} from "@studio-parallel/db";
import { videoAssetPurgeKey, videoUploadCleanupKey } from "@studio-parallel/domain";
import {
  createCorrelationId,
  reportError,
  type CorrelationId,
  type ErrorMonitor,
  type JsonLogger,
} from "@studio-parallel/observability";

import { assetCleanupQueue } from "./asset-cleanup-handler.js";

/**
 * Enqueues cleanup for upload intents whose window has closed.
 *
 * The intent rows are the authority for what to release, not the provider's
 * upload list: an intent is created before any part is sent, so a browser that
 * vanished after reserving an upload is still swept even though the provider
 * never saw a byte. The adapter's own listing is a reconciliation path for the
 * reverse case and is deliberately not what drives this sweep.
 *
 * The key is bucketed by UTC day, so several workers sweeping every few minutes
 * produce at most one job per intent per day. A cleanup that failed to reach
 * the provider is retried tomorrow rather than hammered today.
 */

export type AssetCleanupScheduler = Readonly<{
  start(): void;
  stop(): Promise<void>;
  sweep(): Promise<number>;
}>;

export function createAssetCleanupScheduler(options: {
  batchSize: number;
  database: DatabaseClient;
  errorMonitor: ErrorMonitor;
  intervalMs: number;
  logger: JsonLogger;
  now?: () => Date;
}): AssetCleanupScheduler {
  const now = options.now ?? (() => new Date());
  let interval: NodeJS.Timeout | undefined;
  let active: Promise<unknown> | undefined;

  type Releasable = Readonly<{
    id: string;
    idempotencyKey: string;
    resourceType: string;
    workspaceId: string;
  }>;

  const enqueueAll = async (
    items: readonly Releasable[],
    failureEvent: string,
  ): Promise<number> => {
    let enqueued = 0;

    for (const item of items) {
      const correlationId: CorrelationId = createCorrelationId();

      try {
        const result = await enqueueBackgroundJob(
          options.database,
          createWorkspaceContext(item.workspaceId),
          {
            correlationId,
            handlerVersion: assetCleanupQueue.version,
            idempotencyKey: item.idempotencyKey,
            queueName: assetCleanupQueue.name,
            resourceId: item.id,
            resourceType: item.resourceType,
          },
        );

        if (result.created) enqueued += 1;
      } catch (error) {
        // One workspace's problem must not stop the rest of the sweep.
        reportError(
          error,
          { correlationId, event: failureEvent, stage: "asset_cleanup" },
          { logger: options.logger, monitor: options.errorMonitor },
        );
      }
    }

    return enqueued;
  };

  const sweep = async (): Promise<number> => {
    const at = now();
    const expired = await listExpiredVideoUploadIntents(options.database, {
      expiredBefore: at,
      limit: options.batchSize,
    });

    const intents = await enqueueAll(
      expired.map((intent) =>
        Object.freeze({
          id: intent.id,
          idempotencyKey: videoUploadCleanupKey(intent.id, at),
          resourceType: videoUploadIntentResourceType,
          workspaceId: intent.workspaceId,
        }),
      ),
      "video.upload.cleanup_schedule_failed",
    );

    if (intents > 0) {
      options.logger.info("video.upload.cleanup_scheduled", {
        correlationId: createCorrelationId(),
        stage: "asset_cleanup",
        unit: "intents",
        value: intents,
      });
    }

    // Rejected objects are swept on the same cadence but counted separately, so
    // a purge backlog is visible rather than hidden inside the intent number.
    const purgeable = await listPurgeableVideoAssets(options.database, {
      dueBefore: at,
      limit: options.batchSize,
    });

    const assets = await enqueueAll(
      purgeable.map((asset) =>
        Object.freeze({
          id: asset.id,
          idempotencyKey: videoAssetPurgeKey(asset.id, at),
          resourceType: videoAssetResourceType,
          workspaceId: asset.workspaceId,
        }),
      ),
      "video.asset.purge_schedule_failed",
    );

    if (assets > 0) {
      options.logger.info("video.asset.purge_scheduled", {
        correlationId: createCorrelationId(),
        stage: "asset_cleanup",
        unit: "assets",
        value: assets,
      });
    }

    return intents + assets;
  };

  const tick = (): void => {
    if (active) return;

    active = sweep()
      .catch((error: unknown) => {
        reportError(
          error,
          {
            correlationId: createCorrelationId(),
            event: "video.upload.cleanup_sweep_failed",
            stage: "asset_cleanup",
          },
          { logger: options.logger, monitor: options.errorMonitor },
        );
      })
      .finally(() => {
        active = undefined;
      });
  };

  return Object.freeze({
    start() {
      if (interval) return;
      tick();
      interval = setInterval(tick, options.intervalMs);
      interval.unref();
    },
    async stop() {
      if (interval) clearInterval(interval);
      interval = undefined;
      await active;
    },
    sweep,
  });
}
