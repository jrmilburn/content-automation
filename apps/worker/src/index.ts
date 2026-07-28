import { loadDatabaseConfig, loadRuntimeConfig } from "@studio-parallel/config";
import { createDatabaseClient } from "@studio-parallel/db";
import { queueDefinitions } from "@studio-parallel/domain";
import {
  createCorrelationId,
  createErrorMonitor,
  createJsonLogger,
  createLoggerMetricSink,
  createMetricRecorder,
  reportError,
} from "@studio-parallel/observability";
import { createPgBossWorkerQueue } from "@studio-parallel/queue/worker";

import { createHealthServer } from "./health.js";
import { createOutboxReconciler } from "./outbox-reconciler.js";

const config = loadRuntimeConfig();
const databaseConfig = loadDatabaseConfig();
const lifecycleCorrelationId = createCorrelationId();
const logger = createJsonLogger({
  environment: config.APP_ENV,
  level: config.LOG_LEVEL,
  release: config.APP_RELEASE,
  service: "worker",
});
const metrics = createMetricRecorder({
  environment: config.APP_ENV,
  release: config.APP_RELEASE,
  service: "worker",
  sink: createLoggerMetricSink(logger),
});
const errorMonitor = createErrorMonitor({
  environment: config.APP_ENV,
  release: config.APP_RELEASE,
  service: "worker",
});
const server = createHealthServer({ logger, metrics });
const database = createDatabaseClient(databaseConfig.DATABASE_URL);
const queue = createPgBossWorkerQueue({
  connectionString: databaseConfig.DATABASE_URL,
  onError: (error) =>
    reportError(
      error,
      {
        correlationId: lifecycleCorrelationId,
        event: "queue.runtime_failed",
        stage: "queue",
      },
      { logger, monitor: errorMonitor },
    ),
});
const reconciler = createOutboxReconciler({
  batchSize: config.QUEUE_DISPATCH_BATCH_SIZE,
  correlationId: lifecycleCorrelationId,
  database,
  errorMonitor,
  intervalMs: config.QUEUE_RECONCILE_INTERVAL_SECONDS * 1_000,
  logger,
  metrics,
  publisher: queue,
});
let shutdownPromise: Promise<void> | undefined;

void start();

async function start(): Promise<void> {
  try {
    await queue.start();
    await queue.verifyQueues(queueDefinitions);
    reconciler.start();
    server.listen(config.WORKER_HEALTH_PORT, () => {
      logger.info("worker.started", {
        correlationId: lifecycleCorrelationId,
        stage: "startup",
      });
    });
  } catch (error) {
    reportError(
      error,
      {
        correlationId: lifecycleCorrelationId,
        event: "worker.start_failed",
        stage: "startup",
      },
      { logger, monitor: errorMonitor },
    );
    process.exitCode = 1;
    await shutDown("SIGTERM");
  }
}

function shutDown(signal: NodeJS.Signals): Promise<void> {
  if (shutdownPromise) return shutdownPromise;

  logger.info("worker.stopping", {
    correlationId: lifecycleCorrelationId,
    signal,
    stage: "shutdown",
  });

  shutdownPromise = (async () => {
    try {
      await reconciler.stop();
      await queue.stop({
        graceful: true,
        timeoutMs: config.WORKER_SHUTDOWN_GRACE_SECONDS * 1_000,
      });
      await database.$disconnect();
      await closeServer();
    } catch (error) {
      reportError(
        error,
        {
          correlationId: lifecycleCorrelationId,
          event: "worker.stop_failed",
          stage: "shutdown",
        },
        { logger, monitor: errorMonitor },
      );
      process.exitCode = 1;
    }
  })();

  return shutdownPromise;
}

function closeServer(): Promise<void> {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

process.once("SIGINT", (signal) => void shutDown(signal));
process.once("SIGTERM", (signal) => void shutDown(signal));
