import { loadDatabaseConfig } from "@studio-parallel/config";
import type { QueueJobEnvelope, QueuePublisher } from "@studio-parallel/domain";
import {
  createErrorMonitor,
  createJsonLogger,
  type JsonLogEvent,
} from "@studio-parallel/observability";
import { createPgBossQueueClient, type QueueClient } from "@studio-parallel/queue";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  createDatabaseClient,
  createId,
  createWorkspaceContext,
  enqueueBackgroundJob,
  enqueueBackgroundJobInTransaction,
  reconcileJobOutbox,
  type DatabaseClient,
} from "@studio-parallel/db";

const databaseConfig = loadDatabaseConfig();
const developmentWorkspaceId = "01900000-0000-7000-8000-000000000001";
const workspaceContext = createWorkspaceContext(developmentWorkspaceId);
const analysisQueue = { name: "analysis.run", version: 1 } as const;
const correlationId = "01990000-0000-7000-8000-000000000010";

let database: DatabaseClient;
let queue: QueueClient;
let logEvents: JsonLogEvent[];

beforeAll(async () => {
  database = createDatabaseClient(databaseConfig.DATABASE_URL);
  queue = createPgBossQueueClient({ connectionString: databaseConfig.DATABASE_URL });
  await queue.start();
  await queue.verifyQueues();
});

beforeEach(async () => {
  logEvents = [];
  await database.jobAttempt.deleteMany();
  await database.jobOutbox.deleteMany();
  await database.backgroundJob.deleteMany();
});

afterAll(async () => {
  await queue.stop();
  await database.jobAttempt.deleteMany();
  await database.jobOutbox.deleteMany();
  await database.backgroundJob.deleteMany();
  await database.$disconnect();
});

