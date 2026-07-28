import "server-only";

import {
  createErrorMonitor,
  createJsonLogger,
  createLoggerMetricSink,
  createMetricRecorder,
} from "@studio-parallel/observability";

import { loadRuntimeConfig } from "./config";

const config = loadRuntimeConfig();

export const webLogger = createJsonLogger({
  environment: config.APP_ENV,
  level: config.LOG_LEVEL,
  release: config.APP_RELEASE,
  service: "web",
});

export const webMetrics = createMetricRecorder({
  environment: config.APP_ENV,
  release: config.APP_RELEASE,
  service: "web",
  sink: createLoggerMetricSink(webLogger),
});

export const webErrorMonitor = createErrorMonitor({
  environment: config.APP_ENV,
  release: config.APP_RELEASE,
  service: "web",
});
