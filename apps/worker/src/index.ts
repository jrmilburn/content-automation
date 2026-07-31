import {
  loadCredentialEncryptionConfig,
  loadDatabaseConfig,
  loadRuntimeConfig,
} from "@studio-parallel/config";
import { createDatabaseClient, decodeMasterKey } from "@studio-parallel/db";
import { queueDefinitions } from "@studio-parallel/domain";
import {
  createCorrelationId,
  createErrorMonitor,
  createJsonLogger,
  createLoggerMetricSink,
  createMetricRecorder,
  reportError,
} from "@studio-parallel/observability";
import {
  createPgBossWorkerQueue,
  createProviderConcurrencyGate,
  createQueueHandlerRegistry,
  createQueueWorkerRuntime,
} from "@studio-parallel/queue/worker";

import { createHealthServer } from "./health.js";
import {
  createInstagramSyncAccountHandler,
  instagramSyncQueue,
} from "./instagram/sync-account-handler.js";
import {
  createInstagramSnapshotPostHandler,
  instagramSnapshotQueue,
} from "./instagram/snapshot-post-handler.js";
import {
  createInstagramTokenMaintainHandler,
  instagramTokenQueue,
} from "./instagram/token-maintain-handler.js";
import { createInstagramTokenMaintenanceScheduler } from "./instagram/token-maintenance-scheduler.js";
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
// Meta limits by app and by account, so provider work is serialised rather than
// scaled with the worker's own concurrency.
const providerConcurrency = createProviderConcurrencyGate({
  globalLimit: 4,
  providerLimits: { instagram: 1 },
});
// Loaded on first use so a deployment that has not yet configured Instagram
// still starts, and so the key is read once rather than per job. The version is
// the one new ciphertext is sealed under; the map is what existing ciphertext is
// opened with, so a rotation can add an old version without changing writes.
let credentialEncryption:
  Readonly<{ keyVersion: number; masterKeys: ReadonlyMap<number, Buffer> }> | undefined;
const loadEncryption = (): Readonly<{
  keyVersion: number;
  masterKeys: ReadonlyMap<number, Buffer>;
}> => {
  if (!credentialEncryption) {
    const encryption = loadCredentialEncryptionConfig();
    credentialEncryption = Object.freeze({
      keyVersion: encryption.CREDENTIAL_ENCRYPTION_KEY_VERSION,
      masterKeys: new Map([
        [
          encryption.CREDENTIAL_ENCRYPTION_KEY_VERSION,
          decodeMasterKey(encryption.CREDENTIAL_ENCRYPTION_KEY),
        ],
      ]),
    });
  }
  return credentialEncryption;
};
const registry = createQueueHandlerRegistry([
  createInstagramSyncAccountHandler({
    acquireConcurrency: (signal) => providerConcurrency.acquire("instagram", signal),
    database,
    loadMasterKeys: () => loadEncryption().masterKeys,
    logger,
  }),
  createInstagramSnapshotPostHandler({
    // Shares the provider gate with every other Instagram queue, so snapshots
    // cannot crowd out a sync or a token refresh against the same rate limit.
    acquireConcurrency: (signal) => providerConcurrency.acquire("instagram", signal),
    database,
    loadMasterKeys: () => loadEncryption().masterKeys,
    logger,
  }),
  createInstagramTokenMaintainHandler({
    acquireConcurrency: (signal) => providerConcurrency.acquire("instagram", signal),
    database,
    loadEncryption,
    logger,
  }),
]);
const workerRuntime = createQueueWorkerRuntime({
  client: queue,
  registry,
  requiredQueues: [instagramSnapshotQueue, instagramSyncQueue, instagramTokenQueue],
});
const tokenMaintenance = createInstagramTokenMaintenanceScheduler({
  batchSize: config.QUEUE_DISPATCH_BATCH_SIZE,
  database,
  errorMonitor,
  // Expiry moves in days, so this sweep is deliberately far less frequent than
  // outbox dispatch; the daily idempotency key makes the exact interval safe.
  intervalMs: config.QUEUE_RECONCILE_INTERVAL_SECONDS * 1_000 * 60,
  logger,
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
    // The runtime starts the client and subscribes the registered handlers;
    // every remaining definition is still verified so publishing to a queue
    // this worker does not consume cannot silently create a mismatched queue.
    await workerRuntime.start();
    await queue.verifyQueues(queueDefinitions);
    reconciler.start();
    tokenMaintenance.start();
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
      await tokenMaintenance.stop();
      await reconciler.stop();
      await workerRuntime.stop({
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
