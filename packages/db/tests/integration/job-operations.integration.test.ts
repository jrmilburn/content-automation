import { loadDatabaseConfig } from "@studio-parallel/config";
import { JobHandlerFailure, type QueueJobEnvelope } from "@studio-parallel/domain";
import {
  createJsonLogger,
  createMetricRecorder,
  type JsonLogEvent,
  type MetricEvent,
} from "@studio-parallel/observability";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { enqueueBackgroundJob } from "../../src/background-jobs.js";
import { createDatabaseClient, type DatabaseClient } from "../../src/client.js";
import {
  claimBackgroundJob,
  runIdempotentJobHandler,
  type JobDatabaseExecutor,
  type JobHandlerExecutionContext,
  type TransactionalJobResult,
} from "../../src/job-execution.js";
import {
  cancelBackgroundJob,
  retryBackgroundJob,
  type JobOperationTelemetry,
  type JobOperatorContext,
} from "../../src/job-operations.js";
import { reconcileBackgroundJobs } from "../../src/job-reconciliation.js";
import { createWorkspaceContext } from "../../src/workspace-context.js";

const databaseConfig = loadDatabaseConfig();
const workspaceId = "01900000-0000-7000-8000-000000000001";
const workspaceContext = createWorkspaceContext(workspaceId);
const correlationId = "01990000-0000-7000-8000-000000000120";
const adminId = "01990000-0000-7000-8000-000000000121";
const memberId = "01990000-0000-7000-8000-000000000122";

let database: DatabaseClient;
let logEvents: JsonLogEvent[];
let metricEvents: MetricEvent[];
let telemetry: JobOperationTelemetry;
let adminContext: JobOperatorContext;

beforeAll(() => {
  database = createDatabaseClient(databaseConfig.DATABASE_URL);
});

beforeEach(async () => {
  logEvents = [];
  metricEvents = [];
  await database.auditEvent.deleteMany();
  await database.jobAttempt.deleteMany();
  await database.jobOutbox.deleteMany();
  await database.backgroundJob.deleteMany();
  await database.systemSetting.deleteMany({
    where: { key: { startsWith: "job.result." }, workspaceId },
  });
  await database.internalUser.deleteMany();
  await database.workspace.deleteMany({ where: { id: { not: workspaceId } } });

  const admin = await database.internalUser.create({
    data: {
      email: "job-admin@example.invalid",
      id: adminId,
      role: "ADMIN",
      workspaceId,
    },
  });
  await database.internalUser.create({
    data: {
      email: "job-member@example.invalid",
      id: memberId,
      role: "MEMBER",
      workspaceId,
    },
  });
  telemetry = createTelemetry();
  adminContext = {
    correlationId,
    principal: {
      internalUserId: admin.id,
      sessionVersion: admin.sessionVersion,
      workspaceId: admin.workspaceId,
    },
  };
});

afterAll(async () => {
  await database.auditEvent.deleteMany();
  await database.jobAttempt.deleteMany();
  await database.jobOutbox.deleteMany();
  await database.backgroundJob.deleteMany();
  await database.systemSetting.deleteMany({
    where: { key: { startsWith: "job.result." }, workspaceId },
  });
  await database.internalUser.deleteMany();
  await database.workspace.deleteMany({ where: { id: { not: workspaceId } } });
  await database.$disconnect();
});

