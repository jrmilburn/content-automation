import {
  assertJobTransition,
  classifyJobHandlerError,
  decideJobRetry,
  isSafeJobStage,
  queueVersionKey,
  type JobFailure,
  type JobRetryDecision,
  type QueueJobEnvelope,
} from "@studio-parallel/domain";
import {
  OperationalError,
  parseCorrelationId,
  type JsonLogger,
} from "@studio-parallel/observability";

import type { Prisma, PrismaClient } from "./generated/prisma/client.js";
import { createId } from "./id.js";
import type { WorkspaceContext } from "./workspace-context.js";

type JobDatabase = PrismaClient;
export type JobDatabaseExecutor = PrismaClient | Prisma.TransactionClient;

export type JobClaimResult =
  | Readonly<{
      claimed: false;
      reason: "ATTEMPTS_EXHAUSTED" | "MISSING" | "STATE" | "VERSION_CONFLICT";
      state?: string;
    }>
  | Readonly<{
      attemptNumber: number;
      claimed: true;
      correlationId: string;
      handlerVersion: number;
      jobCreatedAt: Date;
      leaseExpiresAt: Date;
      leaseId: string;
      maxAttempts: number;
      queueName: string;
      version: number;
      workspaceId: string;
    }>;

export type JobHandlerExecutionContext = Readonly<{
  attemptNumber: number;
  heartbeat(at?: Date): Promise<void>;
  jobId: string;
  leaseId: string;
  recordStage(stage: string, at?: Date): Promise<void>;
  signal: AbortSignal;
  throwIfCancellationRequested(at?: Date): Promise<void>;
  workspaceId: string;
}>;

export type TransactionalJobResult = Readonly<{
  commit(transaction: Prisma.TransactionClient): Promise<void>;
}>;

export type JobHandlerRunResult =
  | Readonly<{ outcome: "ALREADY_SUCCEEDED" | "SUCCEEDED" }>
  | Readonly<{ outcome: "CANCELLED" }>
  | Readonly<{
      nextAttemptAt: Date;
      outcome: "RETRY_SCHEDULED";
    }>
  | Readonly<{
      nextAction: string;
      outcome: "FAILED_ATTENTION";
    }>
  | Readonly<{
      outcome: "IGNORED";
      reason:
        "ATTEMPTS_EXHAUSTED" | "CANCELLED" | "FAILED_ATTENTION" | "LEASED" | "MISSING" | "NOT_DUE";
    }>
  | Readonly<{ outcome: "LEASE_ABANDONED" }>;

export type JobCrashPoint = "AFTER_HANDLER" | "AFTER_RESULT_COMMIT" | "BEFORE_RESULT_COMMIT";

export class InjectedJobCrash extends Error {
  readonly code = "INJECTED_JOB_CRASH";

  constructor() {
    super("INJECTED_JOB_CRASH");
    this.name = "InjectedJobCrash";
  }
}

export class JobLeaseLostError extends OperationalError {
  constructor() {
    super({ code: "JOB_LEASE_LOST", errorClass: "conflict", statusCode: 409 });
    this.name = "JobLeaseLostError";
  }
}

export class JobCancellationRequestedError extends Error {
  readonly code = "JOB_CANCELLATION_REQUESTED";

  constructor() {
    super("JOB_CANCELLATION_REQUESTED");
    this.name = "JobCancellationRequestedError";
  }
}

type RunJobHandlerOptions = Readonly<{
  acquireConcurrency?: (signal: AbortSignal) => Promise<() => void>;
  context: WorkspaceContext;
  crashInjector?: (point: JobCrashPoint) => Promise<void> | void;
  database: JobDatabase;
  envelope: QueueJobEnvelope;
  execute(context: JobHandlerExecutionContext): Promise<TransactionalJobResult>;
  leaseDurationMs?: number;
  logger: JsonLogger;
  now?: () => Date;
  random?: () => number;
  resultExists(database: JobDatabaseExecutor): Promise<boolean>;
  signal: AbortSignal;
}>;

