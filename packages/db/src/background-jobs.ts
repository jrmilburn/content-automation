import { isQueueName, type QueueName, type QueuePublisher } from "@studio-parallel/domain";
import {
  classifyError,
  OperationalError,
  parseCorrelationId,
  reportError,
  type ErrorMonitor,
  type JsonLogger,
} from "@studio-parallel/observability";

import type { Prisma, PrismaClient } from "./generated/prisma/client.js";
import { createId, isUuidV7 } from "./id.js";
import type { WorkspaceContext } from "./workspace-context.js";

type QueueDatabase = PrismaClient;
type QueueTransaction = Prisma.TransactionClient;

export type EnqueueBackgroundJobInput = Readonly<{
  correlationId: string;
  handlerVersion: number;
  idempotencyKey: string;
  inputVersion?: string;
  maxAttempts?: number;
  priority?: number;
  queueName: QueueName;
  resourceId?: string;
  resourceType?: string;
}>;

export type EnqueueBackgroundJobResult = Readonly<{
  created: boolean;
  job: Readonly<{
    correlationId: string;
    handlerVersion: number;
    id: string;
    queueName: string;
    workspaceId: string;
  }>;
}>;

export type ReconcileJobOutboxOptions = Readonly<{
  batchSize?: number;
  failureDelayMs?: number;
  leaseDurationMs?: number;
  now?: Date;
}>;

export type ReconcileJobOutboxResult = Readonly<{
  claimed: number;
  dispatched: number;
  failed: number;
}>;

export type DispatchTelemetry = Readonly<{
  logger: JsonLogger;
  monitor: ErrorMonitor;
}>;

type LeasedOutboxRecord = Readonly<{
  backgroundJobId: string;
  correlationId: string;
  dispatchAttemptCount: number;
  handlerVersion: number;
  id: string;
  leaseId: string;
  queueName: string;
  workspaceId: string;
}>;

const defaultBatchSize = 20;
const defaultFailureDelayMs = 5_000;
const defaultLeaseDurationMs = 30_000;
const safeIdempotencyKeyPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$/u;
const safeInputVersionPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const safeResourceTypePattern = /^[a-z][a-z0-9_]{0,63}$/u;

export async function enqueueBackgroundJob(
  database: QueueDatabase,
  context: WorkspaceContext,
  input: EnqueueBackgroundJobInput,
): Promise<EnqueueBackgroundJobResult> {
  const jobId = createId();
  const outboxId = createId();
  try {
    return await database.$transaction((transaction) =>
      enqueueBackgroundJobInTransaction(transaction, context, input, { jobId, outboxId }),
    );
  } catch (error) {
    if (error instanceof OperationalError) throw error;
    throw queueDatabaseError("JOB_ENQUEUE_FAILED");
  }
}