describe("authorised job cancellation", () => {
  it("cancels queued work idempotently and prevents its outbox from dispatching", async () => {
    const envelope = await enqueue("cancel-queued");
    const now = new Date("2026-07-28T04:15:00.000Z");

    await expect(cancel(envelope, now)).resolves.toEqual({
      outcome: "CANCELLED",
      reasonCode: "OPERATOR_REQUEST",
    });
    await expect(cancel(envelope, new Date(now.getTime() + 1))).resolves.toEqual({
      outcome: "ALREADY_APPLIED",
      reasonCode: "CANCELLATION_ALREADY_APPLIED",
    });

    await expect(
      database.backgroundJob.findUnique({ where: { id: envelope.domainJobId } }),
    ).resolves.toMatchObject({
      cancellationReasonCode: "OPERATOR_REQUEST",
      cancellationRequestedAt: now,
      completedAt: now,
      dispatchStatus: "CANCELLED",
      state: "CANCELLED",
    });
    await expect(
      database.jobOutbox.findUnique({ where: { backgroundJobId: envelope.domainJobId } }),
    ).resolves.toMatchObject({
      cancelledAt: now,
      leaseId: null,
    });
    await expect(
      database.auditEvent.findMany({
        where: { action: "job.cancel" },
        orderBy: { occurredAt: "asc" },
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        actorUserId: adminId,
        outcome: "CANCELLED",
        reasonCode: "OPERATOR_REQUEST",
      }),
      expect.objectContaining({
        actorUserId: adminId,
        outcome: "ALREADY_APPLIED",
        reasonCode: "CANCELLATION_ALREADY_APPLIED",
      }),
    ]);
    expect(logEvents).toContainEqual(
      expect.objectContaining({ source: "user", stage: "user_cancel" }),
    );
    expect(metricEvents.filter(({ metric }) => metric === "job.operation.count")).toHaveLength(2);
  });

  it("cooperatively cancels a safe processing stage before result commit", async () => {
    const envelope = await enqueue("cancel-processing");
    let notifyStarted = (): void => {};
    let continueHandler = (): void => {};
    const started = new Promise<void>((resolve) => {
      notifyStarted = resolve;
    });
    const resumed = new Promise<void>((resolve) => {
      continueHandler = resolve;
    });

    const execution = run(envelope, async (context) => {
      await context.recordStage("loading_inputs");
      notifyStarted();
      await resumed;
      await context.heartbeat();
      return successResult(envelope);
    });
    await started;

    await expect(cancel(envelope, new Date("2026-07-28T04:16:00.000Z"))).resolves.toEqual({
      outcome: "CANCELLATION_REQUESTED",
      reasonCode: "OPERATOR_REQUEST",
    });
    continueHandler();
    await expect(execution).resolves.toEqual({ outcome: "CANCELLED" });
    await expect(resultCount(envelope)).resolves.toBe(0);
    await expect(
      database.jobAttempt.findFirst({ where: { backgroundJobId: envelope.domainJobId } }),
    ).resolves.toMatchObject({
      state: "CANCELLED",
    });
  });

  it("cancels retry-scheduled work without leaving a due delivery", async () => {
    const envelope = await enqueue("cancel-retry-scheduled", { maxAttempts: 2 });
    const failedAt = new Date("2026-07-28T04:15:30.000Z");
    await run(
      envelope,
      async () => {
        throw new JobHandlerFailure({ errorClass: "TRANSIENT", errorCode: "PROVIDER_TIMEOUT" });
      },
      failedAt,
    );

    await expect(cancel(envelope, new Date(failedAt.getTime() + 1))).resolves.toEqual({
      outcome: "CANCELLED",
      reasonCode: "OPERATOR_REQUEST",
    });
    await expect(
      database.backgroundJob.findUnique({ where: { id: envelope.domainJobId } }),
    ).resolves.toMatchObject({ nextAttemptAt: null, state: "CANCELLED" });
  });

  it("refuses cancellation after a provider stage and gives cross-workspace IDs no signal", async () => {
    const envelope = await enqueue("cancel-unsafe");
    const claim = await claimBackgroundJob(database, workspaceContext, envelope.domainJobId);
    expect(claim.claimed).toBe(true);
    if (!claim.claimed) throw new Error("expected claim");
    await database.backgroundJob.update({
      data: { stage: "uploading_file" },
      where: { id: envelope.domainJobId },
    });
    await database.jobAttempt.update({
      data: { stage: "uploading_file" },
      where: { leaseId: claim.leaseId },
    });

    await expect(cancel(envelope)).resolves.toEqual({
      outcome: "REFUSED",
      reasonCode: "PROCESSING_STAGE_NOT_CANCELLABLE",
    });

    const secondWorkspace = await database.workspace.create({
      data: {
        id: "01990000-0000-7000-8000-000000000129",
        name: "Job Operations Isolation",
        slug: "job-operations-isolation",
      },
    });
    const foreign = await enqueue("foreign-cancel", {}, createWorkspaceContext(secondWorkspace.id));
    await expect(cancel(foreign)).resolves.toEqual({
      outcome: "NOT_FOUND",
      reasonCode: "JOB_NOT_FOUND",
    });
    await expect(cancel({ ...foreign, domainJobId: "not-a-job-id" })).resolves.toEqual({
      outcome: "NOT_FOUND",
      reasonCode: "JOB_NOT_FOUND",
    });
  });
});

