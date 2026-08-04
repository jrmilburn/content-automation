import {
  loadCredentialEncryptionConfig,
  loadDatabaseConfig,
  loadGeminiConfig,
  loadMediaValidationConfig,
  loadObjectStorageConfig,
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
import {
  createInstagramMediaImportHandler,
  instagramMediaImportQueue,
} from "./instagram/media-import-handler.js";
import { createInstagramSyncScheduler } from "./instagram/sync-scheduler.js";
import { createInstagramTokenMaintenanceScheduler } from "./instagram/token-maintenance-scheduler.js";
import { createOutboxReconciler } from "./outbox-reconciler.js";
import { assetCleanupQueue, createAssetCleanupHandler } from "./uploads/asset-cleanup-handler.js";
import { createAssetCleanupScheduler } from "./uploads/asset-cleanup-scheduler.js";
import {
  assetValidateQueue,
  createAssetValidateHandler,
} from "./uploads/asset-validate-handler.js";
import { createFfprobeMediaProbe } from "./uploads/media-probe.js";
import { createAnalysisRunHandler, analysisRunQueue } from "./analysis/analysis-run-handler.js";
import {
  analyticsRecalculateQueue,
  createAnalyticsRecalculateHandler,
} from "./analytics/recalculate-handler.js";
import { createAnalyticsScheduler } from "./analytics/analytics-scheduler.js";
import {
  createStrategyGenerateHandler,
  strategyGenerateQueue,
} from "./strategy/strategy-generate-handler.js";
import { createWorkerGeminiAdapter } from "./analysis/gemini-client.js";
import { createWorkerObjectStorage } from "./uploads/object-storage.js";

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
// Only host, model and budgets are read here. The key loads inside the live
// branch of `createWorkerGeminiAdapter`, so a deployment without one still
// starts.
const geminiConfig = loadGeminiConfig();
// Gemini bills per token, so its budget is a spend control rather than a
// politeness limit: a burst of parallel analyses is the fastest way to spend
// unintentionally. The global limit leaves room for both providers at once.
const providerConcurrency = createProviderConcurrencyGate({
  globalLimit: 6,
  providerLimits: { gemini: geminiConfig.GEMINI_PROJECT_CONCURRENCY, instagram: 1 },
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
const storageConfig = loadObjectStorageConfig();
const mediaConfig = loadMediaValidationConfig();
const objectStorage = createWorkerObjectStorage(config, storageConfig);
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
  createInstagramMediaImportHandler({
    // Reads the media node and then pulls the file, so it holds the same
    // provider slot as every other Instagram queue rather than competing with
    // them for Meta's rate limit.
    acquireConcurrency: (signal) => providerConcurrency.acquire("instagram", signal),
    database,
    environment: config.APP_ENV,
    loadMasterKeys: () => loadEncryption().masterKeys,
    logger,
    storage: objectStorage,
    storageConfig,
  }),
  createAssetCleanupHandler({
    database,
    logger,
    storage: objectStorage,
  }),
  createAssetValidateHandler({
    database,
    logger,
    mediaConfig,
    probe: createFfprobeMediaProbe(),
    storage: objectStorage,
    storageConfig,
  }),
  createAnalysisRunHandler({
    // Gemini bills per token, so the budget wraps the whole attempt rather than
    // just the HTTP call: a video upload holds the slot too.
    acquireConcurrency: (signal) => providerConcurrency.acquire("gemini", signal),
    database,
    gemini: createWorkerGeminiAdapter(config, geminiConfig),
    logger,
    storage: objectStorage,
  }),
  createAnalyticsRecalculateHandler({
    database,
    logger,
  }),
  createStrategyGenerateHandler({
    // Text-only, but it is the same paid project as analysis, so it holds the
    // same slot rather than competing for quota beside it.
    acquireConcurrency: (signal) => providerConcurrency.acquire("gemini", signal),
    database,
    gemini: createWorkerGeminiAdapter(config, geminiConfig),
    logger,
  }),
]);
const workerRuntime = createQueueWorkerRuntime({
  client: queue,
  registry,
  requiredQueues: [
    analysisRunQueue,
    analyticsRecalculateQueue,
    assetCleanupQueue,
    assetValidateQueue,
    instagramMediaImportQueue,
    instagramSnapshotQueue,
    instagramSyncQueue,
    instagramTokenQueue,
    strategyGenerateQueue,
  ],
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
const syncScheduler = createInstagramSyncScheduler({
  batchSize: config.QUEUE_DISPATCH_BATCH_SIZE,
  database,
  errorMonitor,
  // Finer than token maintenance because the shortest snapshot bucket closes in
  // two hours; the bucketed idempotency keys make the exact interval safe.
  intervalMs: config.QUEUE_RECONCILE_INTERVAL_SECONDS * 1_000 * 12,
  logger,
});
const assetCleanup = createAssetCleanupScheduler({
  batchSize: config.QUEUE_DISPATCH_BATCH_SIZE,
  database,
  errorMonitor,
  // Abandonment is measured in hours, so this sweep runs on the same slow
  // cadence as token maintenance; the daily idempotency key makes the exact
  // interval safe.
  intervalMs: config.QUEUE_RECONCILE_INTERVAL_SECONDS * 1_000 * 60,
  logger,
});
const analyticsScheduler = createAnalyticsScheduler({
  batchSize: config.QUEUE_DISPATCH_BATCH_SIZE,
  database,
  errorMonitor,
  // The debounce window is five minutes, so sweeping much faster than that only
  // rediscovers the same accounts; the dirty-anchored idempotency key makes the
  // exact interval safe either way.
  intervalMs: config.QUEUE_RECONCILE_INTERVAL_SECONDS * 1_000 * 12,
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
    syncScheduler.start();
    assetCleanup.start();
    analyticsScheduler.start();
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
      await analyticsScheduler.stop();
      await assetCleanup.stop();
      await syncScheduler.stop();
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
