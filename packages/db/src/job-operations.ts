import { assertJobTransition } from "@studio-parallel/domain";
import {
  OperationalError,
  parseCorrelationId,
  type JsonLogger,
  type MetricRecorder,
} from "@studio-parallel/observability";

import type { SessionPrincipal } from "./auth.js";
import type { Prisma, PrismaClient } from "./generated/prisma/client.js";
import { createId, isUuidV7 } from "./id.js";
import type { JobDatabaseExecutor } from "./job-execution.js";

type JobDatabase = PrismaClient;
type JobTransaction = Prisma.TransactionClient;

export const safeProcessingCancellationStages = [
  "starting",
  "loading_inputs",
  "validating_inputs",
] as const;

export type JobOperationTelemetry = Readonly<{
  logger: JsonLogger;
  metrics: MetricRecorder;
}>;

export type JobOperatorContext = Readonly<{
  correlationId: string;
  principal: SessionPrincipal;
}>;

export type JobOperationResult = Readonly<{
  outcome:
    | "ALREADY_APPLIED"
    | "CANCELLATION_REQUESTED"
    | "CANCELLED"
    | "NOT_FOUND"
    | "RATE_LIMITED"
    | "REFUSED"
    | "RETRY_QUEUED";
  reasonCode: string;
}>;

export type ManualRetryPrerequisiteResult = Readonly<{
  eligible: boolean;
  reasonCode?: string;
}>;

export type ManualRetryJob = Readonly<{
  attemptCount: number;
  handlerVersion: number;
  id: string;
  idempotencyKey: string;
  inputVersion: string | null;
  maxAttempts: number;
  queueName: string;
  reconciliationCode: string | null;
  resourceId: string | null;
  resourceType: string | null;
  workspaceId: string;
}>;

export type ManualRetryOptions = Readonly<{
  checkPrerequisites(
    database: JobDatabaseExecutor,
    job: ManualRetryJob,
  ): Promise<ManualRetryPrerequisiteResult>;
  context: JobOperatorContext;
  database: JobDatabase;
  jobId: string;
  now?: Date;
  reasonCode: string;
  resultExists(database: JobDatabaseExecutor, job: ManualRetryJob): Promise<boolean>;
  telemetry: JobOperationTelemetry;
}>;

export type CancelJobOptions = Readonly<{
  context: JobOperatorContext;
  database: JobDatabase;
  jobId: string;
  now?: Date;
  reasonCode: string;
  telemetry: JobOperationTelemetry;
}>;

const operationWindowMs = 60_000;
const operationLimits = { "job.cancel": 10, "job.retry": 5 } as const;
const safeReasonCodePattern = /^[A-Z][A-Z0-9_]{0,63}$/u;

