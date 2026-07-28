import { loadRuntimeConfig } from "@studio-parallel/config";
import {
  createCorrelationId,
  createErrorMonitor,
  createJsonLogger,
  createLoggerMetricSink,
  createMetricRecorder,
  reportError,
} from "@studio-parallel/observability";

import { createHealthServer } from "./health.js";

const config = loadRuntimeConfig();
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

server.listen(config.WORKER_HEALTH_PORT, () => {
  logger.info("worker.started", {
    correlationId: lifecycleCorrelationId,
    stage: "startup",
  });
});

function shutDown(signal: NodeJS.Signals): void {
  logger.info("worker.stopping", {
    correlationId: lifecycleCorrelationId,
    signal,
    stage: "shutdown",
  });

  server.close((error) => {
    if (error) {
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
  });
}

process.once("SIGINT", shutDown);
process.once("SIGTERM", shutDown);
