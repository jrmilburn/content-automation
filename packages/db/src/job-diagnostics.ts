import {
  isQueueName,
  isSafeJobStage,
  jobFailureClasses,
  jobNextActions,
  type BackgroundJobState,
  type JobAttemptState,
  type QueueName,
} from "@studio-parallel/domain";
import { OperationalError } from "@studio-parallel/observability";

import type { SessionPrincipal } from "./auth.js";
import type { Prisma, PrismaClient } from "./generated/prisma/client.js";
import { isUuidV7 } from "./id.js";
import { isSafeProcessingCancellationStage } from "./job-operations.js";

const listLimit = 100;
const safeIdentifierPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const safeCodePattern = /^[A-Z][A-Z0-9_]{0,63}$/u;
const safeErrorClasses = new Set<string>(jobFailureClasses);
const safeNextActions = new Set<string>(jobNextActions);

export type JobDiagnosticFilters = Readonly<{
  attention?: boolean;
  matchesNothing?: boolean;
  queueName?: QueueName;
  resourceId?: string;
  state?: BackgroundJobState;
}>;

export type JobActionUnavailableReason =
  | "ADMIN_REQUIRED"
  | "ATTEMPT_LIMIT_REACHED"
  | "CANCELLATION_ALREADY_REQUESTED"
  | "PROCESSING_STAGE_NOT_CANCELLABLE"
  | "RECONCILIATION_REQUIRED"
  | "STATE_NOT_CANCELLABLE"
  | "STATE_NOT_RETRYABLE";

export type JobActionEligibility =
  Readonly<{ allowed: true }> | Readonly<{ allowed: false; reason: JobActionUnavailableReason }>;

export type JobUsageSummary = Readonly<{
  estimatedCostMicros: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  providerRequests: number | null;
}>;

export type JobDiagnosticListItem = Readonly<{
  attemptCount: number;
  cancel: JobActionEligibility;
  cancellationRequestedAt: string | null;
  completedAt: string | null;
  correlationId: string;
  handlerVersion: number;
  id: string;
  inputVersion: string | null;
  lastErrorClass: string | null;
  lastErrorCode: string | null;
  maxAttempts: number;
  nextAction: string | null;
  nextAttemptAt: string | null;
  queueName: QueueName | "unknown";
  queuedAt: string;
  reconciliationCode: string | null;
  requiresManualAttention: boolean;
  resourceId: string | null;
  resourceType: string | null;
  retry: JobActionEligibility;
  stage: string;
  startedAt: string | null;
  state: BackgroundJobState;
  updatedAt: string;
  version: number;
}>;

export type JobDiagnosticAttempt = Readonly<{
  attemptNumber: number;
  completedAt: string | null;
  errorClass: string | null;
  errorCode: string | null;
  handlerVersion: number;
  heartbeatAt: string;
  nextAction: string | null;
  nextAttemptAt: string | null;
  stage: string;
  startedAt: string;
  state: JobAttemptState;
}>;

export type JobDiagnosticDetail = JobDiagnosticListItem &
  Readonly<{
    attempts: ReadonlyArray<JobDiagnosticAttempt>;
    safeErrorDetail: string | null;
    usage: JobUsageSummary;
    /**
     * Rules the last response broke, as `CODE at path`.
     *
     * Empty for any job that is not an analysis, or that has not been rejected.
     * Carries no model prose: a path names a field, and the value in it is the
     * untrusted part.
     */
    validationIssues: readonly string[];
  }>;

export type JobDiagnosticList = Readonly<{
  filters: JobDiagnosticFilters;
  fingerprint: string;
  generatedAt: string;
  isTruncated: boolean;
  jobs: ReadonlyArray<JobDiagnosticListItem>;
  totalCount: number;
}>;

const listSelect = {
  attemptCount: true,
  cancellationRequestedAt: true,
  completedAt: true,
  correlationId: true,
  handlerVersion: true,
  id: true,
  inputVersion: true,
  lastErrorClass: true,
  lastErrorCode: true,
  maxAttempts: true,
  nextAction: true,
  nextAttemptAt: true,
  queueName: true,
  queuedAt: true,
  reconciliationCode: true,
  reconciliationRequiredAt: true,
  resourceId: true,
  resourceType: true,
  stage: true,
  startedAt: true,
  state: true,
  updatedAt: true,
  version: true,
} satisfies Prisma.BackgroundJobSelect;

export async function loadJobDiagnosticList(
  database: PrismaClient,
  principal: SessionPrincipal,
  filters: JobDiagnosticFilters,
  now: Date = new Date(),
): Promise<JobDiagnosticList> {
  const canOperate = await loadViewerCanOperate(database, principal);
  if (filters.matchesNothing) return emptyList(filters, now);

  const where = createJobWhere(principal.workspaceId, filters);
  const [totalCount, records] = await database.$transaction([
    database.backgroundJob.count({ where }),
    database.backgroundJob.findMany({
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
      select: listSelect,
      take: listLimit,
      where,
    }),
  ]);
  const jobs = records.map((record) => toListItem(record, canOperate)).sort(compareJobs);

  return Object.freeze({
    filters,
    fingerprint: createFingerprint(jobs),
    generatedAt: now.toISOString(),
    isTruncated: totalCount > jobs.length,
    jobs: Object.freeze(jobs),
    totalCount,
  });
}