describe("authorised manual retry", () => {
  it("preserves the logical signature, grants one bounded attempt and remains idempotent", async () => {
    const envelope = await failedJob("manual-retry");
    const before = await database.backgroundJob.findUniqueOrThrow({
      where: { id: envelope.domainJobId },
    });
    const now = new Date("2026-07-28T04:20:00.000Z");

    await expect(retry(envelope, now)).resolves.toEqual({
      outcome: "RETRY_QUEUED",
      reasonCode: "OPERATOR_REQUEST",
    });
    await expect(retry(envelope, new Date(now.getTime() + 1))).resolves.toEqual({
      outcome: "ALREADY_APPLIED",
      reasonCode: "RETRY_ALREADY_QUEUED",
    });

    const after = await database.backgroundJob.findUniqueOrThrow({
      where: { id: envelope.domainJobId },
    });
    expect(after).toMatchObject({
      attemptCount: before.attemptCount,
      handlerVersion: before.handlerVersion,
      id: before.id,
      idempotencyKey: before.idempotencyKey,
      inputVersion: before.inputVersion,
      maxAttempts: before.attemptCount + 1,
      queueName: before.queueName,
      resourceId: before.resourceId,
      resourceType: before.resourceType,
      state: "QUEUED",
      workspaceId: before.workspaceId,
    });
    await expect(
      database.jobOutbox.count({ where: { backgroundJobId: envelope.domainJobId } }),
    ).resolves.toBe(1);
    await expect(
      database.jobOutbox.findUnique({ where: { backgroundJobId: envelope.domainJobId } }),
    ).resolves.toMatchObject({
      cancelledAt: null,
      dispatchedAt: null,
      nextAttemptAt: now,
    });
  });

  it("refuses missing prerequisites, existing results, members and rate-limited admins", async () => {
    const missing = await failedJob("missing-prerequisite");
    await expect(
      retryBackgroundJob({
        checkPrerequisites: async () => ({ eligible: false, reasonCode: "ASSET_NOT_READY" }),
        context: adminContext,
        database,
        jobId: missing.domainJobId,
        reasonCode: "OPERATOR_REQUEST",
        resultExists: async () => false,
        telemetry,
      }),
    ).resolves.toEqual({ outcome: "REFUSED", reasonCode: "ASSET_NOT_READY" });

    const existing = await failedJob("existing-result");
    await createResult(existing);
    await expect(retry(existing)).resolves.toEqual({
      outcome: "REFUSED",
      reasonCode: "JOB_RESULT_ALREADY_EXISTS",
    });

    const member = await database.internalUser.findUniqueOrThrow({ where: { id: memberId } });
    await expect(
      retryBackgroundJob({
        checkPrerequisites: async () => ({ eligible: true }),
        context: {
          correlationId,
          principal: {
            internalUserId: member.id,
            sessionVersion: member.sessionVersion,
            workspaceId: member.workspaceId,
          },
        },
        database,
        jobId: existing.domainJobId,
        reasonCode: "OPERATOR_REQUEST",
        resultExists: async () => false,
        telemetry,
      }),
    ).resolves.toEqual({ outcome: "REFUSED", reasonCode: "ADMIN_REQUIRED" });

    const secondWorkspace = await database.workspace.create({
      data: {
        id: "01990000-0000-7000-8000-000000000128",
        name: "Retry Isolation Workspace",
        slug: "retry-isolation",
      },
    });
    const foreign = await enqueue(
      "foreign-retry",
      { maxAttempts: 1 },
      createWorkspaceContext(secondWorkspace.id),
    );
    await run(foreign, async () => {
      throw new JobHandlerFailure({ errorClass: "INVALID_INPUT", errorCode: "INPUT_NOT_READY" });
    });
    await expect(retry(foreign)).resolves.toEqual({
      outcome: "NOT_FOUND",
      reasonCode: "JOB_NOT_FOUND",
    });

    await database.auditEvent.createMany({
      data: Array.from({ length: 5 }, (_, index) => ({
        action: "job.retry",
        actorType: "USER" as const,
        actorUserId: adminId,
        correlationId,
        id: `01990000-0000-7000-8000-${String(130 + index).padStart(12, "0")}`,
        outcome: "REFUSED",
        reasonCode: "TEST_RATE_SAMPLE",
        resourceId: existing.domainJobId,
        resourceType: "background_job",
        workspaceId,
      })),
    });
    await expect(retry(existing)).resolves.toEqual({
      outcome: "RATE_LIMITED",
      reasonCode: "OPERATOR_RATE_LIMITED",
    });
  });

  it("rolls back the retry and audit when prerequisite inspection crashes", async () => {
    const envelope = await failedJob("retry-crash");
    const before = await database.backgroundJob.findUniqueOrThrow({
      where: { id: envelope.domainJobId },
    });
    const auditsBefore = await database.auditEvent.count();

    await expect(
      retryBackgroundJob({
        checkPrerequisites: async () => {
          throw new Error("injected prerequisite crash");
        },
        context: adminContext,
        database,
        jobId: envelope.domainJobId,
        reasonCode: "OPERATOR_REQUEST",
        resultExists: async () => false,
        telemetry,
      }),
    ).rejects.toThrow("injected prerequisite crash");
    await expect(
      database.backgroundJob.findUnique({ where: { id: envelope.domainJobId } }),
    ).resolves.toMatchObject({
      state: before.state,
      version: before.version,
    });
    await expect(database.auditEvent.count()).resolves.toBe(auditsBefore);
  });

  it("refuses manual retry while a consistency check is unresolved", async () => {
    const envelope = await failedJob("reconciliation-required");
    await database.backgroundJob.update({
      data: {
        reconciliationCode: "TERMINAL_RESULT_CONFLICT",
        reconciliationRequiredAt: new Date("2026-07-28T04:22:00.000Z"),
      },
      where: { id: envelope.domainJobId },
    });

    await expect(retry(envelope)).resolves.toEqual({
      outcome: "REFUSED",
      reasonCode: "JOB_RECONCILIATION_REQUIRED",
    });
  });
});

