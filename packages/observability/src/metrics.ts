import type { ServiceName } from "@studio-parallel/domain";

import {
  normaliseSafeResourceId,
  parseCorrelationId,
  type CorrelationId,
  type SafeResourceIds,
} from "./correlation.js";
import type { JsonLogger } from "./logger.js";

export const metricNames = [
  "error.count",
  "health.check.count",
  "operation.duration_ms",
  "web.request.count",
  "worker.event.count",
] as const;

export type MetricName = (typeof metricNames)[number];
export type MetricUnit = "count" | "milliseconds";

export type MetricContext = Readonly<
  SafeResourceIds & {
    correlationId: CorrelationId;
    stage: string;
  }
>;

export type MetricEvent = Readonly<{
  timestamp: string;
  service: ServiceName;
  environment: string;
  release: string;
  metric: MetricName;
  value: number;
  unit: MetricUnit;
  stage: string;
  correlationId: CorrelationId;
  accountId?: string;
  actorId?: string;
  jobId?: string;
  postId?: string;
  workspaceId?: string;
}>;

export type MetricSink = (event: MetricEvent) => void;

export type MetricRecorder = Readonly<{
  increment(name: MetricName, context: MetricContext, amount?: number): void;
  observe(name: MetricName, value: number, unit: MetricUnit, context: MetricContext): void;
}>;

type MetricRecorderConfig = Readonly<{
  environment: string;
  now?: () => Date;
  release: string;
  service: ServiceName;
  sink?: MetricSink;
}>;

const safeNamePattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

export function createMetricRecorder(config: MetricRecorderConfig): MetricRecorder {
  const now = config.now ?? (() => new Date());

  function record(name: MetricName, value: number, unit: MetricUnit, context: MetricContext): void {
    const correlationId = parseCorrelationId(context.correlationId);

    if (!config.sink || !correlationId || !Number.isFinite(value) || value < 0) {
      return;
    }

    config.sink(
      Object.freeze({
        timestamp: now().toISOString(),
        service: config.service,
        environment: normaliseName(config.environment),
        release: normaliseName(config.release),
        metric: name,
        value,
        unit,
        stage: normaliseName(context.stage),
        correlationId,
        ...normaliseResourceIds(context),
      }),
    );
  }

  return Object.freeze({
    increment(name, context, amount = 1) {
      record(name, amount, "count", context);
    },
    observe(name, value, unit, context) {
      record(name, value, unit, context);
    },
  });
}

export function createLoggerMetricSink(logger: JsonLogger): MetricSink {
  return (event) => {
    logger.info("metric.recorded", {
      correlationId: event.correlationId,
      stage: event.stage,
      metric: event.metric,
      value: event.value,
      unit: event.unit,
      ...(event.accountId ? { accountId: event.accountId } : {}),
      ...(event.actorId ? { actorId: event.actorId } : {}),
      ...(event.jobId ? { jobId: event.jobId } : {}),
      ...(event.postId ? { postId: event.postId } : {}),
      ...(event.workspaceId ? { workspaceId: event.workspaceId } : {}),
    });
  };
}

function normaliseResourceIds(resourceIds: SafeResourceIds): SafeResourceIds {
  const entries = (["accountId", "actorId", "jobId", "postId", "workspaceId"] as const).flatMap(
    (key) => {
      const value = normaliseSafeResourceId(resourceIds[key]);
      return value ? ([[key, value]] as const) : [];
    },
  );

  return Object.fromEntries(entries);
}

function normaliseName(value: string): string {
  return safeNamePattern.test(value) ? value : "unknown";
}
