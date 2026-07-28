import { randomUUID } from "node:crypto";

export const correlationHeaderName = "x-correlation-id";

declare const correlationIdBrand: unique symbol;

export type CorrelationId = string & { readonly [correlationIdBrand]: true };

export type SafeResourceIds = Readonly<{
  accountId?: string;
  actorId?: string;
  jobId?: string;
  postId?: string;
  workspaceId?: string;
}>;

export type WebRequestContext = Readonly<
  SafeResourceIds & {
    correlationId: CorrelationId;
    kind: "web_request";
  }
>;

export type DomainCommandContext = Readonly<
  SafeResourceIds & {
    correlationId: CorrelationId;
    kind: "domain_command";
  }
>;

export type WorkerEventContext = Readonly<
  SafeResourceIds & {
    attempt?: number;
    correlationId: CorrelationId;
    kind: "worker_event";
  }
>;

type HeaderSource =
  | Readonly<Record<string, string | readonly string[] | undefined>>
  | Readonly<{ get(name: string): string | null }>;

const correlationIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const safeResourceIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

export function parseCorrelationId(value: string | null | undefined): CorrelationId | undefined {
  const candidate = value?.trim();

  return candidate && correlationIdPattern.test(candidate)
    ? (candidate.toLowerCase() as CorrelationId)
    : undefined;
}

export function createCorrelationId(generate: () => string = randomUUID): CorrelationId {
  const correlationId = parseCorrelationId(generate());

  if (!correlationId) {
    throw new Error("Correlation ID generator returned an invalid identifier");
  }

  return correlationId;
}

export function createWebRequestContext(
  headers: HeaderSource,
  generate: () => string = randomUUID,
): WebRequestContext {
  return Object.freeze({
    correlationId:
      parseCorrelationId(readHeader(headers, correlationHeaderName)) ??
      createCorrelationId(generate),
    kind: "web_request",
  });
}

export function createDomainCommandContext(
  request: Pick<WebRequestContext, "correlationId">,
  resourceIds: SafeResourceIds = {},
): DomainCommandContext {
  return Object.freeze({
    correlationId: request.correlationId,
    kind: "domain_command",
    ...normaliseResourceIds(resourceIds),
  });
}

export function createWorkerEventContext(
  command: Pick<DomainCommandContext, "correlationId"> & SafeResourceIds,
  event: Readonly<{ attempt?: number; jobId?: string }> = {},
): WorkerEventContext {
  const attempt =
    event.attempt !== undefined && Number.isSafeInteger(event.attempt) && event.attempt >= 0
      ? event.attempt
      : undefined;

  return Object.freeze({
    correlationId: command.correlationId,
    kind: "worker_event",
    ...normaliseResourceIds({
      ...command,
      ...(event.jobId ? { jobId: event.jobId } : {}),
    }),
    ...(attempt === undefined ? {} : { attempt }),
  });
}

export function normaliseSafeResourceId(value: unknown): string | undefined {
  return typeof value === "string" && safeResourceIdPattern.test(value) ? value : undefined;
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

function readHeader(headers: HeaderSource, name: string): string | undefined {
  if (isHeaderReader(headers)) {
    return headers.get(name) ?? undefined;
  }

  const value = headers[name] ?? headers[name.toLowerCase()];
  return typeof value === "string" ? value : value?.[0];
}

function isHeaderReader(
  headers: HeaderSource,
): headers is Readonly<{ get(name: string): string | null }> {
  return "get" in headers && typeof headers.get === "function";
}