const defaultLeaseDurationMs = 120_000;

export async function claimBackgroundJob(
  database: JobDatabase,
  context: WorkspaceContext,
  jobId: string,
  options: Readonly<{ leaseDurationMs?: number; now?: Date }> = {},
): Promise<JobClaimResult> {
  const now = options.now ?? new Date();
  const leaseDurationMs = options.leaseDurationMs ?? defaultLeaseDurationMs;
  validatePositiveInteger(leaseDurationMs, "JOB_LEASE_DURATION_INVALID");

  try {
    return await database.$transaction(async (transaction) => {
      const job = await transaction.backgroundJob.findFirst({
        where: { id: jobId, workspaceId: context.workspaceId },
      });

      if (!job) return Object.freeze({ claimed: false, reason: "MISSING" as const });
      if (job.state !== "QUEUED") {
        return Object.freeze({ claimed: false, reason: "STATE" as const, state: job.state });
      }
      if (job.attemptCount >= job.maxAttempts) {
        return Object.freeze({ claimed: false, reason: "ATTEMPTS_EXHAUSTED" as const });
      }

      assertJobTransition("QUEUED", "PROCESSING");
      const leaseId = createId();
      const leaseExpiresAt = new Date(now.getTime() + leaseDurationMs);
      const attemptNumber = job.attemptCount + 1;
      const updated = await transaction.backgroundJob.updateMany({
        data: {
          attemptCount: { increment: 1 },
          heartbeatAt: now,
          lastErrorClass: null,
          lastErrorCode: null,
          leaseExpiresAt,
          leaseId,
          nextAction: null,
          stage: "starting",
          startedAt: job.startedAt ?? now,
          state: "PROCESSING",
          version: { increment: 1 },
        },
        where: {
          attemptCount: { lt: job.maxAttempts },
          id: job.id,
          state: "QUEUED",
          version: job.version,
          workspaceId: context.workspaceId,
        },
      });

      if (updated.count !== 1) {
        return Object.freeze({ claimed: false, reason: "VERSION_CONFLICT" as const });
      }

      await transaction.jobAttempt.create({
        data: {
          attemptNumber,
          backgroundJobId: job.id,
          correlationId: job.correlationId,
          handlerVersion: job.handlerVersion,
          heartbeatAt: now,
          id: createId(),
          leaseId,
          startedAt: now,
          workspaceId: job.workspaceId,
        },
      });

      return Object.freeze({
        attemptNumber,
        claimed: true,
        correlationId: job.correlationId,
        handlerVersion: job.handlerVersion,
        jobCreatedAt: job.createdAt,
        leaseExpiresAt,
        leaseId,
        maxAttempts: job.maxAttempts,
        queueName: job.queueName,
        version: job.version + 1,
        workspaceId: job.workspaceId,
      });
    });
  } catch (error) {
    if (error instanceof OperationalError) throw error;
    throw jobDatabaseError("JOB_CLAIM_FAILED");
  }
}

export async function heartbeatBackgroundJob(
  database: JobDatabase,
  context: WorkspaceContext,
  jobId: string,
  leaseId: string,
  options: Readonly<{ at?: Date; leaseDurationMs?: number }> = {},
): Promise<void> {
  const at = options.at ?? new Date();
  const leaseDurationMs = options.leaseDurationMs ?? defaultLeaseDurationMs;
  validatePositiveInteger(leaseDurationMs, "JOB_LEASE_DURATION_INVALID");

  await updateActiveAttempt(database, context, jobId, leaseId, {
    attemptData: { heartbeatAt: at },
    jobData: {
      heartbeatAt: at,
      leaseExpiresAt: new Date(at.getTime() + leaseDurationMs),
      version: { increment: 1 },
    },
  });
}

