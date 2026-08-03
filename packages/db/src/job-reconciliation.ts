import { assertJobTransition, queueDeliveryExpirySeconds } from "@studio-parallel/domain";
import {
  OperationalError,
  parseCorrelationId,
  type JsonLogger,
  type MetricRecorder,
} from "@studio-parallel/observability";

import type { Prisma, PrismaClient } from "./generated/prisma/client.js";
import { createId } from "./id.js";
import { recoverExpiredBackgroundJobLease, type JobDatabaseExecutor } from "./job-execution.js";
import { createWorkspaceContext } from "./workspace-context.js";

type JobDatabase = PrismaClient;
type JobTransaction = Prisma.TransactionClient;

export type ReconciliationJob = Readonly<{
  cancellationRequestedAt: Date | null;
  id: string;
  state: string;
  workspaceId: string;
}>;

export type JobResultInspection = "ABSENT" | "PRESENT" | "UNSUPPORTED";

export type CleanupDebtOutcome = Readonly<{
  outcome: "FLAGGED" | "REPAIRED";
  reasonCode: string;
  resourceId?: string;
  resourceType: string;
  workspaceId: string;
}>;

export type JobCleanupDebtHook = (
  input: Readonly<{
    database: JobDatabase;
    limit: number;
    now: Date;
  }>,
) => Promise<readonly CleanupDebtOutcome[]>;

export type JobReconciliationTelemetry = Readonly<{
  logger: JsonLogger;
  metrics: MetricRecorder;
}>;

export type ReconcileBackgroundJobsOptions = Readonly<{
  batchSize?: number;
  cleanupDebtHooks?: readonly JobCleanupDebtHook[];
  correlationId: string;
  database: JobDatabase;
  inspectResult(
    database: JobDatabaseExecutor,
    job: ReconciliationJob,
  ): Promise<JobResultInspection>;
  now?: Date;
  telemetry: JobReconciliationTelemetry;
}>;

export type ReconcileBackgroundJobsResult = Readonly<{
  flagged: number;
  inspected: number;
  repaired: number;
}>;

const defaultBatchSize = 50;
const maximumBatchSize = 100;
const safeCodePattern = /^[A-Z][A-Z0-9_]{0,63}$/u;
const safeResourceTypePattern = /^[a-z][a-z0-9_]{0,63}$/u;

