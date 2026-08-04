import { loadDatabaseConfig } from "@studio-parallel/config";
import { JobHandlerFailure, type QueueJobEnvelope } from "@studio-parallel/domain";
import { createJsonLogger, type JsonLogEvent } from "@studio-parallel/observability";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { enqueueBackgroundJob } from "../../src/background-jobs.js";
import { createDatabaseClient, type DatabaseClient } from "../../src/client.js";
import {
  claimBackgroundJob,
  heartbeatBackgroundJob,
  InjectedJobCrash,
  recoverExpiredBackgroundJobLease,
  runIdempotentJobHandler,
  type JobDatabaseExecutor,
  type JobHandlerExecutionContext,
  type TransactionalJobResult,
} from "../../src/job-execution.js";
import { createWorkspaceContext } from "../../src/workspace-context.js";

const databaseConfig = loadDatabaseConfig();
const developmentWorkspaceId = "01900000-0000-7000-8000-000000000001";
const workspaceContext = createWorkspaceContext(developmentWorkspaceId);
const correlationId = "01990000-0000-7000-8000-000000000110";

let database: DatabaseClient;
let logEvents: JsonLogEvent[];

beforeAll(() => {
  database = createDatabaseClient(databaseConfig.DATABASE_URL);
});

beforeEach(async () => {
  logEvents = [];
  await database.jobAttempt.deleteMany();
  await database.jobOutbox.deleteMany();
  await database.backgroundJob.deleteMany();
  await database.systemSetting.deleteMany({
    where: { key: { startsWith: "job.result." }, workspaceId: developmentWorkspaceId },
  });
});

afterAll(async () => {
  await database.jobAttempt.deleteMany();
  await database.jobOutbox.deleteMany();
  await database.backgroundJob.deleteMany();
  await database.systemSetting.deleteMany({
    where: { key: { startsWith: "job.result." }, workspaceId: developmentWorkspaceId },
  });
  await database.$disconnect();
});

describe("logical job claims and leases", () => {
  it("allows exactly one concurrent optimistic claim and creates one attempt", async () => {
    const envelope = await enqueue("concurrent-claim");
    const now = new Date();
    const claims = await Promise.all(
      Array.from({ length: 10 }, () =>
        claimBackgroundJob(database, workspaceContext, envelope.domainJobId, {
          leaseDurationMs: 10_000,
          now,
        }),
      ),
    );

    expect(claims.filter(({ claimed }) => claimed)).toHaveLength(1);
    expect(claims.filter(({ claimed }) => !claimed)).toHaveLength(9);
    await expect(database.jobAttempt.count()).resolves.toBe(1);
    await expect(
      database.backgroundJob.findUnique({ where: { id: envelope.domainJobId } }),
    ).resolves.toMatchObject({
      attemptCount: 1,
      heartbeatAt: now,
      state: "PROCESSING",
      version: 2,
    });
  });

  it("recovers an expired lease without stealing work whose heartbeat is healthy", async () => {
    const envelope = await enqueue("lease-recovery");
    const claimedAt = new Date();
    const claim = await claimBackgroundJob(database, workspaceContext, envelope.domainJobId, {
      leaseDurationMs: 1_000,
      now: claimedAt,
    });
    expect(claim.claimed).toBe(true);
    if (!claim.claimed) throw new Error("expected claim");

    await expect(
      recoverExpiredBackgroundJobLease(
        database,
        workspaceContext,
        envelope.domainJobId,
        new Date(claimedAt.getTime() + 500),
      ),
    ).resolves.toBe(false);
    await heartbeatBackgroundJob(database, workspaceContext, envelope.domainJobId, claim.leaseId, {
      at: new Date(claimedAt.getTime() + 500),
      leaseDurationMs: 1_000,
    });
    await expect(
      recoverExpiredBackgroundJobLease(
        database,
        workspaceContext,
        envelope.domainJobId,
        new Date(claimedAt.getTime() + 1_200),
      ),
    ).resolves.toBe(false);
    await expect(
      recoverExpiredBackgroundJobLease(
        database,
        workspaceContext,
        envelope.domainJobId,
        new Date(claimedAt.getTime() + 1_501),
      ),
    ).resolves.toBe(true);

    await expect(
      database.backgroundJob.findUnique({ where: { id: envelope.domainJobId } }),
    ).resolves.toMatchObject({
      lastErrorClass: "TRANSIENT",
      lastErrorCode: "JOB_LEASE_EXPIRED",
      leaseId: null,
      nextAction: "RETRY_AUTOMATIC",
      state: "QUEUED",
    });
    await expect(
      database.jobAttempt.findUnique({ where: { leaseId: claim.leaseId } }),
    ).resolves.toMatchObject({
      errorCode: "JOB_LEASE_EXPIRED",
      state: "LEASE_EXPIRED",
    });
  });

  it("moves an abandoned final attempt to attention instead of making an infinite call", async () => {
    const envelope = await enqueue("lease-exhausted", { maxAttempts: 1 });
    const claimedAt = new Date();
    const claim = await claimBackgroundJob(database, workspaceContext, envelope.domainJobId, {
      leaseDurationMs: 1_000,
      now: claimedAt,
    });
    expect(claim.claimed).toBe(true);

    await expect(
      recoverExpiredBackgroundJobLease(
        database,
        workspaceContext,
        envelope.domainJobId,
        new Date(claimedAt.getTime() + 1_001),
      ),
    ).resolves.toBe(true);
    await expect(
      database.backgroundJob.findUnique({ where: { id: envelope.domainJobId } }),
    ).resolves.toMatchObject({
      completedAt: expect.any(Date),
      nextAction: "CONTACT_SUPPORT",
      state: "FAILED_ATTENTION",
    });
  });
});

