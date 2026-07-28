import { reconcileJobOutbox, type DatabaseClient } from "@studio-parallel/db";
import type { QueuePublisher } from "@studio-parallel/domain";
import {
  reportError,
  type CorrelationId,
  type ErrorMonitor,
  type JsonLogger,
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
  intervalMs: number;
  logger: JsonLogger;
  publisher: QueuePublisher;
}): OutboxReconciler {
  let interval: NodeJS.Timeout | undefined;
  let active: Promise<void> | undefined;

  const tick = (): void => {
    if (active) return;

    active = reconcileJobOutbox(
      options.database,
      options.publisher,
      { logger: options.logger, monitor: options.errorMonitor },
      { batchSize: options.batchSize },
    )
      .then((result) => {
        if (result.claimed > 0) {
          options.logger.info("job.reconciliation_completed", {
            correlationId: options.correlationId,
            stage: "reconciliation",
            value: result.claimed,
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