export async function enqueueBackgroundJobInTransaction(
  transaction: QueueTransaction,
  context: WorkspaceContext,
  input: EnqueueBackgroundJobInput,
  generatedIds: Readonly<{ jobId: string; outboxId: string }> = {
    jobId: createId(),
    outboxId: createId(),
  },
): Promise<EnqueueBackgroundJobResult> {
  const idempotencyKey = input.idempotencyKey.trim();
  const maxAttempts = input.maxAttempts ?? 8;
  const priority = input.priority ?? 0;
  const resourceType = input.resourceType?.trim();
  const inputVersion = input.inputVersion?.trim();

  if (!safeIdempotencyKeyPattern.test(idempotencyKey)) {
    throw new OperationalError({
      code: "JOB_IDEMPOTENCY_KEY_INVALID",
      errorClass: "validation",
      statusCode: 400,
    });
  }

  if (!Number.isSafeInteger(input.handlerVersion) || input.handlerVersion < 1) {
    throw new OperationalError({
      code: "JOB_HANDLER_VERSION_INVALID",
      errorClass: "validation",
      statusCode: 400,
    });
  }

  if (!isQueueName(input.queueName)) {
    throw new OperationalError({
      code: "JOB_QUEUE_INVALID",
      errorClass: "validation",
      statusCode: 400,
    });
  }

  if (!parseCorrelationId(input.correlationId)) {
    throw new OperationalError({
      code: "JOB_CORRELATION_INVALID",
      errorClass: "validation",
      statusCode: 400,
    });
  }

  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 100) {
    throw validationError("JOB_MAX_ATTEMPTS_INVALID");
  }

  if (!Number.isSafeInteger(priority) || priority < -1_000 || priority > 1_000) {
    throw validationError("JOB_PRIORITY_INVALID");
  }

  if ((resourceType === undefined) !== (input.resourceId === undefined)) {
    throw validationError("JOB_RESOURCE_INVALID");
  }

  if (resourceType !== undefined && !safeResourceTypePattern.test(resourceType)) {
    throw validationError("JOB_RESOURCE_INVALID");
  }

  if (input.resourceId !== undefined && !isUuidV7(input.resourceId)) {
    throw validationError("JOB_RESOURCE_INVALID");
  }

  if (inputVersion !== undefined && !safeInputVersionPattern.test(inputVersion)) {
    throw validationError("JOB_INPUT_VERSION_INVALID");
  }

  try {
    const job = await transaction.backgroundJob.upsert({
      create: {
        correlationId: input.correlationId,
        handlerVersion: input.handlerVersion,
        id: generatedIds.jobId,
        idempotencyKey,
        inputVersion: inputVersion ?? null,
        maxAttempts,
        priority,
        queueName: input.queueName,
        resourceId: input.resourceId ?? null,
        resourceType: resourceType ?? null,
        workspaceId: context.workspaceId,
      },
      update: {},
      where: {
        workspaceId_queueName_handlerVersion_idempotencyKey: {
          handlerVersion: input.handlerVersion,
          idempotencyKey,
          queueName: input.queueName,
          workspaceId: context.workspaceId,
        },
      },
    });

    if (
      job.id !== generatedIds.jobId &&
      (job.inputVersion !== (inputVersion ?? null) ||
        job.maxAttempts !== maxAttempts ||
        job.priority !== priority ||
        job.resourceId !== (input.resourceId ?? null) ||
        job.resourceType !== (resourceType ?? null))
    ) {
      throw new OperationalError({
        code: "JOB_IDEMPOTENCY_CONFLICT",
        errorClass: "conflict",
        statusCode: 409,
      });
    }

    await transaction.jobOutbox.upsert({
      create: {
        backgroundJobId: job.id,
        correlationId: job.correlationId,
        handlerVersion: job.handlerVersion,
        id: generatedIds.outboxId,
        queueName: job.queueName,
        workspaceId: job.workspaceId,
      },
      update: {},
      where: { backgroundJobId: job.id },
    });

    return Object.freeze({
      created: job.id === generatedIds.jobId,
      job: Object.freeze({
        correlationId: job.correlationId,
        handlerVersion: job.handlerVersion,
        id: job.id,
        queueName: job.queueName,
        workspaceId: job.workspaceId,
      }),
    });
  } catch (error) {
    if (error instanceof OperationalError) throw error;
    throw queueDatabaseError("JOB_ENQUEUE_FAILED");
  }
}

export async function reconcileJobOutbox(
  database: QueueDatabase,
  publisher: QueuePublisher,
  telemetry: DispatchTelemetry,
  options: ReconcileJobOutboxOptions = {},
): Promise<ReconcileJobOutboxResult> {
  const now = options.now ?? new Date();
  const failureDelayMs = options.failureDelayMs ?? defaultFailureDelayMs;
  const leaseDurationMs = options.leaseDurationMs ?? defaultLeaseDurationMs;
  const batchSize = options.batchSize ?? defaultBatchSize;

  validatePositiveInteger(batchSize, "JOB_DISPATCH_BATCH_INVALID");
  validatePositiveInteger(failureDelayMs, "JOB_DISPATCH_DELAY_INVALID");
  validatePositiveInteger(leaseDurationMs, "JOB_DISPATCH_LEASE_INVALID");

  let records: readonly LeasedOutboxRecord[];

  try {
    records = await leasePendingOutbox(database, now, leaseDurationMs, batchSize);
  } catch {
    throw queueDatabaseError("JOB_OUTBOX_LEASE_FAILED");
  }

  const outcomes = await Promise.all(
    records.map((record) =>
      dispatchOutboxRecord(database, publisher, telemetry, record, now, failureDelayMs),
    ),
  );
  const dispatched = outcomes.filter(Boolean).length;

  return Object.freeze({
    claimed: records.length,
    dispatched,
    failed: records.length - dispatched,
  });
}