export async function recordBackgroundJobStage(
  database: JobDatabase,
  context: WorkspaceContext,
  jobId: string,
  leaseId: string,
  stage: string,
  at: Date = new Date(),
): Promise<void> {
  if (!isSafeJobStage(stage)) throw validationError("JOB_STAGE_INVALID");

  await updateActiveAttempt(database, context, jobId, leaseId, {
    attemptData: { heartbeatAt: at, stage },
    jobData: { heartbeatAt: at, stage, version: { increment: 1 } },
  });
}

export async function makeBackgroundJobRetryDue(
  database: JobDatabase,
  context: WorkspaceContext,
  jobId: string,
  now: Date = new Date(),
): Promise<boolean> {
  assertJobTransition("RETRY_SCHEDULED", "QUEUED");

  try {
    const result = await database.backgroundJob.updateMany({
      data: {
        nextAttemptAt: null,
        queuedAt: now,
        stage: "queued",
        state: "QUEUED",
        version: { increment: 1 },
      },
      where: {
        id: jobId,
        nextAttemptAt: { lte: now },
        state: "RETRY_SCHEDULED",
        workspaceId: context.workspaceId,
      },
    });
    return result.count === 1;
  } catch {
    throw jobDatabaseError("JOB_RETRY_RELEASE_FAILED");
  }
}

export async function recoverExpiredBackgroundJobLease(
  database: JobDatabase,
  context: WorkspaceContext,
  jobId: string,
  now: Date = new Date(),
  audit?: Readonly<{ actorService: "job-reconciler"; correlationId: string }>,
): Promise<boolean> {
  const auditCorrelationId = audit ? parseCorrelationId(audit.correlationId) : null;
  if (audit && !auditCorrelationId) throw validationError("JOB_RECONCILIATION_CORRELATION_INVALID");
  try {
    return await database.$transaction(async (transaction) => {
      const job = await transaction.backgroundJob.findFirst({
        where: {
          id: jobId,
          leaseExpiresAt: { lte: now },
          state: "PROCESSING",
          workspaceId: context.workspaceId,
        },
      });
      if (!job?.leaseId) return false;

      const cancellationRequested = job.cancellationRequestedAt !== null;
      const exhausted = job.attemptCount >= job.maxAttempts;
      const nextState = cancellationRequested
        ? "CANCELLED"
        : exhausted
          ? "FAILED_ATTENTION"
          : "QUEUED";
      const nextAction = cancellationRequested
        ? null
        : exhausted
          ? "CONTACT_SUPPORT"
          : "RETRY_AUTOMATIC";
      assertJobTransition("PROCESSING", nextState);

      const updated = await transaction.backgroundJob.updateMany({
        data: {
          completedAt: exhausted || cancellationRequested ? now : null,
          // A job going back to QUEUED needs delivering again, so its dispatch
          // status returns to PENDING alongside the outbox reset below. Leaving
          // it DISPATCHED left the job claiming RETRY_AUTOMATIC while no rule
          // in the dispatcher or the reconciler could ever pick it up.
          dispatchStatus: cancellationRequested
            ? "CANCELLED"
            : nextState === "QUEUED"
              ? "PENDING"
              : job.dispatchStatus,
          lastErrorClass: cancellationRequested ? null : "TRANSIENT",
          lastErrorCode: cancellationRequested ? null : "JOB_LEASE_EXPIRED",
          leaseExpiresAt: null,
          leaseId: null,
          nextAction,
          queuedAt: exhausted || cancellationRequested ? job.queuedAt : now,
          stage: cancellationRequested ? "cancelled" : exhausted ? "failed_attention" : "queued",
          state: nextState,
          version: { increment: 1 },
        },
        where: {
          id: job.id,
          leaseExpiresAt: { lte: now },
          leaseId: job.leaseId,
          state: "PROCESSING",
          version: job.version,
          workspaceId: context.workspaceId,
        },
      });
      if (updated.count !== 1) return false;

      const attempt = await transaction.jobAttempt.updateMany({
        data: cancellationRequested
          ? { completedAt: now, state: "CANCELLED" }
          : {
              completedAt: now,
              errorClass: "TRANSIENT",
              errorCode: "JOB_LEASE_EXPIRED",
              nextAction,
              state: "LEASE_EXPIRED",
            },
        where: { leaseId: job.leaseId, state: "ACTIVE" },
      });
      if (attempt.count !== 1) throw new JobLeaseLostError();
      if (cancellationRequested) {
        await transaction.jobOutbox.updateMany({
          data: { cancelledAt: now, leaseExpiresAt: null, leaseId: null },
          where: { backgroundJobId: job.id },
        });
      } else if (nextState === "QUEUED") {
        // The outbox row is the delivery record, and it is retained after
        // dispatch. Clearing `dispatchedAt` is what makes the dispatcher pick
        // this job up again; without it the row says the work was already
        // handed over and the job is stranded despite reading as retryable.
        //
        // A fresh delivery identifier is required rather than tidy: #114
        // established that reusing one makes the queue refuse the redelivery.
        await transaction.jobOutbox.updateMany({
          data: {
            dispatchedAt: null,
            leaseExpiresAt: null,
            leaseId: null,
            nextAttemptAt: now,
            queueDeliveryId: null,
          },
          where: { backgroundJobId: job.id, cancelledAt: null },
        });
      }
      if (audit && auditCorrelationId) {
        await transaction.auditEvent.create({
          data: {
            action: "job.reconcile",
            actorService: audit.actorService,
            actorType: "SERVICE",
            correlationId: auditCorrelationId,
            id: createId(),
            occurredAt: now,
            outcome: "REPAIRED",
            reasonCode: cancellationRequested
              ? "CANCELLATION_REQUEST_RECOVERED"
              : "EXPIRED_LEASE_RECOVERED",
            resourceId: job.id,
            resourceType: "background_job",
            workspaceId: job.workspaceId,
          },
        });
      }
      return true;
    });
  } catch (error) {
    if (error instanceof OperationalError) throw error;
    throw jobDatabaseError("JOB_LEASE_RECOVERY_FAILED");
  }
}