describe("transactional background job dispatch", () => {
  it("commits domain work and its outbox together, and rolls both back together", async () => {
    await expect(
      database.$transaction(async (transaction) => {
        await transaction.systemSetting.create({
          data: {
            changeReason: "Atomic background job integration proof",
            changedByService: "integration-test",
            effectiveAt: new Date("2026-07-28T03:30:00.000Z"),
            id: createId(),
            key: "jobs.atomic-proof",
            value: { enabled: true },
            valueType: "JSON",
            version: 1,
            workspaceId: developmentWorkspaceId,
          },
        });
        await enqueueBackgroundJobInTransaction(transaction, workspaceContext, {
          correlationId,
          handlerVersion: 1,
          idempotencyKey: "atomic-rollback",
          queueName: "analysis.run",
        });
        throw new Error("inject transaction rollback");
      }),
    ).rejects.toThrow("inject transaction rollback");

    await expect(
      database.systemSetting.findFirst({
        where: { key: "jobs.atomic-proof", workspaceId: developmentWorkspaceId },
      }),
    ).resolves.toBeNull();
    await expect(database.backgroundJob.count()).resolves.toBe(0);
    await expect(database.jobOutbox.count()).resolves.toBe(0);
  });

  it("deduplicates concurrent command transactions into one logical job and outbox", async () => {
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        enqueueBackgroundJob(database, workspaceContext, {
          correlationId,
          handlerVersion: 1,
          idempotencyKey: "concurrent-analysis",
          queueName: "analysis.run",
        }),
      ),
    );

    expect(new Set(results.map(({ job }) => job.id)).size).toBe(1);
    expect(results.filter(({ created }) => created)).toHaveLength(1);
    await expect(database.backgroundJob.count()).resolves.toBe(1);
    await expect(database.jobOutbox.count()).resolves.toBe(1);
  });

  it("recovers a crash between commit and dispatch, with one queue delivery", async () => {
    const { job } = await enqueueBackgroundJob(database, workspaceContext, {
      correlationId,
      handlerVersion: 1,
      idempotencyKey: "commit-before-dispatch-crash",
      queueName: "analysis.run",
    });

    await expect(queue.findDelivery(analysisQueue, job.id)).resolves.toBeUndefined();
    const result = await reconcileJobOutbox(database, queue, createTelemetry());

    expect(result).toEqual({ claimed: 1, dispatched: 1, failed: 0 });
    await expect(queue.findDelivery(analysisQueue, job.id)).resolves.toMatchObject({ id: job.id });
    await expect(
      database.jobOutbox.findUnique({ where: { backgroundJobId: job.id } }),
    ).resolves.toMatchObject({
      dispatchAttemptCount: 1,
      dispatchedAt: expect.any(Date),
      queueDeliveryId: job.id,
    });
  });

  it("deduplicates a replay after publish succeeds but before the outbox is marked", async () => {
    const { job } = await enqueueBackgroundJob(database, workspaceContext, {
      correlationId,
      handlerVersion: 1,
      idempotencyKey: "publish-before-mark-crash",
      queueName: "analysis.run",
    });
    const envelope = toEnvelope(job);

    await expect(queue.publish(envelope)).resolves.toEqual({
      created: true,
      deliveryId: job.id,
    });
    await expect(reconcileJobOutbox(database, queue, createTelemetry())).resolves.toEqual({
      claimed: 1,
      dispatched: 1,
      failed: 0,
    });

    expect(logEvents).toContainEqual(
      expect.objectContaining({ event: "job.dispatch_deduplicated", jobId: job.id }),
    );
    await expect(queue.findDelivery(analysisQueue, job.id)).resolves.toMatchObject({ id: job.id });
  });

  it("allows only one concurrent dispatcher to claim a pending outbox record", async () => {
    const { job } = await enqueueBackgroundJob(database, workspaceContext, {
      correlationId,
      handlerVersion: 1,
      idempotencyKey: "concurrent-dispatch",
      queueName: "analysis.run",
    });

    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        reconcileJobOutbox(database, queue, createTelemetry(), {
          now: new Date("2026-07-28T04:00:00.000Z"),
        }),
      ),
    );

    expect(results.reduce((sum, result) => sum + result.claimed, 0)).toBe(1);
    await expect(queue.findDelivery(analysisQueue, job.id)).resolves.toMatchObject({ id: job.id });
  });

  it("reconciles failed and expired dispatches with only secret-safe diagnostics", async () => {
    const { job } = await enqueueBackgroundJob(database, workspaceContext, {
      correlationId,
      handlerVersion: 1,
      idempotencyKey: "failed-dispatch",
      queueName: "analysis.run",
    });
    const unsafePublisher: QueuePublisher = {
      publish: async () => {
        throw new Error("postgresql://queue-user:super-secret@database/token=raw-secret");
      },
    };
    const failedAt = new Date("2026-07-28T04:10:00.000Z");

    await expect(
      reconcileJobOutbox(database, unsafePublisher, createTelemetry(), {
        failureDelayMs: 1_000,
        now: failedAt,
      }),
    ).resolves.toEqual({ claimed: 1, dispatched: 0, failed: 1 });
    await expect(
      database.jobOutbox.findUnique({ where: { backgroundJobId: job.id } }),
    ).resolves.toMatchObject({
      dispatchedAt: null,
      lastErrorCode: "QUEUE_PUBLISH_FAILED",
      leaseExpiresAt: null,
      leaseId: null,
      nextAttemptAt: new Date("2026-07-28T04:10:01.000Z"),
    });
    expect(JSON.stringify(logEvents)).not.toMatch(/super-secret|raw-secret|queue-user/iu);

    await database.jobOutbox.update({
      data: {
        leaseExpiresAt: new Date("2026-07-28T04:09:59.000Z"),
        leaseId: createId(),
        nextAttemptAt: failedAt,
      },
      where: { backgroundJobId: job.id },
    });
    await expect(
      reconcileJobOutbox(database, queue, createTelemetry(), {
        now: failedAt,
      }),
    ).resolves.toEqual({ claimed: 1, dispatched: 1, failed: 0 });
  });
});

function createTelemetry() {
  return {
    logger: createJsonLogger({
      environment: "test",
      now: () => new Date("2026-07-28T04:00:00.000Z"),
      release: "integration-test",
      service: "worker",
      sink: (event) => logEvents.push(event),
    }),
    monitor: createErrorMonitor({
      environment: "test",
      release: "integration-test",
      service: "worker",
    }),
  };
}

function toEnvelope(job: {
  correlationId: string;
  handlerVersion: number;
  id: string;
  queueName: string;
  workspaceId: string;
}): QueueJobEnvelope {
  return {
    correlationId: job.correlationId,
    domainJobId: job.id,
    handlerVersion: job.handlerVersion,
    queueName: "analysis.run",
    workspaceId: job.workspaceId,
  };
}