export async function reconcileBackgroundJobs(
  options: ReconcileBackgroundJobsOptions,
): Promise<ReconcileBackgroundJobsResult> {
  const correlationId = parseCorrelationId(options.correlationId);
  if (!correlationId) throw validationError("JOB_RECONCILIATION_CORRELATION_INVALID");
  const batchSize = options.batchSize ?? defaultBatchSize;
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > maximumBatchSize) {
    throw validationError("JOB_RECONCILIATION_BATCH_INVALID");
  }
  const now = options.now ?? new Date();
  let repaired = 0;
  let flagged = 0;
  let inspected = 0;

  const expired = await options.database.backgroundJob.findMany({
    select: { cancellationRequestedAt: true, id: true, state: true, workspaceId: true },
    take: batchSize,
    where: { leaseExpiresAt: { lte: now }, state: "PROCESSING" },
  });
  inspected += expired.length;
  for (const job of expired) {
    const recovered = await recoverExpiredBackgroundJobLease(
      options.database,
      createWorkspaceContext(job.workspaceId),
      job.id,
      now,
      { actorService: "job-reconciler", correlationId },
    );
    if (!recovered) continue;
    repaired += 1;
    const reasonCode = job.cancellationRequestedAt
      ? "CANCELLATION_REQUEST_RECOVERED"
      : "EXPIRED_LEASE_RECOVERED";
    recordReconciliationTelemetry(options.telemetry, correlationId, job.workspaceId, {
      jobId: job.id,
      outcome: "REPAIRED",
      reasonCode,
    });
  }

  const dueRetries = await options.database.backgroundJob.findMany({
    select: { cancellationRequestedAt: true, id: true, state: true, workspaceId: true },
    take: batchSize,
    where: { nextAttemptAt: { lte: now }, state: "RETRY_SCHEDULED" },
  });
  inspected += dueRetries.length;
  for (const job of dueRetries) {
    if (await requeueDueRetry(options.database, job.id, job.workspaceId, correlationId, now)) {
      repaired += 1;
      recordReconciliationTelemetry(options.telemetry, correlationId, job.workspaceId, {
        jobId: job.id,
        outcome: "REPAIRED",
        reasonCode: "RETRY_DUE_REQUEUED",
      });
    }
  }

  // A job returned to QUEUED whose outbox row still says it was dispatched will
  // never be delivered again: the dispatcher only publishes undispatched rows,
  // and no other rule matches this shape. Jobs stranded before the release path
  // started resetting the row are recovered here.
  //
  // The age bound is the whole rule. QUEUED with no lease and a dispatched
  // outbox is *also* the state of a perfectly healthy job in the window between
  // the dispatcher publishing and a worker claiming, so an unbounded version of
  // this query matches almost every queued job on every tick — requeueing live
  // work, inflating the dispatch count and making a repair count that should
  // read zero read permanently non-zero. Past the delivery expiry no message can
  // still be in flight, so what remains is genuinely stranded.
  const strandedDelivery = await options.database.backgroundJob.findMany({
    select: { cancellationRequestedAt: true, id: true, state: true, workspaceId: true },
    take: batchSize,
    where: {
      leaseId: null,
      outbox: {
        cancelledAt: null,
        dispatchedAt: { lte: new Date(now.getTime() - queueDeliveryExpirySeconds * 1_000) },
      },
      state: "QUEUED",
    },
  });
  inspected += strandedDelivery.length;
  for (const job of strandedDelivery) {
    if (
      await requeueStrandedDelivery(options.database, job.id, job.workspaceId, correlationId, now)
    ) {
      repaired += 1;
      recordReconciliationTelemetry(options.telemetry, correlationId, job.workspaceId, {
        jobId: job.id,
        outcome: "REPAIRED",
        reasonCode: "STRANDED_DELIVERY_REQUEUED",
      });
    }
  }

  const missingOutbox = await options.database.backgroundJob.findMany({
    select: { cancellationRequestedAt: true, id: true, state: true, workspaceId: true },
    take: batchSize,
    where: { outbox: null, state: "QUEUED" },
  });
  inspected += missingOutbox.length;
  for (const job of missingOutbox) {
    if (await repairMissingOutbox(options.database, job.id, job.workspaceId, correlationId, now)) {
      repaired += 1;
      recordReconciliationTelemetry(options.telemetry, correlationId, job.workspaceId, {
        jobId: job.id,
        outcome: "REPAIRED",
        reasonCode: "MISSING_OUTBOX_RECREATED",
      });
    }
  }

  const resultCandidates = await options.database.backgroundJob.findMany({
    select: { cancellationRequestedAt: true, id: true, state: true, workspaceId: true },
    take: batchSize,
  });
  inspected += resultCandidates.length;
  for (const job of resultCandidates) {
    const result = await options.inspectResult(options.database, job);
    if (result === "UNSUPPORTED") continue;

    if (result === "ABSENT" && job.state === "SUCCEEDED") {
      if (
        await flagAmbiguousJob(
          options.database,
          job.id,
          job.workspaceId,
          correlationId,
          "SUCCEEDED_RESULT_MISSING",
          now,
        )
      ) {
        flagged += 1;
        recordReconciliationTelemetry(options.telemetry, correlationId, job.workspaceId, {
          jobId: job.id,
          outcome: "FLAGGED",
          reasonCode: "SUCCEEDED_RESULT_MISSING",
        });
      }
      continue;
    }

    if (result !== "PRESENT" || job.state === "SUCCEEDED") continue;
    if (job.state === "FAILED_ATTENTION" || job.cancellationRequestedAt) {
      if (
        await flagAmbiguousJob(
          options.database,
          job.id,
          job.workspaceId,
          correlationId,
          "TERMINAL_RESULT_CONFLICT",
          now,
        )
      ) {
        flagged += 1;
        recordReconciliationTelemetry(options.telemetry, correlationId, job.workspaceId, {
          jobId: job.id,
          outcome: "FLAGGED",
          reasonCode: "TERMINAL_RESULT_CONFLICT",
        });
      }
      continue;
    }

    if (
      await repairCommittedResult(options.database, job.id, job.workspaceId, correlationId, now)
    ) {
      repaired += 1;
      recordReconciliationTelemetry(options.telemetry, correlationId, job.workspaceId, {
        jobId: job.id,
        outcome: "REPAIRED",
        reasonCode: "COMMITTED_RESULT_STATE_REPAIRED",
      });
    }
  }

  for (const hook of options.cleanupDebtHooks ?? []) {
    const outcomes = await hook({ database: options.database, limit: batchSize, now });
    if (outcomes.length > batchSize) throw validationError("JOB_CLEANUP_HOOK_LIMIT_EXCEEDED");
    const seen = new Set<string>();
    for (const outcome of outcomes) {
      validateCleanupDebtOutcome(outcome);
      const key = `${outcome.workspaceId}:${outcome.resourceType}:${outcome.resourceId ?? ""}:${outcome.reasonCode}:${outcome.outcome}`;
      if (seen.has(key)) continue;
      seen.add(key);
      inspected += 1;
      if (outcome.outcome === "REPAIRED") repaired += 1;
      else flagged += 1;
      await auditServiceOutcome(
        options.database,
        correlationId,
        outcome.workspaceId,
        outcome.resourceType,
        outcome.resourceId ?? null,
        outcome.outcome,
        outcome.reasonCode,
        now,
      );
      recordReconciliationTelemetry(options.telemetry, correlationId, outcome.workspaceId, {
        outcome: outcome.outcome,
        reasonCode: outcome.reasonCode,
      });
    }
  }

  options.telemetry.logger.info("job.reconciliation.completed", {
    correlationId,
    outcome: flagged > 0 ? "FLAGGED" : "COMPLETED",
    source: "reconciliation",
    stage: "reconciliation",
    value: repaired + flagged,
  });
  return Object.freeze({ flagged, inspected, repaired });
}