export async function throwIfBackgroundJobCancellationRequested(
  database: JobDatabase,
  context: WorkspaceContext,
  jobId: string,
  leaseId: string,
  cancelledAt: Date = new Date(),
): Promise<void> {
  let cancelled: boolean;

  try {
    cancelled = await database.$transaction(async (transaction) => {
      const job = await transaction.backgroundJob.findFirst({
        where: { id: jobId, leaseId, state: "PROCESSING", workspaceId: context.workspaceId },
      });
      if (!job) throw new JobLeaseLostError();
      if (!job.cancellationRequestedAt) return false;

      assertJobTransition("PROCESSING", "CANCELLED");
      const updated = await transaction.backgroundJob.updateMany({
        data: {
          completedAt: cancelledAt,
          dispatchStatus: "CANCELLED",
          heartbeatAt: cancelledAt,
          lastErrorClass: null,
          lastErrorCode: null,
          leaseExpiresAt: null,
          leaseId: null,
          nextAction: null,
          nextAttemptAt: null,
          reconciliationCode: null,
          reconciliationRequiredAt: null,
          stage: "cancelled",
          state: "CANCELLED",
          version: { increment: 1 },
        },
        where: {
          cancellationRequestedAt: { not: null },
          id: job.id,
          leaseId,
          state: "PROCESSING",
          version: job.version,
          workspaceId: context.workspaceId,
        },
      });
      if (updated.count !== 1) throw new JobLeaseLostError();

      const attempt = await transaction.jobAttempt.updateMany({
        data: {
          completedAt: cancelledAt,
          heartbeatAt: cancelledAt,
          stage: "cancelled",
          state: "CANCELLED",
        },
        where: { leaseId, state: "ACTIVE", workspaceId: context.workspaceId },
      });
      if (attempt.count !== 1) throw new JobLeaseLostError();
      await transaction.jobOutbox.updateMany({
        data: { cancelledAt, leaseExpiresAt: null, leaseId: null },
        where: { backgroundJobId: job.id },
      });
      return true;
    });
  } catch (error) {
    if (error instanceof OperationalError) throw error;
    throw jobDatabaseError("JOB_CANCELLATION_CHECK_FAILED");
  }

  if (cancelled) throw new JobCancellationRequestedError();
}