export async function loadJobDiagnosticDetail(
  database: PrismaClient,
  principal: SessionPrincipal,
  jobId: string,
): Promise<JobDiagnosticDetail | null> {
  const canOperate = await loadViewerCanOperate(database, principal);
  if (!isUuidV7(jobId)) return null;

  const record = await database.backgroundJob.findFirst({
    select: {
      ...listSelect,
      // Why the last response was rejected. Without it the screen can only say
      // "review output" about output nothing kept.
      analysisJob: { select: { lastValidationIssues: true } },
      attempts: {
        orderBy: { attemptNumber: "desc" },
        select: {
          attemptNumber: true,
          completedAt: true,
          errorClass: true,
          errorCode: true,
          handlerVersion: true,
          heartbeatAt: true,
          nextAction: true,
          nextAttemptAt: true,
          stage: true,
          startedAt: true,
          state: true,
        },
      },
    },
    where: { id: jobId, workspaceId: principal.workspaceId },
  });
  if (!record) return null;

  const listItem = toListItem(record, canOperate);
  return Object.freeze({
    ...listItem,
    attempts: Object.freeze(
      record.attempts.map((attempt) =>
        Object.freeze({
          attemptNumber: attempt.attemptNumber,
          completedAt: toIso(attempt.completedAt),
          errorClass: safeErrorClass(attempt.errorClass),
          errorCode: safeCode(attempt.errorCode),
          handlerVersion: attempt.handlerVersion,
          heartbeatAt: attempt.heartbeatAt.toISOString(),
          nextAction: safeNextAction(attempt.nextAction),
          nextAttemptAt: toIso(attempt.nextAttemptAt),
          stage: safeStage(attempt.stage),
          startedAt: attempt.startedAt.toISOString(),
          state: attempt.state,
        }),
      ),
    ),
    safeErrorDetail: describeSafeError(record.lastErrorClass),
    usage: Object.freeze({
      estimatedCostMicros: null,
      inputTokens: null,
      outputTokens: null,
      providerRequests: null,
    }),
    validationIssues: Object.freeze([...(record.analysisJob?.lastValidationIssues ?? [])]),
  });
}

function createJobWhere(
  workspaceId: string,
  filters: JobDiagnosticFilters,
): Prisma.BackgroundJobWhereInput {
  const conditions: Prisma.BackgroundJobWhereInput[] = [{ workspaceId }];
  if (filters.state) conditions.push({ state: filters.state });
  if (filters.queueName) conditions.push({ queueName: filters.queueName });
  if (filters.resourceId) conditions.push({ resourceId: filters.resourceId });
  if (filters.attention === true) {
    conditions.push({
      OR: [{ state: "FAILED_ATTENTION" }, { reconciliationRequiredAt: { not: null } }],
    });
  }
  if (filters.attention === false) {
    conditions.push({ reconciliationRequiredAt: null, state: { not: "FAILED_ATTENTION" } });
  }
  return { AND: conditions };
}

async function loadViewerCanOperate(
  database: PrismaClient,
  principal: SessionPrincipal,
): Promise<boolean> {
  const actor = await database.internalUser.findFirst({
    select: { role: true },
    where: {
      id: principal.internalUserId,
      sessionVersion: principal.sessionVersion,
      status: "ACTIVE",
      workspace: { status: "ACTIVE" },
      workspaceId: principal.workspaceId,
    },
  });
  if (!actor) {
    throw new OperationalError({
      code: "ACCESS_DENIED",
      errorClass: "authorisation",
      statusCode: 401,
    });
  }
  return actor.role === "ADMIN";
}

function toListItem(
  record: Prisma.BackgroundJobGetPayload<{ select: typeof listSelect }>,
  canOperate: boolean,
): JobDiagnosticListItem {
  const requiresManualAttention =
    record.state === "FAILED_ATTENTION" || record.reconciliationRequiredAt !== null;

  return Object.freeze({
    attemptCount: record.attemptCount,
    cancel: cancelEligibility(record, canOperate),
    cancellationRequestedAt: toIso(record.cancellationRequestedAt),
    completedAt: toIso(record.completedAt),
    correlationId: record.correlationId,
    handlerVersion: record.handlerVersion,
    id: record.id,
    inputVersion: safeIdentifier(record.inputVersion),
    lastErrorClass: safeErrorClass(record.lastErrorClass),
    lastErrorCode: safeCode(record.lastErrorCode),
    maxAttempts: record.maxAttempts,
    nextAction: safeNextAction(record.nextAction),
    nextAttemptAt: toIso(record.nextAttemptAt),
    queueName: isQueueName(record.queueName) ? record.queueName : "unknown",
    queuedAt: record.queuedAt.toISOString(),
    reconciliationCode: safeCode(record.reconciliationCode),
    requiresManualAttention,
    resourceId: record.resourceId,
    resourceType: safeIdentifier(record.resourceType),
    retry: retryEligibility(record, canOperate),
    stage: safeStage(record.stage),
    startedAt: toIso(record.startedAt),
    state: record.state,
    updatedAt: record.updatedAt.toISOString(),
    version: record.version,
  });
}

