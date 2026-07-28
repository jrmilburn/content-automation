import {
  reconcileBackgroundJobs,
  reconcileJobOutbox,
  type DatabaseClient,
  type JobCleanupDebtHook,
  type JobResultInspection,
  type ReconciliationJob,
} from "@studio-parallel/db";
import type { QueuePublisher } from "@studio-parallel/domain";
import {
  reportError,
  type CorrelationId,
  type ErrorMonitor,
  type JsonLogger,
  type MetricRecorder,
} from "@studio-parallel/observability";

export type OutboxReconciler = Readonly<{
  start(): void;
  stop(): Promise<void>;
}>;

export function createOutboxReconciler(options: {
  batchSize: number;
  correlationId: CorrelationId;
  database: DatabaseClient;
  errorMonitor: ErrorMonitor;
  inspectResult?: (
    database: DatabaseClient,
    job: ReconciliationJob,
  ) => Promise<JobResultInspection>;
  intervalMs: number;
  logger: JsonLogger;
  metrics: MetricRecorder;
  publisher: QueuePublisher;
  cleanupDebtHooks?: readonly JobCleanupDebtHook[];
}): OutboxReconciler {
  let interval: NodeJS.Timeout | undefined;
  let active: Promise<void> | undefined;

  const tick = (): void => {
    if (active) return;

    active = reconcileBackgroundJobs({
      batchSize: options.batchSize,
      correlationId: options.correlationId,
      database: options.database,
      inspectResult: options.inspectResult ?? (async () => "UNSUPPORTED"),
      telemetry: { logger: options.logger, metrics: options.metrics },
      ...(options.cleanupDebtHooks ? { cleanupDebtHooks: options.cleanupDebtHooks } : {}),
    })
      .then(async (logicalResult) => {
        const dispatchResult = await reconcileJobOutbox(
          options.database,
          options.publisher,
          { logger: options.logger, monitor: options.errorMonitor },
          { batchSize: options.batchSize },
        );
        if (logicalResult.repaired + logicalResult.flagged + dispatchResult.claimed > 0) {
          options.logger.info("job.reconciliation_completed", {
            correlationId: options.correlationId,
            outcome: logicalResult.flagged > 0 ? "FLAGGED" : "COMPLETED",
            source: "reconciliation",
            stage: "reconciliation",
            value: logicalResult.repaired + logicalResult.flagged + dispatchResult.claimed,
          });
        }
      })
      .catch((error: unknown) => {
        reportError(
          error,
          {
            correlationId: options.correlationId,
            event: "job.reconciliation_failed",
            stage: "reconciliation",
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
  });
}