export async function runIdempotentJobHandler(
  options: RunJobHandlerOptions,
): Promise<JobHandlerRunResult> {
  validateDeliveryContext(options.context, options.envelope);
  let release = (): void => {};

  try {
    const now = options.now ?? (() => new Date());
    let job = await loadOwnedJob(options.database, options.context, options.envelope.domainJobId);
    if (!job) return Object.freeze({ outcome: "IGNORED", reason: "MISSING" });
    validateDeliveryJob(job, options.envelope);

    const existingResult = await safeResultExists(options.resultExists, options.database);
    if (job.state === "SUCCEEDED") {
      if (!existingResult) throw jobDatabaseError("JOB_RESULT_INCONSISTENT");
      logJob(options.logger, "job.delivery_deduplicated", job, "SUCCEEDED");
      return Object.freeze({ outcome: "ALREADY_SUCCEEDED" });
    }
    if (job.state === "CANCELLED" || job.state === "FAILED_ATTENTION") {
      return Object.freeze({ outcome: "IGNORED", reason: job.state });
    }
    if (existingResult) throw jobDatabaseError("JOB_RESULT_STATE_INCONSISTENT");

    if (job.state === "RETRY_SCHEDULED") {
      if (!job.nextAttemptAt || job.nextAttemptAt > now()) {
        return Object.freeze({ outcome: "IGNORED", reason: "NOT_DUE" });
      }
      await makeBackgroundJobRetryDue(options.database, options.context, job.id, now());
      job = await loadOwnedJob(options.database, options.context, job.id);
      if (!job) return Object.freeze({ outcome: "IGNORED", reason: "MISSING" });
    }

    if (job.state === "PROCESSING") {
      return Object.freeze({ outcome: "IGNORED", reason: "LEASED" });
    }

    release = await (options.acquireConcurrency?.(options.signal) ?? Promise.resolve(() => {}));
    const claim = await claimBackgroundJob(options.database, options.context, job.id, {
      ...(options.leaseDurationMs === undefined
        ? {}
        : { leaseDurationMs: options.leaseDurationMs }),
      now: now(),
    });
    if (!claim.claimed) return claimToIgnored(claim);

    const correlationId = parseCorrelationId(claim.correlationId);
    if (!correlationId) throw jobDatabaseError("JOB_CORRELATION_INVALID");
    options.logger.info("job.started", {
      attempt: claim.attemptNumber,
      correlationId,
      handlerVersion: claim.handlerVersion,
      jobId: job.id,
      jobState: "PROCESSING",
      queueName: queueVersionKey({
        name: options.envelope.queueName,
        version: options.envelope.handlerVersion,
      }),
      stage: "starting",
      workspaceId: claim.workspaceId,
    });

    let execution: TransactionalJobResult;
    try {
      await throwIfBackgroundJobCancellationRequested(
        options.database,
        options.context,
        job.id,
        claim.leaseId,
        now(),
      );
      execution = await options.execute({
        attemptNumber: claim.attemptNumber,
        heartbeat: async (at = now()) => {
          await throwIfBackgroundJobCancellationRequested(
            options.database,
            options.context,
            job.id,
            claim.leaseId,
            at,
          );
          await heartbeatBackgroundJob(options.database, options.context, job.id, claim.leaseId, {
            at,
            ...(options.leaseDurationMs === undefined
              ? {}
              : { leaseDurationMs: options.leaseDurationMs }),
          });
        },
        jobId: job.id,
        leaseId: claim.leaseId,
        recordStage: async (stage, at = now()) => {
          await throwIfBackgroundJobCancellationRequested(
            options.database,
            options.context,
            job.id,
            claim.leaseId,
            at,
          );
          await recordBackgroundJobStage(
            options.database,
            options.context,
            job.id,
            claim.leaseId,
            stage,
            at,
          );
          options.logger.info("job.stage_recorded", {
            attempt: claim.attemptNumber,
            correlationId,
            handlerVersion: claim.handlerVersion,
            jobId: job.id,
            jobState: "PROCESSING",
            stage,
            workspaceId: claim.workspaceId,
          });
        },
        signal: options.signal,
        throwIfCancellationRequested: (at = now()) =>
          throwIfBackgroundJobCancellationRequested(
            options.database,
            options.context,
            job.id,
            claim.leaseId,
            at,
          ),
        workspaceId: claim.workspaceId,
      });
      await options.crashInjector?.("AFTER_HANDLER");
      await options.crashInjector?.("BEFORE_RESULT_COMMIT");
    } catch (error) {
      if (error instanceof InjectedJobCrash) throw error;
      if (error instanceof JobCancellationRequestedError) {
        options.logger.info("job.cancelled", {
          attempt: claim.attemptNumber,
          correlationId,
          handlerVersion: claim.handlerVersion,
          jobId: job.id,
          jobState: "CANCELLED",
          source: "user",
          stage: "cancelled",
          workspaceId: claim.workspaceId,
        });
        return Object.freeze({ outcome: "CANCELLED" });
      }
      if (options.signal.aborted) return Object.freeze({ outcome: "LEASE_ABANDONED" });
      return settleHandlerFailure(options, job.id, claim, classifyJobHandlerError(error), now());
    }

    await commitJobSuccess(
      options.database,
      options.context,
      job.id,
      claim.leaseId,
      execution,
      now(),
    );
    options.logger.info("job.succeeded", {
      attempt: claim.attemptNumber,
      correlationId,
      handlerVersion: claim.handlerVersion,
      jobId: job.id,
      jobState: "SUCCEEDED",
      stage: "completed",
      workspaceId: claim.workspaceId,
    });
    await options.crashInjector?.("AFTER_RESULT_COMMIT");
    return Object.freeze({ outcome: "SUCCEEDED" });
  } finally {
    release();
  }
}