describe("background job reconciliation", () => {
  it("recreates a missing outbox once and audits the service repair", async () => {
    const envelope = await enqueue("missing-outbox");
    await database.jobOutbox.delete({ where: { backgroundJobId: envelope.domainJobId } });

    const first = await reconcile();
    const second = await reconcile();
    expect(first.repaired).toBe(1);
    expect(second.repaired).toBe(0);
    await expect(
      database.jobOutbox.count({ where: { backgroundJobId: envelope.domainJobId } }),
    ).resolves.toBe(1);
    await expect(
      database.auditEvent.findMany({ where: { reasonCode: "MISSING_OUTBOX_RECREATED" } }),
    ).resolves.toEqual([
      expect.objectContaining({ actorService: "job-reconciler", outcome: "REPAIRED" }),
    ]);
  });

  it("recovers expired leases and due retries into dispatchable work", async () => {
    const expired = await enqueue("reconcile-expired");
    const claimedAt = new Date("2026-07-28T04:25:00.000Z");
    await claimBackgroundJob(database, workspaceContext, expired.domainJobId, {
      leaseDurationMs: 1_000,
      now: claimedAt,
    });
    await reconcile(new Date(claimedAt.getTime() + 1_001));
    await expect(
      database.backgroundJob.findUnique({ where: { id: expired.domainJobId } }),
    ).resolves.toMatchObject({
      state: "QUEUED",
    });

    const due = await enqueue("reconcile-due");
    const failedAt = new Date("2026-07-28T04:26:00.000Z");
    await run(
      due,
      async () => {
        throw new JobHandlerFailure({ errorClass: "TRANSIENT", errorCode: "PROVIDER_TIMEOUT" });
      },
      failedAt,
    );
    await reconcile(new Date(failedAt.getTime() + 30_000));
    await expect(
      database.backgroundJob.findUnique({ where: { id: due.domainJobId } }),
    ).resolves.toMatchObject({
      dispatchStatus: "PENDING",
      state: "QUEUED",
    });
    await expect(
      database.jobOutbox.findUnique({ where: { backgroundJobId: due.domainJobId } }),
    ).resolves.toMatchObject({
      dispatchedAt: null,
    });
  });

  it("repairs an exact committed result but flags ambiguous missing/terminal conflicts", async () => {
    const committed = await enqueue("committed-state-mismatch");
    await createResult(committed);
    await reconcile();
    await expect(
      database.backgroundJob.findUnique({ where: { id: committed.domainJobId } }),
    ).resolves.toMatchObject({
      state: "SUCCEEDED",
    });

    const missing = await enqueue("missing-result");
    await run(missing, async () => successResult(missing));
    await database.systemSetting.deleteMany({ where: { key: resultKey(missing), workspaceId } });
    await reconcile();
    await expect(
      database.backgroundJob.findUnique({ where: { id: missing.domainJobId } }),
    ).resolves.toMatchObject({
      reconciliationCode: "SUCCEEDED_RESULT_MISSING",
      reconciliationRequiredAt: expect.any(Date),
      state: "SUCCEEDED",
    });

    const failed = await failedJob("terminal-result-conflict");
    await createResult(failed);
    await reconcile();
    await expect(
      database.backgroundJob.findUnique({ where: { id: failed.domainJobId } }),
    ).resolves.toMatchObject({
      reconciliationCode: "TERMINAL_RESULT_CONFLICT",
      state: "FAILED_ATTENTION",
    });
  });

  it("records bounded cleanup hooks and leaves state unchanged when result inspection crashes", async () => {
    const envelope = await enqueue("reconcile-crash");
    const before = await database.backgroundJob.findUniqueOrThrow({
      where: { id: envelope.domainJobId },
    });

    await expect(
      reconcileBackgroundJobs({
        correlationId,
        database,
        inspectResult: async () => {
          throw new Error("injected result inspection crash");
        },
        telemetry,
      }),
    ).rejects.toThrow("injected result inspection crash");
    await expect(
      database.backgroundJob.findUnique({ where: { id: envelope.domainJobId } }),
    ).resolves.toMatchObject({
      state: before.state,
      version: before.version,
    });

    await database.jobOutbox.delete({ where: { backgroundJobId: envelope.domainJobId } });
    const outcome = await reconcileBackgroundJobs({
      cleanupDebtHooks: [
        async () => [
          {
            outcome: "REPAIRED",
            reasonCode: "STALE_PROVIDER_FILE_DELETED",
            resourceType: "provider_file",
            workspaceId,
          },
          {
            outcome: "FLAGGED",
            reasonCode: "OBJECT_CLEANUP_AMBIGUOUS",
            resourceType: "video_asset",
            workspaceId,
          },
        ],
      ],
      correlationId,
      database,
      inspectResult,
      telemetry,
    });
    expect(outcome).toMatchObject({ flagged: 1, repaired: 2 });
    expect(logEvents).toContainEqual(
      expect.objectContaining({ source: "reconciliation", outcome: "FLAGGED" }),
    );
    expect(metricEvents.some(({ metric }) => metric === "job.reconciliation.count")).toBe(true);
  });
});