async function requeueDueRetry(
  database: JobDatabase,
  jobId: string,
  workspaceId: string,
  correlationId: ReturnType<typeof parseCorrelationId> & {},
  now: Date,
): Promise<boolean> {
  return database.$transaction(async (transaction) => {
    const job = await transaction.backgroundJob.findFirst({
      where: { id: jobId, nextAttemptAt: { lte: now }, state: "RETRY_SCHEDULED", workspaceId },
    });
    if (!job) return false;
    assertJobTransition("RETRY_SCHEDULED", "QUEUED");
    const updated = await transaction.backgroundJob.updateMany({
      data: {
        dispatchStatus: "PENDING",
        nextAttemptAt: null,
        queuedAt: now,
        stage: "queued",
        state: "QUEUED",
        version: { increment: 1 },
      },
      where: {
        id: job.id,
        nextAttemptAt: { lte: now },
        state: "RETRY_SCHEDULED",
        version: job.version,
      },
    });
    if (updated.count !== 1) return false;
    await resetOutbox(transaction, job, now);
    await createServiceAudit(
      transaction,
      correlationId,
      workspaceId,
      "background_job",
      job.id,
      "REPAIRED",
      "RETRY_DUE_REQUEUED",
      now,
    );
    return true;
  });
}

/**
 * Makes a stranded job deliverable again.
 *
 * Clears the delivery record so the dispatcher will publish it, and returns the
 * job's dispatch status to PENDING to match. The delivery identifier is dropped
 * rather than reused, because #114 established that reusing one makes the queue
 * refuse the redelivery.
 */
