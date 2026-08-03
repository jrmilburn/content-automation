import {
  createWorkspaceContext,
  enqueueBackgroundJob,
  listAccountsDueForAnalytics,
  type DatabaseClient,
} from "@studio-parallel/db";
import {
  createCorrelationId,
  reportError,
  type CorrelationId,
  type ErrorMonitor,
  type JsonLogger,
} from "@studio-parallel/observability";

import { analyticsRecalculateQueue } from "./recalculate-handler.js";

/**
 * Enqueues a recalculation for each account whose debounce window has closed.
 *
 * The debounce lives in the account row rather than here: a change marks the
 * account dirty and sets a due time, and this sweep only asks which windows have
 * closed. That is what turns a burst of imports into one run — the marker is set
 * by the first change and later changes extend nothing, so a steadily importing
 * account still becomes due rather than being postponed forever.
 *
 * The idempotency key carries the dirty anchor rather than the sweep time. Two
 * sweeps over the same unprocessed change therefore produce one job, while a
 * genuinely new change produces a new anchor and a new job.
 */

export type AnalyticsScheduler = Readonly<{
  start(): void;
  stop(): Promise<void>;
  sweep(): Promise<number>;
}>;

export function createAnalyticsScheduler(options: {
  batchSize: number;
  database: DatabaseClient;
  errorMonitor: ErrorMonitor;
  intervalMs: number;
  logger: JsonLogger;
  now?: () => Date;
}): AnalyticsScheduler {
  const now = options.now ?? (() => new Date());
  let interval: NodeJS.Timeout | undefined;
  let active: Promise<unknown> | undefined;

  const sweep = async (): Promise<number> => {
    const at = now();
    const due = await listAccountsDueForAnalytics(options.database, {
      limit: options.batchSize,
      now: at,
    });

    let enqueued = 0;

    for (const account of due) {
      const correlationId: CorrelationId = createCorrelationId();

      try {
        const result = await enqueueBackgroundJob(
          options.database,
          createWorkspaceContext(account.workspaceId),
          {
            correlationId,
            handlerVersion: analyticsRecalculateQueue.version,
            // Anchored on the change, not on the sweep. A second sweep before
            // the job runs collapses onto the same key; a change that arrives
            // afterwards moves the anchor and earns its own run.
            idempotencyKey: analyticsRecalculateKey(account.instagramAccountId, account.dirtySince),
            queueName: analyticsRecalculateQueue.name,
            resourceId: account.instagramAccountId,
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
            event: "analytics.recalculate.schedule_failed",
            stage: "analytics_scheduling",
          },
          { logger: options.logger, monitor: options.errorMonitor },
        );
      }
    }

    if (enqueued > 0) {
      options.logger.info("analytics.recalculate.scheduled", {
        correlationId: createCorrelationId(),
        stage: "analytics_scheduling",
        unit: "accounts",
        value: enqueued,
      });
    }

    return enqueued;
  };

  const tick = (): void => {
    // Never overlap sweeps: a slow one would otherwise stack behind itself and
    // re-read the same due accounts.
    if (active) return;

    active = sweep()
      .catch((error: unknown) => {
        reportError(
          error,
          {
            correlationId: createCorrelationId(),
            event: "analytics.recalculate.sweep_failed",
            stage: "analytics_scheduling",
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

/** Key for one account's recalculation of one unprocessed batch of changes. */
export function analyticsRecalculateKey(accountId: string, dirtySince: Date): string {
  return `analytics-recalculate-${accountId}-${dirtySince.toISOString()}`;
}