async function settleHandlerFailure(
  options: RunJobHandlerOptions,
  jobId: string,
  claim: Extract<JobClaimResult, { claimed: true }>,
  failure: JobFailure,
  now: Date,
): Promise<JobHandlerRunResult> {
  const decision = decideJobRetry({
    attemptNumber: claim.attemptNumber,
    failure,
    jobCreatedAt: claim.jobCreatedAt,
    maxAttempts: claim.maxAttempts,
    now,
    ...(options.random === undefined ? {} : { random: options.random }),
  });
  await commitJobFailure(
    options.database,
    options.context,
    jobId,
    claim.leaseId,
    failure,
    decision,
    now,
  );

  const correlationId = parseCorrelationId(claim.correlationId);
  if (!correlationId) throw jobDatabaseError("JOB_CORRELATION_INVALID");
  options.logger.warn(
    decision.outcome === "RETRY" ? "job.retry_scheduled" : "job.failed_attention",
    {
      attempt: claim.attemptNumber,
      correlationId,
      errorClass: failure.errorClass,
      errorCode: failure.errorCode,
      handlerVersion: claim.handlerVersion,
      jobId,
      jobState: decision.outcome === "RETRY" ? "RETRY_SCHEDULED" : "FAILED_ATTENTION",
      nextAction: decision.nextAction,
      stage: decision.outcome === "RETRY" ? "retry_scheduled" : "failed_attention",
      workspaceId: claim.workspaceId,
    },
  );

  return decision.outcome === "RETRY"
    ? Object.freeze({ nextAttemptAt: decision.nextAttemptAt, outcome: "RETRY_SCHEDULED" })
    : Object.freeze({ nextAction: decision.nextAction, outcome: "FAILED_ATTENTION" });
}