export async function cancelBackgroundJob(options: CancelJobOptions): Promise<JobOperationResult> {
  const now = options.now ?? new Date();
  const prepared = prepareOperation(options.context, options.jobId, options.reasonCode, now);

  const result = await options.database.$transaction(async (transaction) => {
    const guard = await authoriseOperation(
      transaction,
      prepared,
      "job.cancel",
      operationLimits["job.cancel"],
      now,
    );
    if (!guard.allowed) return guard.result;

    const job = prepared.validJobId
      ? await transaction.backgroundJob.findFirst({
          where: { id: options.jobId, workspaceId: guard.actor.workspaceId },
        })
      : null;
    if (!job) {
      return auditAndReturn(transaction, guard.actor, prepared, "job.cancel", {
        outcome: "NOT_FOUND",
        reasonCode: "JOB_NOT_FOUND",
      });
    }

    let result: JobOperationResult;
    if (job.state === "CANCELLED" || job.cancellationRequestedAt) {
      result = { outcome: "ALREADY_APPLIED", reasonCode: "CANCELLATION_ALREADY_APPLIED" };
    } else if (job.state === "QUEUED" || job.state === "RETRY_SCHEDULED") {
      assertJobTransition(job.state, "CANCELLED");
      const updated = await transaction.backgroundJob.updateMany({
        data: {
          cancellationReasonCode: prepared.reasonCode,
          cancellationRequestedAt: now,
          completedAt: now,
          dispatchStatus: "CANCELLED",
          lastErrorClass: null,
          lastErrorCode: null,
          nextAction: null,
          nextAttemptAt: null,
          reconciliationCode: null,
          reconciliationRequiredAt: null,
          stage: "cancelled",
          state: "CANCELLED",
          version: { increment: 1 },
        },
        where: { id: job.id, state: job.state, version: job.version },
      });
      if (updated.count !== 1) {
        result = { outcome: "REFUSED", reasonCode: "JOB_STATE_CHANGED" };
      } else {
        await cancelOutbox(transaction, job.id, now);
        result = { outcome: "CANCELLED", reasonCode: prepared.reasonCode };
      }
    } else if (job.state === "PROCESSING") {
      if (!isSafeProcessingCancellationStage(job.stage)) {
        result = { outcome: "REFUSED", reasonCode: "PROCESSING_STAGE_NOT_CANCELLABLE" };
      } else {
        const updated = await transaction.backgroundJob.updateMany({
          data: {
            cancellationReasonCode: prepared.reasonCode,
            cancellationRequestedAt: now,
            dispatchStatus: "CANCELLED",
            version: { increment: 1 },
          },
          where: {
            cancellationRequestedAt: null,
            id: job.id,
            leaseId: job.leaseId,
            stage: job.stage,
            state: "PROCESSING",
            version: job.version,
          },
        });
        if (updated.count !== 1) {
          result = { outcome: "REFUSED", reasonCode: "JOB_STATE_CHANGED" };
        } else {
          await cancelOutbox(transaction, job.id, now);
          result = { outcome: "CANCELLATION_REQUESTED", reasonCode: prepared.reasonCode };
        }
      }
    } else {
      result = { outcome: "REFUSED", reasonCode: "JOB_TERMINAL" };
    }

    return auditAndReturn(transaction, guard.actor, prepared, "job.cancel", result);
  });

  recordOperationTelemetry(options.telemetry, prepared, "cancel", result);
  return Object.freeze(result);
}

