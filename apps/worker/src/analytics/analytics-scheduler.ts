import {
  createWorkspaceContext,
  enqueueBackgroundJob,
  listAccountsDueForAnalytics,
  type DatabaseClient,
  type DueAccount,
} from "@studio-parallel/db";
import {
  createCorrelationId,
  reportError,
  type CorrelationId,
  type ErrorMonitor,
  type JsonLogger,
} from "@studio-parallel/observability";

import { analyticsRecalculateQueue, pooledResourceType } from "./recalculate-handler.js";

/**
 * Enqueues a recalculation for each account whose debounce window has closed,
 * and one for the workspace scope those accounts belong to.
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
 *
 * The workspace scope has no row of its own to mark dirty, so it inherits the
 * accounts': it is due when any of them is, and keys on the newest anchor among
 * them. That is what collapses a burst across accounts into one pooled run
 * instead of one per account. The pooled job is additional to the per-account
 * ones rather than a replacement for any of them, and it does not consume their
 * markers — the handler settles whether a pooled run is current against what the
 * pooled scope last published, since the accounts clear those markers as they go.
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

    const enqueue = async (
      input: Readonly<{
        idempotencyKey: string;
        resourceId: string;
        resourceType: string;
        workspaceId: string;
      }>,
    ): Promise<void> => {
      const correlationId: CorrelationId = createCorrelationId();

      try {
        const result = await enqueueBackgroundJob(
          options.database,
          createWorkspaceContext(input.workspaceId),
          {
            correlationId,
            handlerVersion: analyticsRecalculateQueue.version,
            idempotencyKey: input.idempotencyKey,
            queueName: analyticsRecalculateQueue.name,
            resourceId: input.resourceId,
            resourceType: input.resourceType,
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
    };

    for (const account of due) {
      await enqueue({
        // Anchored on the change, not on the sweep. A second sweep before the
        // job runs collapses onto the same key; a change that arrives afterwards
        // moves the anchor and earns its own run.
        idempotencyKey: analyticsRecalculateKey(account.instagramAccountId, account.dirtySince),
        resourceId: account.instagramAccountId,
        resourceType: "instagram_account",
        workspaceId: account.workspaceId,
      });
    }

    for (const [workspaceId, anchor] of pooledAnchors(due)) {
      await enqueue({
        idempotencyKey: pooledAnalyticsRecalculateKey(workspaceId, anchor),
        // The workspace stands in for a scope that spans every linked account,
        // since no account owns it.
        resourceId: workspaceId,
        resourceType: pooledResourceType,
        workspaceId,
      });
    }

    if (enqueued > 0) {
      options.logger.info("analytics.recalculate.scheduled", {
        correlationId: createCorrelationId(),
        stage: "analytics_scheduling",
        // Jobs rather than accounts: a sweep enqueues one per due account plus
        // one per workspace those accounts belong to.
        unit: "jobs",
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

/** Key for the workspace-wide recalculation of one unprocessed batch. */
export function pooledAnalyticsRecalculateKey(workspaceId: string, dirtySince: Date): string {
  return `analytics-recalculate-pooled-${workspaceId}-${dirtySince.toISOString()}`;
}

/**
 * The anchor each workspace's pooled run keys on: the newest among its due
 * accounts.
 *
 * Newest rather than oldest, so that accounts falling due together share one
 * key. Keyed on the oldest, a second account becoming due would reuse the first
 * account's anchor and its changes would never earn a pooled run of their own.
 */
function pooledAnchors(due: readonly DueAccount[]): ReadonlyMap<string, Date> {
  const anchors = new Map<string, Date>();

  for (const account of due) {
    const current = anchors.get(account.workspaceId);
    if (current === undefined || account.dirtySince > current) {
      anchors.set(account.workspaceId, account.dirtySince);
    }
  }

  return anchors;
}
