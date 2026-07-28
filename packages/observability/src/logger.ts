import type { ServiceName } from "@studio-parallel/domain";

import { normaliseSafeResourceId, parseCorrelationId, type CorrelationId } from "./correlation.js";

export const logLevels = ["debug", "info", "warn", "error"] as const;

export type LogLevel = (typeof logLevels)[number];

export type LogAttributes = Readonly<{
  accountId?: string;
  actorId?: string;
  attempt?: number;
  correlationId: CorrelationId;
  durationMs?: number;
  errorClass?: string;
  errorCode?: string;
  expected?: boolean;
  healthKind?: "live" | "ready";
  jobId?: string;
  method?: string;
  metric?: string;
  postId?: string;
  providerRequestId?: string;
  providerStatus?: number;
  retryable?: boolean;
  route?: string;
  signal?: string;
  stage: string;
  statusCode?: number;
  unit?: string;
  value?: number;
  workspaceId?: string;
}>;

export type JsonLogEvent = Readonly<{
  timestamp: string;
  level: LogLevel;
  service: ServiceName;
  environment: string;
  release: string;
  event: string;
  stage: string;
  correlationId: CorrelationId;
  [key: string]: boolean | number | string;
}>;

export type LogSink = (event: JsonLogEvent) => void;

export type JsonLogger = Readonly<{
  debug(event: string, attributes: LogAttributes): void;
  error(event: string, attributes: LogAttributes): void;
  info(event: string, attributes: LogAttributes): void;
  warn(event: string, attributes: LogAttributes): void;
}>;

type LoggerConfig = Readonly<{
  environment: string;
  level?: LogLevel;
  now?: () => Date;
  release: string;
  service: ServiceName;
  sink?: LogSink;
}>;

const safeTokenPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const safeEventPattern = /^[a-z][a-z0-9_.-]{0,127}$/u;
const safeRoutePattern = /^\/[A-Za-z0-9/_.{}-]*$/u;
const levelRank = new Map(logLevels.map((level, index) => [level, index]));

export function createJsonLogger(config: LoggerConfig): JsonLogger {
  const environment = normaliseToken(config.environment, "unknown");
  const release = normaliseToken(config.release, "unknown");
  const threshold = levelRank.get(config.level ?? "info") ?? 1;
  const now = config.now ?? (() => new Date());
  const sink = config.sink ?? writeJsonEvent;

  function write(level: LogLevel, event: string, attributes: LogAttributes): void {
    if ((levelRank.get(level) ?? 0) < threshold) {
      return;
    }

    const correlationId = parseCorrelationId(attributes.correlationId);
    if (!correlationId) {
      return;
    }

    const record: JsonLogEvent = Object.freeze({
      timestamp: now().toISOString(),
      level,
      service: config.service,
      environment,
      release,
      event: normaliseEventName(event),
      stage: normaliseToken(attributes.stage, "unknown"),
      correlationId,
      ...pickAllowedAttributes(attributes),
    });

    sink(record);
  }

  return Object.freeze({
    debug: (event, attributes) => write("debug", event, attributes),
    error: (event, attributes) => write("error", event, attributes),
    info: (event, attributes) => write("info", event, attributes),
    warn: (event, attributes) => write("warn", event, attributes),
  });
}

function pickAllowedAttributes(
  attributes: LogAttributes,
): Record<string, boolean | number | string> {
  const output: Record<string, boolean | number | string> = {};

  for (const key of ["accountId", "actorId", "jobId", "postId", "workspaceId"] as const) {
    const value = normaliseSafeResourceId(attributes[key]);
    if (value) output[key] = value;
  }

  const providerRequestId = normaliseSafeResourceId(attributes.providerRequestId);
  if (providerRequestId) output.providerRequestId = providerRequestId;

  for (const key of ["errorClass", "errorCode", "metric", "signal", "unit"] as const) {
    const value = attributes[key];
    if (value) output[key] = normaliseToken(value, "unknown");
  }

  if (attributes.method) {
    output.method = normaliseToken(attributes.method.toUpperCase(), "UNKNOWN");
  }

  if (attributes.route) {
    const path = attributes.route.split("?", 1)[0];
    if (path && safeRoutePattern.test(path)) output.route = path;
  }

  for (const key of ["attempt", "durationMs", "providerStatus", "statusCode", "value"] as const) {
    const value = attributes[key];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) output[key] = value;
  }

  for (const key of ["expected", "retryable"] as const) {
    const value = attributes[key];
    if (typeof value === "boolean") output[key] = value;
  }

  if (attributes.healthKind) output.healthKind = attributes.healthKind;

  return output;
}

function normaliseEventName(value: string): string {
  return safeEventPattern.test(value) ? value : "invalid_event";
}

function normaliseToken(value: string, fallback: string): string {
  return safeTokenPattern.test(value) ? value : fallback;
}

function writeJsonEvent(event: JsonLogEvent): void {
  const destination = event.level === "error" ? process.stderr : process.stdout;
  destination.write(`${JSON.stringify(event)}\n`);
}