export async function retryBackgroundJob(options: ManualRetryOptions): Promise<JobOperationResult> {
  const now = options.now ?? new Date();
  const prepared = prepareOperation(options.context, options.jobId, options.reasonCode, now);

  const result = await options.database.$transaction(async (transaction) => {
    const guard = await authoriseOperation(
      transaction,
      prepared,
      "job.retry",
      operationLimits["job.retry"],
      now,
    );
    if (!guard.allowed) return guard.result;

    const job = prepared.validJobId
      ? await transaction.backgroundJob.findFirst({
          where: { id: options.jobId, workspaceId: guard.actor.workspaceId },
        })
      : null;
    if (!job) {
      return auditAndReturn(transaction, guard.actor, prepared, "job.retry", {
        outcome: "NOT_FOUND",
        reasonCode: "JOB_NOT_FOUND",
      });
    }

    if (job.state === "QUEUED") {
      const priorRequest = await transaction.auditEvent.findFirst({
        where: {
          action: "job.retry",
          outcome: "RETRY_QUEUED",
          resourceId: job.id,
          workspaceId: job.workspaceId,
        },
      });
      const repeated: JobOperationResult = priorRequest
        ? { outcome: "ALREADY_APPLIED", reasonCode: "RETRY_ALREADY_QUEUED" }
        : { outcome: "REFUSED", reasonCode: "JOB_NOT_FAILED_ATTENTION" };
      return auditAndReturn(transaction, guard.actor, prepared, "job.retry", repeated);
    }

    if (job.state !== "FAILED_ATTENTION") {
      return auditAndReturn(transaction, guard.actor, prepared, "job.retry", {
        outcome: "REFUSED",
        reasonCode: "JOB_NOT_FAILED_ATTENTION",
      });
    }

    if (job.reconciliationRequiredAt || job.reconciliationCode) {
      return auditAndReturn(transaction, guard.actor, prepared, "job.retry", {
        outcome: "REFUSED",
        reasonCode: "JOB_RECONCILIATION_REQUIRED",
      });
    }

    const retryJob = toManualRetryJob(job);
    if (await options.resultExists(transaction, retryJob)) {
      return auditAndReturn(transaction, guard.actor, prepared, "job.retry", {
        outcome: "REFUSED",
        reasonCode: "JOB_RESULT_ALREADY_EXISTS",
      });
    }

    const prerequisite = await options.checkPrerequisites(transaction, retryJob);
    const prerequisiteReason = prerequisite.reasonCode ?? "JOB_PREREQUISITE_MISSING";
    if (!prerequisite.eligible) {
      assertSafeReasonCode(prerequisiteReason);
      return auditAndReturn(transaction, guard.actor, prepared, "job.retry", {
        outcome: "REFUSED",
        reasonCode: prerequisiteReason,
      });
    }

    const maxAttempts = Math.max(job.maxAttempts, job.attemptCount + 1);
    if (maxAttempts > 100) {
      return auditAndReturn(transaction, guard.actor, prepared, "job.retry", {
        outcome: "REFUSED",
        reasonCode: "JOB_ATTEMPT_LIMIT_REACHED",
      });
    }

    assertJobTransition("FAILED_ATTENTION", "QUEUED");
    const updated = await transaction.backgroundJob.updateMany({
      data: {
        cancellationReasonCode: null,
        cancellationRequestedAt: null,
        completedAt: null,
        dispatchStatus: "PENDING",
        lastErrorClass: null,
        lastErrorCode: null,
        maxAttempts,
        nextAction: null,
        queuedAt: now,
        reconciliationCode: null,
        reconciliationRequiredAt: null,
        stage: "queued",
        state: "QUEUED",
        version: { increment: 1 },
      },
      where: { id: job.id, state: "FAILED_ATTENTION", version: job.version },
    });
    if (updated.count !== 1) {
      return auditAndReturn(transaction, guard.actor, prepared, "job.retry", {
        outcome: "REFUSED",
        reasonCode: "JOB_STATE_CHANGED",
      });
    }

    await transaction.jobOutbox.upsert({
      create: {
        backgroundJobId: job.id,
        correlationId: job.correlationId,
        handlerVersion: job.handlerVersion,
        id: createId(),
        queueName: job.queueName,
        workspaceId: job.workspaceId,
      },
      update: {
        cancelledAt: null,
        dispatchedAt: null,
        lastErrorCode: null,
        leaseExpiresAt: null,
        leaseId: null,
        nextAttemptAt: now,
        queueDeliveryId: null,
      },
      where: { backgroundJobId: job.id },
    });

    return auditAndReturn(transaction, guard.actor, prepared, "job.retry", {
      outcome: "RETRY_QUEUED",
      reasonCode: prepared.reasonCode,
    });
  });

  recordOperationTelemetry(options.telemetry, prepared, "retry", result);
  return Object.freeze(result);
}

export function isSafeProcessingCancellationStage(stage: string): boolean {
  return safeProcessingCancellationStages.includes(
    stage as (typeof safeProcessingCancellationStages)[number],
  );
}

type PreparedOperation = Readonly<{
  actorId: string;
  correlationId: ReturnType<typeof parseCorrelationId> & {};
  jobId: string;
  operationAt: Date;
  principal: SessionPrincipal;
  reasonCode: string;
  validJobId: boolean;
  workspaceId: string;
}>;

type AuthorisedActor = Readonly<{ id: string; workspaceId: string }>;

type OperationGuard =
  | Readonly<{ actor: AuthorisedActor; allowed: true }>
  | Readonly<{ allowed: false; result: JobOperationResult }>;

function prepareOperation(
  context: JobOperatorContext,
  jobId: string,
  reasonCode: string,
  operationAt: Date,
): PreparedOperation {
  const correlationId = parseCorrelationId(context.correlationId);
  if (!correlationId) throw validationError("JOB_OPERATION_CORRELATION_INVALID");
  assertSafeReasonCode(reasonCode);

  return Object.freeze({
    actorId: context.principal.internalUserId,
    correlationId,
    jobId,
    operationAt,
    principal: context.principal,
    reasonCode,
    validJobId: isUuidV7(jobId),
    workspaceId: context.principal.workspaceId,
  });
}