async function commitJobSuccess(
  database: JobDatabase,
  context: WorkspaceContext,
  jobId: string,
  leaseId: string,
  result: TransactionalJobResult,
  completedAt: Date,
): Promise<void> {
  assertJobTransition("PROCESSING", "SUCCEEDED");

  try {
    await database.$transaction(async (transaction) => {
      const updated = await transaction.backgroundJob.updateMany({
        data: {
          completedAt,
          heartbeatAt: completedAt,
          leaseExpiresAt: null,
          leaseId: null,
          stage: "completed",
          state: "SUCCEEDED",
          version: { increment: 1 },
        },
        where: {
          id: jobId,
          cancellationRequestedAt: null,
          leaseId,
          state: "PROCESSING",
          workspaceId: context.workspaceId,
        },
      });
      if (updated.count !== 1) throw new JobLeaseLostError();

      await result.commit(transaction);
      const attempt = await transaction.jobAttempt.updateMany({
        data: { completedAt, heartbeatAt: completedAt, stage: "completed", state: "SUCCEEDED" },
        where: { leaseId, state: "ACTIVE" },
      });
      if (attempt.count !== 1) throw new JobLeaseLostError();
    });
  } catch (error) {
    if (error instanceof OperationalError) throw error;
    throw jobDatabaseError("JOB_RESULT_COMMIT_FAILED");
  }
}

async function commitJobFailure(
  database: JobDatabase,
  context: WorkspaceContext,
  jobId: string,
  leaseId: string,
  failure: JobFailure,
  decision: JobRetryDecision,
  completedAt: Date,
): Promise<void> {
  const nextState = decision.outcome === "RETRY" ? "RETRY_SCHEDULED" : "FAILED_ATTENTION";
  assertJobTransition("PROCESSING", nextState);

  try {
    await database.$transaction(async (transaction) => {
      const updated = await transaction.backgroundJob.updateMany({
        data: {
          completedAt: decision.outcome === "RETRY" ? null : completedAt,
          heartbeatAt: completedAt,
          lastErrorClass: failure.errorClass,
          lastErrorCode: failure.errorCode,
          leaseExpiresAt: null,
          leaseId: null,
          nextAction: decision.nextAction,
          nextAttemptAt: decision.outcome === "RETRY" ? decision.nextAttemptAt : null,
          stage: decision.outcome === "RETRY" ? "retry_scheduled" : "failed_attention",
          state: nextState,
          version: { increment: 1 },
        },
        where: {
          id: jobId,
          cancellationRequestedAt: null,
          leaseId,
          state: "PROCESSING",
          workspaceId: context.workspaceId,
        },
      });
      if (updated.count !== 1) throw new JobLeaseLostError();

      const attempt = await transaction.jobAttempt.updateMany({
        data: {
          completedAt,
          errorClass: failure.errorClass,
          errorCode: failure.errorCode,
          heartbeatAt: completedAt,
          nextAction: decision.nextAction,
          nextAttemptAt: decision.outcome === "RETRY" ? decision.nextAttemptAt : null,
          stage: decision.outcome === "RETRY" ? "retry_scheduled" : "failed_attention",
          state: nextState,
        },
        where: { leaseId, state: "ACTIVE" },
      });
      if (attempt.count !== 1) throw new JobLeaseLostError();
    });
  } catch (error) {
    if (error instanceof OperationalError) throw error;
    throw jobDatabaseError("JOB_FAILURE_COMMIT_FAILED");
  }
}

