import {
  createWorkspaceContext,
  enqueueBackgroundJob,
  listInstagramCredentialsDueForMaintenance,
  type DatabaseClient,
} from "@studio-parallel/db";
import { instagramTokenRefreshDueDays } from "@studio-parallel/domain";
import {
  createCorrelationId,
  reportError,
  type CorrelationId,
  type ErrorMonitor,
  type JsonLogger,
} from "@studio-parallel/observability";

import { instagramTokenQueue } from "./token-maintain-handler.js";

/**
 * Enqueues credential maintenance before tokens get close to expiring.
 *
 * The sweep is bounded and its idempotency key is bucketed by UTC day, so
 * running every few minutes across several workers produces at most one job per
 * credential per day rather than a queue full of duplicates.
 *
 * It reads only identifiers; credential material never enters this module.
 */

export type InstagramTokenMaintenanceScheduler = Readonly<{
  start(): void;
  stop(): Promise<void>;
  sweep(): Promise<number>;
}>;

const dayMilliseconds = 86_400_000;

/** Stable per-credential, per-day key so repeated sweeps deduplicate. */
export function instagramTokenMaintenanceKey(credentialId: string, now: Date): string {
  const bucket = now.toISOString().slice(0, 10);
  return `instagram-token-maintain-${credentialId}-${bucket}`;
}

export function createInstagramTokenMaintenanceScheduler(options: {
  batchSize: number;
  database: DatabaseClient;
  errorMonitor: ErrorMonitor;
  intervalMs: number;
  logger: JsonLogger;
  now?: () => Date;
}): InstagramTokenMaintenanceScheduler {
  const now = options.now ?? (() => new Date());
  let interval: NodeJS.Timeout | undefined;
  let active: Promise<unknown> | undefined;

  const sweep = async (): Promise<number> => {
    const at = now();
    const due = await listInstagramCredentialsDueForMaintenance(options.database, {
      dueBefore: new Date(at.getTime() + instagramTokenRefreshDueDays * dayMilliseconds),
      limit: options.batchSize,
    });

    let enqueued = 0;
    for (const credential of due) {
      const correlationId: CorrelationId = createCorrelationId();
      try {
        const result = await enqueueBackgroundJob(
          options.database,
          createWorkspaceContext(credential.workspaceId),
          {
            correlationId,
            handlerVersion: instagramTokenQueue.version,
            idempotencyKey: instagramTokenMaintenanceKey(credential.credentialId, at),
            queueName: instagramTokenQueue.name,
            resourceId: credential.accountId,
            resourceType: "instagram_account",
          },
        );
        if (result.created) enqueued += 1;
      } catch (error) {
        // One workspace's problem must not stop the rest of the sweep.
        reportError(
          error,
          {
            correlationId,
            event: "instagram.token.schedule_failed",
            stage: "token_maintenance",
          },
          { logger: options.logger, monitor: options.errorMonitor },
        );
      }
    }

    if (enqueued > 0) {
      options.logger.info("instagram.token.maintenance_scheduled", {
        correlationId: createCorrelationId(),
        stage: "token_maintenance",
        unit: "credentials",
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
            event: "instagram.token.sweep_failed",
            stage: "token_maintenance",
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