async function requeueStrandedDelivery(
  database: JobDatabase,
  jobId: string,
  workspaceId: string,
  correlationId: ReturnType<typeof parseCorrelationId> & {},
  now: Date,
): Promise<boolean> {
  return database.$transaction(async (transaction) => {
    const job = await transaction.backgroundJob.findFirst({
      where: {
        id: jobId,
        leaseId: null,
        outbox: { cancelledAt: null, dispatchedAt: { not: null } },
        state: "QUEUED",
        workspaceId,
      },
    });
    if (!job) return false;

    // The job row goes first, in the order every other repair in this file takes
    // its locks, and its count is the concurrency guard: a worker that claimed
    // this job between the scan and here has already moved the version, and
    // reporting a repair that did not happen would be worse than doing nothing.
    const claimed = await transaction.backgroundJob.updateMany({
      data: { dispatchStatus: "PENDING", version: { increment: 1 } },
      where: { id: job.id, version: job.version, workspaceId },
    });
    if (claimed.count !== 1) return false;

    await resetOutbox(transaction, job, now);

    await createServiceAudit(
      transaction,
      correlationId,
      workspaceId,
      "background_job",
      job.id,
      "REPAIRED",
      "STRANDED_DELIVERY_REQUEUED",
      now,
    );

    return true;
  });
}

async function repairMissingOutbox(
  database: JobDatabase,
  jobId: string,
  workspaceId: string,
  correlationId: ReturnType<typeof parseCorrelationId> & {},
  now: Date,
): Promise<boolean> {
  return database.$transaction(async (transaction) => {
    const job = await transaction.backgroundJob.findFirst({
      where: { id: jobId, outbox: null, state: "QUEUED", workspaceId },
    });
    if (!job) return false;
    await transaction.jobOutbox.create({
      data: {
        backgroundJobId: job.id,
        correlationId: job.correlationId,
        handlerVersion: job.handlerVersion,
        id: createId(),
        nextAttemptAt: now,
        queueName: job.queueName,
        workspaceId: job.workspaceId,
      },
    });
    await createServiceAudit(
      transaction,
      correlationId,
      workspaceId,
      "background_job",
      job.id,
      "REPAIRED",
      "MISSING_OUTBOX_RECREATED",
      now,
    );
    return true;
  });
}

async function repairCommittedResult(
  database: JobDatabase,
  jobId: string,
  workspaceId: string,
  correlationId: ReturnType<typeof parseCorrelationId> & {},
  now: Date,
): Promise<boolean> {
  return database.$transaction(async (transaction) => {
    const job = await transaction.backgroundJob.findFirst({
      where: {
        cancellationRequestedAt: null,
        id: jobId,
        state: { in: ["QUEUED", "PROCESSING", "RETRY_SCHEDULED"] },
        workspaceId,
      },
    });
    if (!job) return false;

    const updated = await transaction.backgroundJob.updateMany({
      data: {
        completedAt: now,
        heartbeatAt: now,
        lastErrorClass: null,
        lastErrorCode: null,
        leaseExpiresAt: null,
        leaseId: null,
        nextAction: null,
        nextAttemptAt: null,
        reconciliationCode: null,
        reconciliationRequiredAt: null,
        stage: "completed",
        state: "SUCCEEDED",
        version: { increment: 1 },
      },
      where: { id: job.id, state: job.state, version: job.version, workspaceId },
    });
    if (updated.count !== 1) return false;

    if (job.leaseId) {
      const attempt = await transaction.jobAttempt.updateMany({
        data: { completedAt: now, heartbeatAt: now, stage: "completed", state: "SUCCEEDED" },
        where: { leaseId: job.leaseId, state: "ACTIVE", workspaceId },
      });
      if (attempt.count !== 1) throw reconciliationError("JOB_RECONCILIATION_ATTEMPT_MISSING");
    }
    await transaction.jobOutbox.updateMany({
      data: { cancelledAt: now, leaseExpiresAt: null, leaseId: null },
      where: { backgroundJobId: job.id },
    });
    await createServiceAudit(
      transaction,
      correlationId,
      workspaceId,
      "background_job",
      job.id,
      "REPAIRED",
      "COMMITTED_RESULT_STATE_REPAIRED",
      now,
    );
    return true;
  });
}

async function flagAmbiguousJob(
  database: JobDatabase,
  jobId: string,
  workspaceId: string,
  correlationId: ReturnType<typeof parseCorrelationId> & {},
  reasonCode: string,
  now: Date,
): Promise<boolean> {
  const updated = await database.$transaction(async (transaction) => {
    const result = await transaction.backgroundJob.updateMany({
      data: {
        reconciliationCode: reasonCode,
        reconciliationRequiredAt: now,
        version: { increment: 1 },
      },
      where: {
        id: jobId,
        OR: [{ reconciliationCode: null }, { reconciliationCode: { not: reasonCode } }],
        workspaceId,
      },
    });
    if (result.count !== 1) return false;
    await createServiceAudit(
      transaction,
      correlationId,
      workspaceId,
      "background_job",
      jobId,
      "FLAGGED",
      reasonCode,
      now,
    );
    return true;
  });
  return updated;
}

