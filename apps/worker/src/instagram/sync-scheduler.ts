import {
  createWorkspaceContext,
  enqueueBackgroundJob,
  listInstagramAccountsDueForSync,
  listInstagramPostsDueForSnapshot,
  type DatabaseClient,
} from "@studio-parallel/db";
import {
  instagramAccountSyncIntervalHours,
  instagramScheduledSyncKey,
  instagramSnapshotKey,
  instagramSyncPriority,
} from "@studio-parallel/domain";
import {
  createCorrelationId,
  reportError,
  type CorrelationId,
  type ErrorMonitor,
  type JsonLogger,
} from "@studio-parallel/observability";

import { instagramSnapshotQueue } from "./snapshot-post-handler.js";
import { instagramSyncQueue } from "./sync-account-handler.js";

/**
 * Enqueues due account imports and due post snapshots.
 *
 * Both sweeps are bounded and both rely on a bucketed idempotency key rather
 * than a claimed `due_at` column, so running every few minutes across several
 * workers produces at most one job per unit of work per window instead of a
 * queue of duplicates. Nothing here reads credential material.
 *
 * A snapshot key carries no timestamp — only the post and its age bucket — so a
 * capture that happens late still lands in the bucket its age puts it in. That
 * is what stops a missed target being quietly backdated to the one it missed.
 */

export type InstagramSyncScheduler = Readonly<{
  start(): void;
  stop(): Promise<void>;
  sweep(): Promise<InstagramSweepResult>;
}>;

export type InstagramSweepResult = Readonly<{ snapshots: number; syncs: number }>;

const hourMilliseconds = 3_600_000;

export function createInstagramSyncScheduler(options: {
  batchSize: number;
  database: DatabaseClient;
  errorMonitor: ErrorMonitor;
  intervalMs: number;
  logger: JsonLogger;
  now?: () => Date;
}): InstagramSyncScheduler {
  const now = options.now ?? (() => new Date());
  let interval: NodeJS.Timeout | undefined;
  let active: Promise<unknown> | undefined;

  const enqueueDueSyncs = async (at: Date): Promise<number> => {
    const due = await listInstagramAccountsDueForSync(options.database, {
      dueBefore: new Date(at.getTime() - instagramAccountSyncIntervalHours * hourMilliseconds),
      limit: options.batchSize,
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
            handlerVersion: instagramSyncQueue.version,
            idempotencyKey: instagramScheduledSyncKey(account.accountId, at),
            priority: instagramSyncPriority("SCHEDULED"),
            queueName: instagramSyncQueue.name,
            resourceId: account.accountId,
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
            event: "instagram.sync.schedule_failed",
            stage: "sync_scheduling",
          },
          { logger: options.logger, monitor: options.errorMonitor },
        );
      }
    }

    return enqueued;
  };

  const enqueueDueSnapshots = async (at: Date): Promise<number> => {
    const due = await listInstagramPostsDueForSnapshot(options.database, {
      limit: options.batchSize,
      now: at,
    });

    let enqueued = 0;
    for (const post of due) {
      const correlationId: CorrelationId = createCorrelationId();
      try {
        const result = await enqueueBackgroundJob(
          options.database,
          createWorkspaceContext(post.workspaceId),
          {
            correlationId,
            handlerVersion: instagramSnapshotQueue.version,
            idempotencyKey: instagramSnapshotKey(post.postId, post.ageBucket),
            queueName: instagramSnapshotQueue.name,
            resourceId: post.postId,
            resourceType: "instagram_post",
          },
        );
        if (result.created) enqueued += 1;
      } catch (error) {
        reportError(
          error,
          {
            correlationId,
            event: "instagram.snapshot.schedule_failed",
            stage: "snapshot_scheduling",
          },
          { logger: options.logger, monitor: options.errorMonitor },
        );
      }
    }

    return enqueued;
  };

  const sweep = async (): Promise<InstagramSweepResult> => {
    const at = now();
    const syncs = await enqueueDueSyncs(at);
    const snapshots = await enqueueDueSnapshots(at);

    // Reported separately because the log schema carries one measurement per
    // event, and the two sweeps fail and succeed independently.
    if (syncs > 0) {
      options.logger.info("instagram.sync.scheduled", {
        correlationId: createCorrelationId(),
        stage: "sync_scheduling",
        unit: "accounts",
        value: syncs,
      });
    }
    if (snapshots > 0) {
      options.logger.info("instagram.snapshot.scheduled", {
        correlationId: createCorrelationId(),
        stage: "snapshot_scheduling",
        unit: "posts",
        value: snapshots,
      });
    }

    return Object.freeze({ snapshots, syncs });
  };

  const tick = (): void => {
    // Never overlap sweeps: a slow one would otherwise stack behind itself and
    // re-read the same due work.
    if (active) return;

    active = sweep()
      .catch((error: unknown) => {
        reportError(
          error,
          {
            correlationId: createCorrelationId(),
            event: "instagram.sync.sweep_failed",
            stage: "sync_scheduling",
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