async function enqueue(
  idempotencyKey: string,
  options: Readonly<{ maxAttempts?: number }> = {},
  context = workspaceContext,
): Promise<QueueJobEnvelope> {
  const { job } = await enqueueBackgroundJob(database, context, {
    correlationId,
    handlerVersion: 1,
    idempotencyKey,
    queueName: "analysis.run",
    ...(options.maxAttempts === undefined ? {} : { maxAttempts: options.maxAttempts }),
  });
  return {
    correlationId: job.correlationId,
    domainJobId: job.id,
    handlerVersion: job.handlerVersion,
    queueName: "analysis.run",
    workspaceId: job.workspaceId,
  };
}

function cancel(envelope: QueueJobEnvelope, now?: Date) {
  return cancelBackgroundJob({
    context: adminContext,
    database,
    jobId: envelope.domainJobId,
    reasonCode: "OPERATOR_REQUEST",
    telemetry,
    ...(now ? { now } : {}),
  });
}

function retry(envelope: QueueJobEnvelope, now?: Date) {
  return retryBackgroundJob({
    checkPrerequisites: async () => ({ eligible: true }),
    context: adminContext,
    database,
    jobId: envelope.domainJobId,
    reasonCode: "OPERATOR_REQUEST",
    resultExists: (executor) => hasResult(executor, envelope),
    telemetry,
    ...(now ? { now } : {}),
  });
}