function cancelEligibility(
  job: Pick<
    Prisma.BackgroundJobGetPayload<{ select: typeof listSelect }>,
    "cancellationRequestedAt" | "stage" | "state"
  >,
  canOperate: boolean,
): JobActionEligibility {
  if (!canOperate) return { allowed: false, reason: "ADMIN_REQUIRED" };
  if (job.cancellationRequestedAt) {
    return { allowed: false, reason: "CANCELLATION_ALREADY_REQUESTED" };
  }
  if (job.state === "QUEUED" || job.state === "RETRY_SCHEDULED") return { allowed: true };
  if (job.state === "PROCESSING") {
    return isSafeProcessingCancellationStage(job.stage)
      ? { allowed: true }
      : { allowed: false, reason: "PROCESSING_STAGE_NOT_CANCELLABLE" };
  }
  return { allowed: false, reason: "STATE_NOT_CANCELLABLE" };
}

function retryEligibility(
  job: Pick<
    Prisma.BackgroundJobGetPayload<{ select: typeof listSelect }>,
    "attemptCount" | "reconciliationRequiredAt" | "state"
  >,
  canOperate: boolean,
): JobActionEligibility {
  if (!canOperate) return { allowed: false, reason: "ADMIN_REQUIRED" };
  if (job.state !== "FAILED_ATTENTION") {
    return { allowed: false, reason: "STATE_NOT_RETRYABLE" };
  }
  if (job.reconciliationRequiredAt) {
    return { allowed: false, reason: "RECONCILIATION_REQUIRED" };
  }
  if (job.attemptCount >= 100) {
    return { allowed: false, reason: "ATTEMPT_LIMIT_REACHED" };
  }
  return { allowed: true };
}

function compareJobs(left: JobDiagnosticListItem, right: JobDiagnosticListItem): number {
  const priority = (job: JobDiagnosticListItem) => {
    if (job.requiresManualAttention) return 0;
    if (job.state === "PROCESSING") return 1;
    if (job.state === "RETRY_SCHEDULED" || job.state === "QUEUED") return 2;
    return 3;
  };
  return priority(left) - priority(right) || right.updatedAt.localeCompare(left.updatedAt);
}

function createFingerprint(jobs: ReadonlyArray<JobDiagnosticListItem>): string {
  return jobs.map((job) => `${job.id}:${job.version}:${job.state}`).join("|");
}

function emptyList(filters: JobDiagnosticFilters, now: Date): JobDiagnosticList {
  return Object.freeze({
    filters,
    fingerprint: "empty",
    generatedAt: now.toISOString(),
    isTruncated: false,
    jobs: Object.freeze([]),
    totalCount: 0,
  });
}

function safeCode(value: string | null): string | null {
  return value && safeCodePattern.test(value) ? value : null;
}

function safeErrorClass(value: string | null): string | null {
  return value && safeErrorClasses.has(value) ? value : null;
}

function safeIdentifier(value: string | null): string | null {
  return value && safeIdentifierPattern.test(value) ? value : null;
}

function safeNextAction(value: string | null): string | null {
  return value && safeNextActions.has(value) ? value : null;
}

function safeStage(value: string): string {
  return isSafeJobStage(value) ? value : "unknown";
}

function toIso(value: Date | null): string | null {
  return value?.toISOString() ?? null;
}

function describeSafeError(errorClass: string | null): string | null {
  switch (safeErrorClass(errorClass)) {
    case "CREDENTIAL":
      return "A provider connection needs attention. Existing imported data remains safe.";
    case "DATABASE":
      return "A database operation stopped this attempt. Existing committed data remains safe.";
    case "INVALID_INPUT":
      return "The recorded input did not pass validation. Existing completed data remains safe.";
    case "RATE_LIMIT":
      return "The provider limited this attempt. Existing completed data remains safe.";
    case "SEMANTIC_OUTPUT":
      return "The generated output did not pass validation. No partial result was published.";
    case "TRANSIENT":
      return "A temporary dependency failure stopped this attempt. Existing completed data remains safe.";
    case "UNKNOWN":
      return "This attempt stopped with a classified internal error. Existing completed data remains safe.";
    case null:
      return null;
    default:
      return "This attempt stopped with a recorded safe error class. Existing completed data remains safe.";
  }
}
