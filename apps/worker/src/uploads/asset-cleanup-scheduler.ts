import {
  createWorkspaceContext,
  enqueueBackgroundJob,
  listExpiredVideoUploadIntents,
  videoUploadIntentResourceType,
  type DatabaseClient,
} from "@studio-parallel/db";
import { videoUploadCleanupKey } from "@studio-parallel/domain";
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

  const sweep = async (): Promise<number> => {
    const at = now();
    const expired = await listExpiredVideoUploadIntents(options.database, {
      expiredBefore: at,
      limit: options.batchSize,
    });

    let enqueued = 0;

    for (const intent of expired) {
      const correlationId: CorrelationId = createCorrelationId();

      try {
        const result = await enqueueBackgroundJob(
          options.database,
          createWorkspaceContext(intent.workspaceId),
          {
            correlationId,
            handlerVersion: assetCleanupQueue.version,
            idempotencyKey: videoUploadCleanupKey(intent.id, at),
            queueName: assetCleanupQueue.name,
            resourceId: intent.id,
            resourceType: videoUploadIntentResourceType,
          },
        );

        if (result.created) enqueued += 1;
      } catch (error) {
        // One workspace's problem must not stop the rest of the sweep.
        reportError(
          error,
          {
            correlationId,
            event: "video.upload.cleanup_schedule_failed",
            stage: "asset_cleanup",
          },
          { logger: options.logger, monitor: options.errorMonitor },
        );
      }
    }

    if (enqueued > 0) {
      options.logger.info("video.upload.cleanup_scheduled", {
        correlationId: createCorrelationId(),
        stage: "asset_cleanup",
        unit: "intents",
        value: enqueued,
      });
    }

    return enqueued;
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