async function failedJob(idempotencyKey: string): Promise<QueueJobEnvelope> {
  const envelope = await enqueue(idempotencyKey, { maxAttempts: 1 });
  await run(envelope, async () => {
    throw new JobHandlerFailure({ errorClass: "INVALID_INPUT", errorCode: "INPUT_NOT_READY" });
  });
  return envelope;
}

function run(
  envelope: QueueJobEnvelope,
  execute: (context: JobHandlerExecutionContext) => Promise<TransactionalJobResult>,
  now?: Date,
) {
  return runIdempotentJobHandler({
    context: createWorkspaceContext(envelope.workspaceId),
    database,
    envelope,
    execute,
    logger: telemetry.logger,
    resultExists: (executor) => hasResult(executor, envelope),
    signal: new AbortController().signal,
    ...(now ? { now: () => now } : {}),
  });
}

function successResult(envelope: QueueJobEnvelope): TransactionalJobResult {
  return {
    commit: async (transaction) => {
      await transaction.systemSetting.create({
        data: {
          changeReason: "Idempotent job operations result fixture",
          changedByService: "job-operations-test",
          effectiveAt: new Date(),
          id: envelope.domainJobId,
          key: resultKey(envelope),
          value: { completed: true },
          valueType: "JSON",
          version: 1,
          workspaceId: envelope.workspaceId,
        },
      });
    },
  };
}

async function createResult(envelope: QueueJobEnvelope): Promise<void> {
  await database.$transaction((transaction) => successResult(envelope).commit(transaction));
}

function hasResult(executor: JobDatabaseExecutor, envelope: QueueJobEnvelope): Promise<boolean> {
  return executor.systemSetting
    .count({ where: { key: resultKey(envelope), workspaceId: envelope.workspaceId } })
    .then((count) => count === 1);
}

function resultCount(envelope: QueueJobEnvelope): Promise<number> {
  return database.systemSetting.count({
    where: { key: resultKey(envelope), workspaceId: envelope.workspaceId },
  });
}

function resultKey(envelope: QueueJobEnvelope): string {
  return `job.result.${envelope.domainJobId}`;
}

function inspectResult(executor: JobDatabaseExecutor, job: { id: string; workspaceId: string }) {
  return executor.systemSetting
    .count({ where: { key: `job.result.${job.id}`, workspaceId: job.workspaceId } })
    .then((count) => (count === 1 ? ("PRESENT" as const) : ("ABSENT" as const)));
}

function reconcile(now?: Date) {
  return reconcileBackgroundJobs({
    correlationId,
    database,
    inspectResult,
    telemetry,
    ...(now ? { now } : {}),
  });
}

function createTelemetry(): JobOperationTelemetry {
  return {
    logger: createJsonLogger({
      environment: "test",
      now: () => new Date("2026-07-28T04:10:00.000Z"),
      release: "integration-test",
      service: "worker",
      sink: (event) => logEvents.push(event),
    }),
    metrics: createMetricRecorder({
      environment: "test",
      now: () => new Date("2026-07-28T04:10:00.000Z"),
      release: "integration-test",
      service: "worker",
      sink: (event) => metricEvents.push(event),
    }),
  };
}