async function leasePendingOutbox(
  database: QueueDatabase,
  now: Date,
  leaseDurationMs: number,
  batchSize: number,
): Promise<readonly LeasedOutboxRecord[]> {
  const leaseId = createId();
  const leaseExpiresAt = new Date(now.getTime() + leaseDurationMs);

  return database.$queryRaw<LeasedOutboxRecord[]>`
    WITH candidates AS (
      SELECT "id"
      FROM "job_outbox"
      WHERE "dispatched_at" IS NULL
        AND "next_attempt_at" <= ${now}
        AND ("lease_expires_at" IS NULL OR "lease_expires_at" <= ${now})
      ORDER BY "created_at", "id"
      FOR UPDATE SKIP LOCKED
      LIMIT ${batchSize}
    )
    UPDATE "job_outbox" AS outbox
    SET "lease_id" = ${leaseId}::uuid,
        "lease_expires_at" = ${leaseExpiresAt},
        "dispatch_attempt_count" = outbox."dispatch_attempt_count" + 1,
        "updated_at" = ${now}
    FROM candidates
    WHERE outbox."id" = candidates."id"
    RETURNING
      outbox."id",
      outbox."workspace_id" AS "workspaceId",
      outbox."background_job_id" AS "backgroundJobId",
      outbox."queue_name" AS "queueName",
      outbox."handler_version" AS "handlerVersion",
      outbox."correlation_id" AS "correlationId",
      outbox."dispatch_attempt_count" AS "dispatchAttemptCount",
      outbox."lease_id" AS "leaseId"
  `;
}

async function dispatchOutboxRecord(
  database: QueueDatabase,
  publisher: QueuePublisher,
  telemetry: DispatchTelemetry,
  record: LeasedOutboxRecord,
  now: Date,
  failureDelayMs: number,
): Promise<boolean> {
  const correlationId = parseCorrelationId(record.correlationId);
  if (!correlationId) throw queueDatabaseError("JOB_CORRELATION_INVALID");

  try {
    const delivery = await publisher.publish({
      correlationId,
      domainJobId: record.backgroundJobId,
      handlerVersion: record.handlerVersion,
      queueName: record.queueName as QueueName,
      workspaceId: record.workspaceId,
    });

    await markOutboxDispatched(database, record, delivery.deliveryId, now);

    telemetry.logger.info(delivery.created ? "job.dispatched" : "job.dispatch_deduplicated", {
      attempt: record.dispatchAttemptCount,
      correlationId,
      jobId: record.backgroundJobId,
      stage: "dispatch",
      workspaceId: record.workspaceId,
    });
    return true;
  } catch (error) {
    const safeError = toDispatchError(error);
    const nextAttemptAt = new Date(now.getTime() + failureDelayMs);

    try {
      await database.jobOutbox.updateMany({
        data: {
          lastErrorCode: safeError.code,
          leaseExpiresAt: null,
          leaseId: null,
          nextAttemptAt,
        },
        where: {
          dispatchedAt: null,
          id: record.id,
          leaseId: record.leaseId,
        },
      });
    } catch {
      // The expiring lease remains the recovery hook if this best-effort release fails.
    }

    reportError(
      safeError,
      {
        correlationId,
        event: "job.dispatch_failed",
        jobId: record.backgroundJobId,
        stage: "dispatch",
        workspaceId: record.workspaceId,
      },
      telemetry,
    );
    return false;
  }
}

async function markOutboxDispatched(
  database: QueueDatabase,
  record: LeasedOutboxRecord,
  deliveryId: string,
  dispatchedAt: Date,
): Promise<void> {
  try {
    await database.$transaction(async (transaction) => {
      const marked = await transaction.jobOutbox.updateMany({
        data: {
          dispatchedAt,
          lastErrorCode: null,
          leaseExpiresAt: null,
          leaseId: null,
          queueDeliveryId: deliveryId,
        },
        where: {
          dispatchedAt: null,
          id: record.id,
          leaseId: record.leaseId,
        },
      });

      if (marked.count === 1) {
        await transaction.backgroundJob.update({
          data: { dispatchStatus: "DISPATCHED" },
          where: { id: record.backgroundJobId },
        });
      }
    });
  } catch {
    throw queueDatabaseError("JOB_DISPATCH_MARK_FAILED");
  }
}

function toDispatchError(error: unknown): OperationalError {
  const details = classifyError(error);

  if (details.errorCode !== "UNEXPECTED_ERROR") {
    return new OperationalError({
      code: details.errorCode,
      errorClass: details.errorClass === "unexpected" ? "dependency" : details.errorClass,
      retryable: details.retryable,
      statusCode: details.statusCode,
    });
  }

  return new OperationalError({
    code: "QUEUE_PUBLISH_FAILED",
    errorClass: "dependency",
    retryable: true,
    statusCode: 503,
  });
}

function queueDatabaseError(code: string): OperationalError {
  return new OperationalError({
    code,
    errorClass: "dependency",
    retryable: true,
    statusCode: 503,
  });
}

function validatePositiveInteger(value: number, code: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new OperationalError({ code, errorClass: "validation", statusCode: 400 });
  }
}

function validationError(code: string): OperationalError {
  return new OperationalError({ code, errorClass: "validation", statusCode: 400 });
}