async function resetOutbox(
  transaction: JobTransaction,
  job: Readonly<{
    correlationId: string;
    handlerVersion: number;
    id: string;
    queueName: string;
    workspaceId: string;
  }>,
  now: Date,
): Promise<void> {
  await transaction.jobOutbox.upsert({
    create: {
      backgroundJobId: job.id,
      correlationId: job.correlationId,
      handlerVersion: job.handlerVersion,
      id: createId(),
      nextAttemptAt: now,
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
}

async function createServiceAudit(
  transaction: JobTransaction,
  correlationId: ReturnType<typeof parseCorrelationId> & {},
  workspaceId: string,
  resourceType: string,
  resourceId: string | null,
  outcome: "FLAGGED" | "REPAIRED",
  reasonCode: string,
  now: Date,
): Promise<void> {
  await transaction.auditEvent.create({
    data: serviceAuditData(
      correlationId,
      workspaceId,
      resourceType,
      resourceId,
      outcome,
      reasonCode,
      now,
    ),
  });
}

async function auditServiceOutcome(
  database: JobDatabase,
  correlationId: ReturnType<typeof parseCorrelationId> & {},
  workspaceId: string,
  resourceType: string,
  resourceId: string | null,
  outcome: "FLAGGED" | "REPAIRED",
  reasonCode: string,
  now: Date,
): Promise<void> {
  await database.auditEvent.create({
    data: serviceAuditData(
      correlationId,
      workspaceId,
      resourceType,
      resourceId,
      outcome,
      reasonCode,
      now,
    ),
  });
}

function serviceAuditData(
  correlationId: ReturnType<typeof parseCorrelationId> & {},
  workspaceId: string,
  resourceType: string,
  resourceId: string | null,
  outcome: "FLAGGED" | "REPAIRED",
  reasonCode: string,
  now: Date,
) {
  return {
    action: "job.reconcile",
    actorService: "job-reconciler",
    actorType: "SERVICE" as const,
    correlationId,
    id: createId(),
    occurredAt: now,
    outcome,
    reasonCode,
    resourceId,
    resourceType,
    workspaceId,
  };
}

function recordReconciliationTelemetry(
  telemetry: JobReconciliationTelemetry,
  correlationId: ReturnType<typeof parseCorrelationId> & {},
  workspaceId: string,
  input: Readonly<{ jobId?: string; outcome: "FLAGGED" | "REPAIRED"; reasonCode: string }>,
): void {
  telemetry.logger[input.outcome === "FLAGGED" ? "warn" : "info"](
    input.outcome === "FLAGGED" ? "job.reconciliation.flagged" : "job.reconciliation.repaired",
    {
      correlationId,
      ...(input.jobId ? { jobId: input.jobId } : {}),
      outcome: input.outcome,
      reasonCode: input.reasonCode,
      source: "reconciliation",
      stage: "reconciliation",
      workspaceId,
    },
  );
  telemetry.metrics.increment("job.reconciliation.count", {
    correlationId,
    ...(input.jobId ? { jobId: input.jobId } : {}),
    stage: input.outcome === "FLAGGED" ? "reconciliation_flagged" : "reconciliation_repaired",
    workspaceId,
  });
}

function validateCleanupDebtOutcome(outcome: CleanupDebtOutcome): void {
  if (
    !safeCodePattern.test(outcome.reasonCode) ||
    !safeResourceTypePattern.test(outcome.resourceType) ||
    !outcome.workspaceId
  ) {
    throw validationError("JOB_CLEANUP_HOOK_RESULT_INVALID");
  }
}

function validationError(code: string): OperationalError {
  return new OperationalError({ code, errorClass: "validation", statusCode: 400 });
}

function reconciliationError(code: string): OperationalError {
  return new OperationalError({ code, errorClass: "conflict", statusCode: 409 });
}
