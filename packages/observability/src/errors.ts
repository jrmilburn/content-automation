import { randomUUID } from "node:crypto";

import type { ServiceName } from "@studio-parallel/domain";

import {
  normaliseSafeResourceId,
  parseCorrelationId,
  type CorrelationId,
  type SafeResourceIds,
} from "./correlation.js";
import type { JsonLogger, LogAttributes } from "./logger.js";

export const operationalErrorClasses = [
  "validation",
  "authorisation",
  "not_found",
  "conflict",
  "rate_limit",
  "dependency",
  "internal",
] as const;

export type OperationalErrorClass = (typeof operationalErrorClasses)[number];

export class OperationalError extends Error {
  readonly code: string;
  readonly errorClass: OperationalErrorClass;
  readonly expected: boolean;
  readonly retryable: boolean;
  readonly statusCode: number;

  constructor(
    options: Readonly<{
      code: string;
      errorClass: OperationalErrorClass;
      retryable?: boolean;
      statusCode: number;
    }>,
  ) {
    const code = normaliseCode(options.code);
    super(code);
    this.name = "OperationalError";
    this.code = code;
    this.errorClass = options.errorClass;
    this.expected = !["dependency", "internal"].includes(options.errorClass);
    this.retryable = options.retryable ?? false;
    this.statusCode = normaliseStatusCode(options.statusCode);
  }
}

export type SafeErrorDetails = Readonly<{
  errorClass: OperationalErrorClass | "unexpected";
  errorCode: string;
  errorName: string;
  expected: boolean;
  retryable: boolean;
  statusCode: number;
}>;

export type ErrorContext = Readonly<
  SafeResourceIds & {
    correlationId: CorrelationId;
    event: string;
    stage: string;
  }
>;

export type ErrorMonitoringEvent = Readonly<{
  id: string;
  timestamp: string;
  service: ServiceName;
  environment: string;
  release: string;
  event: string;
  stage: string;
  correlationId: CorrelationId;
  errorClass: string;
  errorCode: string;
  errorName: string;
  retryable: boolean;
  accountId?: string;
  actorId?: string;
  jobId?: string;
  postId?: string;
  workspaceId?: string;
}>;

export type ErrorMonitor = Readonly<{
  captureException(error: unknown, context: ErrorContext): string | undefined;
}>;

export type ErrorMonitorTransport = (event: ErrorMonitoringEvent) => void;

export type ReportedError = Readonly<
  SafeErrorDetails & {
    monitoringEventId?: string;
  }
>;

type ErrorMonitorConfig = Readonly<{
  environment: string;
  now?: () => Date;
  release: string;
  service: ServiceName;
  transport?: ErrorMonitorTransport;
}>;

const safeNamePattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const safeCodePattern = /^[A-Z][A-Z0-9_]{0,63}$/u;

export function classifyError(error: unknown): SafeErrorDetails {
  if (error instanceof OperationalError) {
    return Object.freeze({
      errorClass: error.errorClass,
      errorCode: error.code,
      errorName: error.name,
      expected: error.expected,
      retryable: error.retryable,
      statusCode: error.statusCode,
    });
  }

  return Object.freeze({
    errorClass: "unexpected",
    errorCode: "UNEXPECTED_ERROR",
    errorName: normaliseName(error instanceof Error ? error.name : "UnknownError"),
    expected: false,
    retryable: false,
    statusCode: 500,
  });
}

export function createErrorMonitor(config: ErrorMonitorConfig): ErrorMonitor {
  const environment = normaliseName(config.environment);
  const release = normaliseName(config.release);
  const now = config.now ?? (() => new Date());

  return Object.freeze({
    captureException(error, context) {
      const details = classifyError(error);
      const correlationId = parseCorrelationId(context.correlationId);

      if (details.expected || !config.transport || !correlationId) {
        return undefined;
      }

      const id = randomUUID();
      const resourceIds = normaliseResourceIds(context);

      config.transport(
        Object.freeze({
          id,
          timestamp: now().toISOString(),
          service: config.service,
          environment,
          release,
          event: normaliseName(context.event),
          stage: normaliseName(context.stage),
          correlationId,
          errorClass: details.errorClass,
          errorCode: details.errorCode,
          errorName: details.errorName,
          retryable: details.retryable,
          ...resourceIds,
        }),
      );

      return id;
    },
  });
}

export function reportError(
  error: unknown,
  context: ErrorContext,
  dependencies: Readonly<{ logger: JsonLogger; monitor: ErrorMonitor }>,
): ReportedError {
  const details = classifyError(error);
  const attributes: LogAttributes = {
    correlationId: context.correlationId,
    stage: context.stage,
    ...normaliseResourceIds(context),
    errorClass: details.errorClass,
    errorCode: details.errorCode,
    expected: details.expected,
    retryable: details.retryable,
    statusCode: details.statusCode,
  };

  if (details.expected) {
    dependencies.logger.warn(context.event, attributes);
    return details;
  }

  dependencies.logger.error(context.event, attributes);
  const monitoringEventId = dependencies.monitor.captureException(error, context);

  return Object.freeze({
    ...details,
    ...(monitoringEventId ? { monitoringEventId } : {}),
  });
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

function normaliseCode(value: string): string {
  return safeCodePattern.test(value) ? value : "OPERATION_FAILED";
}

function normaliseName(value: string): string {
  return safeNamePattern.test(value) ? value : "unknown";
}

function normaliseStatusCode(value: number): number {
  return Number.isInteger(value) && value >= 400 && value <= 599 ? value : 500;
}