async function authoriseOperation(
  transaction: JobTransaction,
  prepared: PreparedOperation,
  action: keyof typeof operationLimits,
  limit: number,
  now: Date,
): Promise<OperationGuard> {
  const actor = await transaction.internalUser.findFirst({
    where: {
      id: prepared.principal.internalUserId,
      sessionVersion: prepared.principal.sessionVersion,
      status: "ACTIVE",
      workspace: { status: "ACTIVE" },
      workspaceId: prepared.principal.workspaceId,
    },
  });
  if (!actor) {
    return {
      allowed: false,
      result: { outcome: "REFUSED", reasonCode: "OPERATOR_NOT_AUTHORISED" },
    };
  }

  const authorisedActor = { id: actor.id, workspaceId: actor.workspaceId };
  if (actor.role !== "ADMIN") {
    return {
      allowed: false,
      result: await auditAndReturn(transaction, authorisedActor, prepared, action, {
        outcome: "REFUSED",
        reasonCode: "ADMIN_REQUIRED",
      }),
    };
  }

  const recent = await transaction.auditEvent.count({
    where: {
      action,
      actorUserId: actor.id,
      occurredAt: { gte: new Date(now.getTime() - operationWindowMs) },
      workspaceId: actor.workspaceId,
    },
  });
  if (recent >= limit) {
    return {
      allowed: false,
      result: await auditAndReturn(transaction, authorisedActor, prepared, action, {
        outcome: "RATE_LIMITED",
        reasonCode: "OPERATOR_RATE_LIMITED",
      }),
    };
  }

  return { actor: authorisedActor, allowed: true };
}

async function auditAndReturn(
  transaction: JobTransaction,
  actor: AuthorisedActor,
  prepared: PreparedOperation,
  action: keyof typeof operationLimits,
  result: JobOperationResult,
): Promise<JobOperationResult> {
  await transaction.auditEvent.create({
    data: {
      action,
      actorType: "USER",
      actorUserId: actor.id,
      correlationId: prepared.correlationId,
      id: createId(),
      outcome: result.outcome,
      occurredAt: prepared.operationAt,
      reasonCode: result.reasonCode,
      resourceId: prepared.validJobId ? prepared.jobId : null,
      resourceType: "background_job",
      workspaceId: actor.workspaceId,
    },
  });
  return result;
}

async function cancelOutbox(
  transaction: JobTransaction,
  backgroundJobId: string,
  cancelledAt: Date,
): Promise<void> {
  await transaction.jobOutbox.updateMany({
    data: { cancelledAt, leaseExpiresAt: null, leaseId: null },
    where: { backgroundJobId },
  });
}

function toManualRetryJob(job: ManualRetryJob): ManualRetryJob {
  return Object.freeze({
    attemptCount: job.attemptCount,
    handlerVersion: job.handlerVersion,
    id: job.id,
    idempotencyKey: job.idempotencyKey,
    inputVersion: job.inputVersion,
    maxAttempts: job.maxAttempts,
    queueName: job.queueName,
    reconciliationCode: job.reconciliationCode,
    resourceId: job.resourceId,
    resourceType: job.resourceType,
    workspaceId: job.workspaceId,
  });
}

function recordOperationTelemetry(
  telemetry: JobOperationTelemetry,
  prepared: PreparedOperation,
  operation: "cancel" | "retry",
  result: JobOperationResult,
): void {
  const level = result.outcome === "REFUSED" || result.outcome === "RATE_LIMITED" ? "warn" : "info";
  telemetry.logger[level](`job.${operation}.${result.outcome.toLowerCase()}`, {
    actorId: prepared.actorId,
    correlationId: prepared.correlationId,
    ...(prepared.validJobId ? { jobId: prepared.jobId } : {}),
    operation,
    outcome: result.outcome,
    reasonCode: result.reasonCode,
    source: "user",
    stage: `user_${operation}`,
    workspaceId: prepared.workspaceId,
  });
  telemetry.metrics.increment("job.operation.count", {
    actorId: prepared.actorId,
    correlationId: prepared.correlationId,
    ...(prepared.validJobId ? { jobId: prepared.jobId } : {}),
    stage: `user_${operation}`,
    workspaceId: prepared.workspaceId,
  });
}

function assertSafeReasonCode(reasonCode: string): void {
  if (!safeReasonCodePattern.test(reasonCode)) {
    throw validationError("JOB_OPERATION_REASON_INVALID");
  }
}

function validationError(code: string): OperationalError {
  return new OperationalError({ code, errorClass: "validation", statusCode: 400 });
}
