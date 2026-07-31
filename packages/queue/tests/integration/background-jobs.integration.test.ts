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

  it("deduplicates concurrent callers that own their transactions", async () => {
    // The caller-owned path cannot recover by retrying, because a unique
    // violation would abort the transaction the caller is still using. The
    // conflict therefore has to be avoided rather than caught.
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        database.$transaction((transaction) =>
          enqueueBackgroundJobInTransaction(transaction, workspaceContext, {
            correlationId,
            handlerVersion: 1,
            idempotencyKey: "concurrent-owned-transaction",
            queueName: "analysis.run",
          }),
        ),
      ),
    );

    expect(new Set(results.map(({ job }) => job.id)).size).toBe(1);
    expect(results.filter(({ created }) => created)).toHaveLength(1);
    await expect(database.backgroundJob.count()).resolves.toBe(1);
    await expect(database.jobOutbox.count()).resolves.toBe(1);
  });

  it("still rejects a reused idempotency key with different inputs", async () => {
    const first = await enqueueBackgroundJob(database, workspaceContext, {
      correlationId,
      handlerVersion: 1,
      idempotencyKey: "conflicting-inputs",
      queueName: "analysis.run",
    });
    expect(first.created).toBe(true);

    await expect(
      enqueueBackgroundJob(database, workspaceContext, {
        correlationId,
        handlerVersion: 1,
        idempotencyKey: "conflicting-inputs",
        priority: 5,
        queueName: "analysis.run",
      }),
    ).rejects.toThrowError(expect.objectContaining({ code: "JOB_IDEMPOTENCY_CONFLICT" }));
  });

  it("recovers a crash between commit and dispatch, with one queue delivery", async () => {
    const { job } = await enqueueBackgroundJob(database, workspaceContext, {
      correlationId,
      handlerVersion: 1,
      idempotencyKey: "commit-before-dispatch-crash",
      queueName: "analysis.run",
    });

    const result = await reconcileJobOutbox(database, queue, createTelemetry());

    expect(result).toEqual({ claimed: 1, dispatched: 1, failed: 0 });
    const outbox = await database.jobOutbox.findUnique({ where: { backgroundJobId: job.id } });
    expect(outbox).toMatchObject({
      dispatchAttemptCount: 1,
      dispatchedAt: expect.any(Date),
      queueDeliveryId: expect.any(String),
    });
    // The delivery id is the queue's, not the domain job's, so it is read back
    // from the outbox rather than assumed to equal the job id.
    await expect(
      queue.findDelivery(analysisQueue, outbox?.queueDeliveryId ?? ""),
    ).resolves.toMatchObject({ id: outbox?.queueDeliveryId });
  });

  it("deduplicates a replay after publish succeeds but before the outbox is marked", async () => {
    const { job } = await enqueueBackgroundJob(database, workspaceContext, {
      correlationId,
      handlerVersion: 1,
      idempotencyKey: "publish-before-mark-crash",
      queueName: "analysis.run",
    });
    const envelope = toEnvelope(job);

    const published = await queue.publish(envelope);
    expect(published).toMatchObject({ created: true, deliveryId: expect.any(String) });

    await expect(reconcileJobOutbox(database, queue, createTelemetry())).resolves.toEqual({
      claimed: 1,
      dispatched: 1,
      failed: 0,
    });

    // The singleton key still collapses the replay onto the in-flight delivery.
    expect(logEvents).toContainEqual(
      expect.objectContaining({ event: "job.dispatch_deduplicated", jobId: job.id }),
    );
    await expect(queue.findDelivery(analysisQueue, published.deliveryId)).resolves.toMatchObject({
      id: published.deliveryId,
    });
  });

  it("delivers a job again after its previous delivery completed", async () => {
    const { job } = await enqueueBackgroundJob(database, workspaceContext, {
      correlationId,
      handlerVersion: 1,
      idempotencyKey: "redelivery-after-completion",
      queueName: "analysis.run",
    });
    const envelope = toEnvelope(job);

    const first = await queue.publish(envelope);
    expect(first.created).toBe(true);

    // Finish the delivery the way a worker would. The completed row is retained
    // for the deletion window, which is exactly the condition that used to make
    // every retry impossible: the publish collided with the job's own corpse.
    await database.$executeRaw`
      UPDATE pgboss.job SET state = 'completed', completed_on = now()
      WHERE name = ${"analysis.run.v1"} AND id = ${first.deliveryId}::uuid`;

    const second = await queue.publish(envelope);

    expect(second.created).toBe(true);
    expect(second.deliveryId).not.toBe(first.deliveryId);
    await expect(queue.findDelivery(analysisQueue, second.deliveryId)).resolves.toMatchObject({
      id: second.deliveryId,
    });
  });

  it("still collapses a second publish while a delivery is in flight", async () => {
    const { job } = await enqueueBackgroundJob(database, workspaceContext, {
      correlationId,
      handlerVersion: 1,
      idempotencyKey: "redelivery-while-in-flight",
      queueName: "analysis.run",
    });
    const envelope = toEnvelope(job);

    const first = await queue.publish(envelope);
    expect(first.created).toBe(true);

    // Nothing completed the first delivery, so the exclusive singleton index
    // must still refuse a second one.
    await expect(queue.publish(envelope)).resolves.toMatchObject({ created: false });
  });

  it("keeps the domain job id as the idempotency identity, not the delivery id", async () => {
    const { job } = await enqueueBackgroundJob(database, workspaceContext, {
      correlationId,
      handlerVersion: 1,
      idempotencyKey: "redelivery-domain-identity",
      queueName: "analysis.run",
    });

    const published = await queue.publish(toEnvelope(job));
    const [delivered] = await database.$queryRaw<Array<{ data: { domainJobId: string } }>>`
      SELECT data FROM pgboss.job
      WHERE name = ${"analysis.run.v1"} AND id = ${published.deliveryId}::uuid`;

    // Transport addressing changed; the envelope the handler reads did not.
    expect(published.deliveryId).not.toBe(job.id);
    expect(delivered?.data.domainJobId).toBe(job.id);
  });

  it("allows only one concurrent dispatcher to claim a pending outbox record", async () => {
    const { job } = await enqueueBackgroundJob(database, workspaceContext, {
      correlationId,
      handlerVersion: 1,
      idempotencyKey: "concurrent-dispatch",
      queueName: "analysis.run",
    });
    const pending = await database.jobOutbox.findUniqueOrThrow({
      where: { backgroundJobId: job.id },
    });

    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        reconcileJobOutbox(database, queue, createTelemetry(), {
          now: new Date(pending.nextAttemptAt.getTime() + 1),
        }),
      ),
    );

    expect(results.reduce((sum, result) => sum + result.claimed, 0)).toBe(1);
    const dispatched = await database.jobOutbox.findUniqueOrThrow({
      where: { backgroundJobId: job.id },
    });
    await expect(
      queue.findDelivery(analysisQueue, dispatched.queueDeliveryId ?? ""),
    ).resolves.toMatchObject({ id: dispatched.queueDeliveryId });
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
    const pending = await database.jobOutbox.findUniqueOrThrow({
      where: { backgroundJobId: job.id },
    });
    const failedAt = new Date(pending.nextAttemptAt.getTime() + 1);

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
      nextAttemptAt: new Date(failedAt.getTime() + 1_000),
    });
    expect(JSON.stringify(logEvents)).not.toMatch(/super-secret|raw-secret|queue-user/iu);

    await database.jobOutbox.update({
      data: {
        leaseExpiresAt: new Date(failedAt.getTime() - 1),
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