describe("idempotent handler framework", () => {
  it("records safe retry state, honours due time, then commits one result", async () => {
    const envelope = await enqueue("transient-then-success");
    let clock = new Date(Date.now() + 1_000);

    await expect(
      run(envelope, {
        execute: async () => {
          throw new JobHandlerFailure({
            errorClass: "TRANSIENT",
            errorCode: "PROVIDER_TIMEOUT",
          });
        },
        now: () => clock,
        random: () => 0.5,
      }),
    ).resolves.toEqual({
      nextAttemptAt: new Date(clock.getTime() + 15_000),
      outcome: "RETRY_SCHEDULED",
    });
    await expect(
      database.backgroundJob.findUnique({ where: { id: envelope.domainJobId } }),
    ).resolves.toMatchObject({
      lastErrorClass: "TRANSIENT",
      lastErrorCode: "PROVIDER_TIMEOUT",
      nextAction: "RETRY_AUTOMATIC",
      state: "RETRY_SCHEDULED",
    });
    await expect(
      run(envelope, { execute: successHandler(envelope), now: () => clock }),
    ).resolves.toEqual({ outcome: "IGNORED", reason: "NOT_DUE" });

    clock = new Date(clock.getTime() + 15_000);
    await expect(
      run(envelope, { execute: successHandler(envelope), now: () => clock }),
    ).resolves.toEqual({ outcome: "SUCCEEDED" });
    await expect(resultCount(envelope)).resolves.toBe(1);
    await expect(
      database.jobAttempt.findMany({ where: { backgroundJobId: envelope.domainJobId } }),
    ).resolves.toEqual([
      expect.objectContaining({ attemptNumber: 1, state: "RETRY_SCHEDULED" }),
      expect.objectContaining({ attemptNumber: 2, state: "SUCCEEDED" }),
    ]);
  });

  it("returns success after a post-commit crash without running or duplicating the result", async () => {
    const envelope = await enqueue("after-commit-crash");
    const execute = vi.fn(successHandler(envelope));
    const releaseConcurrency = vi.fn();
    const acquireConcurrency = vi.fn(async () => releaseConcurrency);

    await expect(
      run(envelope, {
        acquireConcurrency,
        crashInjector: (point) => {
          if (point === "AFTER_RESULT_COMMIT") throw new InjectedJobCrash();
        },
        execute,
      }),
    ).rejects.toMatchObject({ code: "INJECTED_JOB_CRASH" });
    expect(execute).toHaveBeenCalledTimes(1);
    await expect(resultCount(envelope)).resolves.toBe(1);

    await expect(run(envelope, { acquireConcurrency, execute })).resolves.toEqual({
      outcome: "ALREADY_SUCCEEDED",
    });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(acquireConcurrency).toHaveBeenCalledTimes(1);
    expect(releaseConcurrency).toHaveBeenCalledTimes(1);
    await expect(resultCount(envelope)).resolves.toBe(1);
  });

  it("leaves a pre-commit crash leased, recovers it, and later publishes one result", async () => {
    const envelope = await enqueue("before-commit-crash");
    const startedAt = new Date();

    await expect(
      run(envelope, {
        crashInjector: (point) => {
          if (point === "BEFORE_RESULT_COMMIT") throw new InjectedJobCrash();
        },
        execute: successHandler(envelope),
        leaseDurationMs: 1_000,
        now: () => startedAt,
      }),
    ).rejects.toMatchObject({ code: "INJECTED_JOB_CRASH" });
    await expect(resultCount(envelope)).resolves.toBe(0);
    await expect(
      recoverExpiredBackgroundJobLease(
        database,
        workspaceContext,
        envelope.domainJobId,
        new Date(startedAt.getTime() + 1_001),
      ),
    ).resolves.toBe(true);

    await expect(
      run(envelope, {
        execute: successHandler(envelope),
        now: () => new Date(startedAt.getTime() + 1_002),
      }),
    ).resolves.toEqual({ outcome: "SUCCEEDED" });
    await expect(resultCount(envelope)).resolves.toBe(1);
  });

  it("stores and logs only safe taxonomy when a handler throws secret-shaped detail", async () => {
    const envelope = await enqueue("redacted-failure");

    await expect(
      run(envelope, {
        execute: async () => {
          throw new Error("Bearer provider-secret token=raw-secret");
        },
      }),
    ).resolves.toEqual({ nextAction: "CONTACT_SUPPORT", outcome: "FAILED_ATTENTION" });
    await expect(
      database.backgroundJob.findUnique({ where: { id: envelope.domainJobId } }),
    ).resolves.toMatchObject({
      lastErrorClass: "UNKNOWN",
      lastErrorCode: "JOB_HANDLER_FAILED",
      nextAction: "CONTACT_SUPPORT",
    });
    expect(JSON.stringify(logEvents)).not.toMatch(/provider-secret|raw-secret|Bearer/iu);
    expect(logEvents).toContainEqual(
      expect.objectContaining({
        errorClass: "UNKNOWN",
        errorCode: "JOB_HANDLER_FAILED",
        event: "job.failed_attention",
        nextAction: "CONTACT_SUPPORT",
      }),
    );
  });

  it("records handler stages and rejects a cross-workspace delivery before claiming", async () => {
    const envelope = await enqueue("stage-and-scope");
    const execute = async (context: JobHandlerExecutionContext) => {
      await context.recordStage("loading_inputs");
      await context.heartbeat();
      return successHandler(envelope)(context);
    };

    await expect(run(envelope, { execute })).resolves.toEqual({ outcome: "SUCCEEDED" });
    expect(logEvents).toContainEqual(
      expect.objectContaining({ event: "job.stage_recorded", stage: "loading_inputs" }),
    );

    const secondWorkspace = await database.workspace.create({
      data: {
        id: "01990000-0000-7000-8000-000000000199",
        name: "Job Isolation Workspace",
        slug: "job-isolation",
      },
    });
    await expect(
      runIdempotentJobHandler({
        context: createWorkspaceContext(secondWorkspace.id),
        database,
        envelope,
        execute,
        logger: createLogger(),
        resultExists: (executor) => hasResult(executor, envelope),
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: "JOB_DELIVERY_NOT_FOUND" });
    await database.workspace.delete({ where: { id: secondWorkspace.id } });
  });

  it("rejects an idempotency key reused for different work", async () => {
    await enqueue("metadata-conflict", { maxAttempts: 3, priority: 10 });

    // Priority describes the work, so two priorities under one key means the
    // key is standing for two different things.
    await expect(
      enqueue("metadata-conflict", { maxAttempts: 3, priority: 20 }),
    ).rejects.toMatchObject({
      code: "JOB_IDEMPOTENCY_CONFLICT",
    });
    await expect(database.backgroundJob.count()).resolves.toBe(1);
  });

  it("accepts the same work under a key whose job has a different retry budget", async () => {
    // `maxAttempts` is a budget, not an input. An operator retry raises it, so
    // comparing it made every retried job conflict with the default its own
    // scheduler enqueues with — and a key anchored on something stable then
    // conflicted on every sweep, stranding the account permanently.
    const first = await enqueue("budget-difference", { maxAttempts: 3, priority: 10 });

    const again = await enqueue("budget-difference", { maxAttempts: 9, priority: 10 });

    expect(again.domainJobId).toBe(first.domainJobId);
    await expect(database.backgroundJob.count()).resolves.toBe(1);
  });
});

async function enqueue(
  idempotencyKey: string,
  options: Readonly<{ maxAttempts?: number; priority?: number }> = {},
): Promise<QueueJobEnvelope> {
  const { job } = await enqueueBackgroundJob(database, workspaceContext, {
    correlationId,
    handlerVersion: 1,
    idempotencyKey,
    queueName: "analysis.run",
    ...(options.maxAttempts === undefined ? {} : { maxAttempts: options.maxAttempts }),
    ...(options.priority === undefined ? {} : { priority: options.priority }),
  });

  return {
    correlationId: job.correlationId,
    domainJobId: job.id,
    handlerVersion: job.handlerVersion,
    queueName: "analysis.run",
    workspaceId: job.workspaceId,
  };
}

function run(
  envelope: QueueJobEnvelope,
  options: Readonly<{
    acquireConcurrency?: (signal: AbortSignal) => Promise<() => void>;
    crashInjector?: (
      point: "AFTER_HANDLER" | "AFTER_RESULT_COMMIT" | "BEFORE_RESULT_COMMIT",
    ) => void;
    execute: (context: JobHandlerExecutionContext) => Promise<TransactionalJobResult>;
    leaseDurationMs?: number;
    now?: () => Date;
    random?: () => number;
  }>,
) {
  return runIdempotentJobHandler({
    context: workspaceContext,
    database,
    envelope,
    execute: options.execute,
    logger: createLogger(),
    resultExists: (executor) => hasResult(executor, envelope),
    signal: new AbortController().signal,
    ...(options.acquireConcurrency ? { acquireConcurrency: options.acquireConcurrency } : {}),
    ...(options.crashInjector ? { crashInjector: options.crashInjector } : {}),
    ...(options.leaseDurationMs ? { leaseDurationMs: options.leaseDurationMs } : {}),
    ...(options.now ? { now: options.now } : {}),
    ...(options.random ? { random: options.random } : {}),
  });
}

function successHandler(
  envelope: QueueJobEnvelope,
): (context: JobHandlerExecutionContext) => Promise<TransactionalJobResult> {
  return async () => ({
    commit: async (transaction) => {
      await transaction.systemSetting.create({
        data: {
          changeReason: "Idempotent job result integration proof",
          changedByService: "job-integration-test",
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
  });
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

function createLogger() {
  return createJsonLogger({
    environment: "test",
    now: () => new Date("2026-07-28T05:00:00.000Z"),
    release: "integration-test",
    service: "worker",
    sink: (event) => logEvents.push(event),
  });
}