async function updateActiveAttempt(
  database: JobDatabase,
  context: WorkspaceContext,
  jobId: string,
  leaseId: string,
  data: Readonly<{
    attemptData: Prisma.JobAttemptUpdateManyMutationInput;
    jobData: Prisma.BackgroundJobUpdateManyMutationInput;
  }>,
): Promise<void> {
  try {
    await database.$transaction(async (transaction) => {
      const job = await transaction.backgroundJob.updateMany({
        data: data.jobData,
        where: {
          id: jobId,
          leaseId,
          state: "PROCESSING",
          workspaceId: context.workspaceId,
        },
      });
      const attempt = await transaction.jobAttempt.updateMany({
        data: data.attemptData,
        where: { leaseId, state: "ACTIVE", workspaceId: context.workspaceId },
      });
      if (job.count !== 1 || attempt.count !== 1) throw new JobLeaseLostError();
    });
  } catch (error) {
    if (error instanceof OperationalError) throw error;
    throw jobDatabaseError("JOB_HEARTBEAT_FAILED");
  }
}

async function loadOwnedJob(database: JobDatabase, context: WorkspaceContext, jobId: string) {
  try {
    return await database.backgroundJob.findFirst({
      where: { id: jobId, workspaceId: context.workspaceId },
    });
  } catch {
    throw jobDatabaseError("JOB_LOAD_FAILED");
  }
}

async function safeResultExists(
  resultExists: RunJobHandlerOptions["resultExists"],
  database: JobDatabaseExecutor,
): Promise<boolean> {
  try {
    return await resultExists(database);
  } catch {
    throw jobDatabaseError("JOB_RESULT_CHECK_FAILED");
  }
}

function validateDeliveryContext(context: WorkspaceContext, envelope: QueueJobEnvelope): void {
  if (context.workspaceId !== envelope.workspaceId) {
    throw new OperationalError({
      code: "JOB_DELIVERY_NOT_FOUND",
      errorClass: "not_found",
      statusCode: 404,
    });
  }
}

function validateDeliveryJob(
  job: Awaited<ReturnType<typeof loadOwnedJob>> & {},
  envelope: QueueJobEnvelope,
): void {
  if (
    job.correlationId !== envelope.correlationId ||
    job.handlerVersion !== envelope.handlerVersion ||
    job.queueName !== envelope.queueName ||
    job.workspaceId !== envelope.workspaceId
  ) {
    throw validationError("JOB_DELIVERY_MISMATCH");
  }
}

function claimToIgnored(claim: Exclude<JobClaimResult, { claimed: true }>): JobHandlerRunResult {
  switch (claim.reason) {
    case "ATTEMPTS_EXHAUSTED":
      return Object.freeze({ outcome: "IGNORED", reason: "ATTEMPTS_EXHAUSTED" });
    case "MISSING":
      return Object.freeze({ outcome: "IGNORED", reason: "MISSING" });
    case "STATE":
    case "VERSION_CONFLICT":
      return Object.freeze({ outcome: "IGNORED", reason: "LEASED" });
  }
}

function logJob(
  logger: JsonLogger,
  event: string,
  job: NonNullable<Awaited<ReturnType<typeof loadOwnedJob>>>,
  state: string,
): void {
  const correlationId = parseCorrelationId(job.correlationId);
  if (!correlationId) return;
  logger.info(event, {
    attempt: job.attemptCount,
    correlationId,
    handlerVersion: job.handlerVersion,
    jobId: job.id,
    jobState: state,
    stage: job.stage,
    workspaceId: job.workspaceId,
  });
}

function jobDatabaseError(code: string): OperationalError {
  return new OperationalError({
    code,
    errorClass: "dependency",
    retryable: true,
    statusCode: 503,
  });
}

function validationError(code: string): OperationalError {
  return new OperationalError({ code, errorClass: "validation", statusCode: 400 });
}

function validatePositiveInteger(value: number, code: string): void {
  if (!Number.isSafeInteger(value) || value < 1) throw validationError(code);
}
