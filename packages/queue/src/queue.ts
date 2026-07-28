import {
  parseQueueJobEnvelope,
  queueDefinitions,
  queueVersionKey,
  type QueueHandler,
  type QueueHandlerRegistration,
  type QueueJobEnvelope,
  type QueuePublisher,
  type QueuePublishResult,
  type VersionedQueue,
} from "@studio-parallel/domain";
import { OperationalError } from "@studio-parallel/observability";
import { PgBoss, type Job } from "pg-boss";

export type QueueStopOptions = Readonly<{
  graceful?: boolean;
  timeoutMs?: number;
}>;

export type QueueSchemaStatus = Readonly<{
  driftFree: boolean;
  version: number;
}>;

export type QueueDeliveryStatus = Readonly<{
  id: string;
  state: "active" | "cancelled" | "completed" | "created" | "failed" | "retry";
}>;

export type QueueClient = QueuePublisher &
  Readonly<{
    start(): Promise<void>;
    stop(options?: QueueStopOptions): Promise<void>;
    findDelivery(
      queue: VersionedQueue,
      deliveryId: string,
    ): Promise<QueueDeliveryStatus | undefined>;
    verifyQueues(definitions?: readonly VersionedQueue[]): Promise<void>;
  }>;

export type WorkerQueueClient = QueueClient &
  Readonly<{
    work(registration: QueueHandlerRegistration): Promise<string>;
  }>;

type PgBossQueueOptions = Readonly<{
  connectionString: string;
  migrate?: boolean;
  onError?: (error: OperationalError) => void;
}>;

const queuePolicy = Object.freeze({
  deleteAfterSeconds: 1_209_600,
  expireInSeconds: 900,
  heartbeatSeconds: 60,
  policy: "exclusive" as const,
  retentionSeconds: 1_209_600,
  retryLimit: 0,
});

export function createPgBossQueueClient(options: PgBossQueueOptions): QueueClient {
  return new PgBossQueue(options);
}

export function createPgBossWorkerQueue(options: PgBossQueueOptions): WorkerQueueClient {
  return new PgBossQueue(options);
}

export async function migrateQueueSchema(
  connectionString: string,
  definitions: readonly VersionedQueue[] = queueDefinitions,
): Promise<QueueSchemaStatus> {
  const queue = new PgBossQueue({ connectionString, migrate: true });

  try {
    await queue.start();
    await queue.provisionQueues(definitions);
    const version = await queue.schemaVersion();
    const driftFree = await queue.isDriftFree();

    if (version === null || !driftFree) {
      throw queueError("QUEUE_SCHEMA_INCOMPATIBLE", false);
    }

    return Object.freeze({ driftFree, version });
  } catch (error) {
    if (error instanceof OperationalError) throw error;
    throw queueError("QUEUE_MIGRATION_FAILED", true);
  } finally {
    await queue.stop().catch(() => undefined);
  }
}

class PgBossQueue implements WorkerQueueClient {
  readonly #boss: PgBoss;
  #started = false;

  constructor(options: PgBossQueueOptions) {
    this.#boss = new PgBoss({
      connectionString: options.connectionString,
      createSchema: options.migrate === true,
      migrate: options.migrate === true,
      schedule: false,
      supervise: true,
      useListenNotify: false,
    });
    this.#boss.on("error", () => {
      options.onError?.(queueError("QUEUE_RUNTIME_FAILED", true));
    });
  }

  async start(): Promise<void> {
    try {
      await this.#boss.start();
      this.#started = true;
    } catch {
      await this.#boss
        .stop({ close: true, graceful: false, timeout: 1_000 })
        .catch(() => undefined);
      throw queueError("QUEUE_START_FAILED", true);
    }
  }

  async stop(options: QueueStopOptions = {}): Promise<void> {
    if (!this.#started) return;

    try {
      await this.#boss.stop({
        close: true,
        graceful: options.graceful ?? true,
        timeout: options.timeoutMs ?? 30_000,
      });
      this.#started = false;
    } catch {
      throw queueError("QUEUE_STOP_FAILED", true);
    }
  }

  async publish(envelope: QueueJobEnvelope): Promise<QueuePublishResult> {
    if (!this.#started) throw queueError("QUEUE_NOT_STARTED", true);

    const parsed = parseQueueJobEnvelope(envelope);
    const supported = parsed
      ? queueDefinitions.some(
          ({ name, version }) => name === parsed.queueName && version === parsed.handlerVersion,
        )
      : false;

    if (!parsed || !supported) {
      throw queueError("QUEUE_ENVELOPE_INVALID", false, "validation", 400);
    }

    try {
      const deliveryId = await this.#boss.send(envelopeQueueKey(parsed), parsed, {
        id: parsed.domainJobId,
        singletonKey: parsed.domainJobId,
      });

      return Object.freeze({
        created: deliveryId !== null,
        deliveryId: deliveryId ?? parsed.domainJobId,
      });
    } catch {
      throw queueError("QUEUE_PUBLISH_FAILED", true);
    }
  }

  async findDelivery(
    queue: VersionedQueue,
    deliveryId: string,
  ): Promise<QueueDeliveryStatus | undefined> {
    if (!this.#started) throw queueError("QUEUE_NOT_STARTED", true);

    try {
      const jobs = await this.#boss.findJobs(queueVersionKey(queue), { id: deliveryId });
      const job = jobs[0];
      return job ? Object.freeze({ id: job.id, state: job.state }) : undefined;
    } catch {
      throw queueError("QUEUE_INSPECTION_FAILED", true);
    }
  }

  async verifyQueues(definitions: readonly VersionedQueue[] = queueDefinitions): Promise<void> {
    if (!this.#started) throw queueError("QUEUE_NOT_STARTED", true);

    try {
      for (const definition of definitions) {
        const queue = await this.#boss.getQueue(queueVersionKey(definition));

        if (
          !queue ||
          queue.policy !== queuePolicy.policy ||
          queue.expireInSeconds !== queuePolicy.expireInSeconds ||
          queue.heartbeatSeconds !== queuePolicy.heartbeatSeconds ||
          queue.deleteAfterSeconds !== queuePolicy.deleteAfterSeconds ||
          queue.retentionSeconds !== queuePolicy.retentionSeconds ||
          queue.retryLimit !== queuePolicy.retryLimit
        ) {
          throw queueError("QUEUE_DEFINITION_INCOMPATIBLE", false);
        }
      }
    } catch (error) {
      if (error instanceof OperationalError) throw error;
      throw queueError("QUEUE_COMPATIBILITY_CHECK_FAILED", true);
    }
  }

  async work(registration: QueueHandlerRegistration): Promise<string> {
    if (!this.#started) throw queueError("QUEUE_NOT_STARTED", true);

    try {
      return await this.#boss.work<QueueJobEnvelope>(
        queueVersionKey(registration.queue),
        { batchSize: 1, includeMetadata: true, localConcurrency: 1 },
        async (jobs) => {
          const job = jobs[0];
          if (!job) return;
          await executeHandler(registration, job);
        },
      );
    } catch {
      throw queueError("QUEUE_WORKER_REGISTRATION_FAILED", true);
    }
  }

  async provisionQueues(definitions: readonly VersionedQueue[]): Promise<void> {
    try {
      for (const definition of definitions) {
        const name = queueVersionKey(definition);
        const existing = await this.#boss.getQueue(name);

        if (existing) {
          if (existing.policy !== queuePolicy.policy) {
            throw queueError("QUEUE_DEFINITION_INCOMPATIBLE", false);
          }
          await this.#boss.updateQueue(name, queuePolicy);
        } else {
          await this.#boss.createQueue(name, queuePolicy);
        }
      }
    } catch (error) {
      if (error instanceof OperationalError) throw error;
      throw queueError("QUEUE_PROVISION_FAILED", true);
    }

    await this.verifyQueues(definitions);
  }

  schemaVersion(): Promise<number | null> {
    return this.#boss.schemaVersion();
  }

  async isDriftFree(): Promise<boolean> {
    const report = await this.#boss.detectSchemaDrift();
    return report.ok;
  }
}

async function executeHandler(
  registration: QueueHandlerRegistration,
  job: Job<QueueJobEnvelope>,
): Promise<void> {
  const envelope = parseQueueJobEnvelope(job.data);

  if (!envelope || envelopeQueueKey(envelope) !== queueVersionKey(registration.queue)) {
    throw queueError("QUEUE_DELIVERY_INVALID", false, "validation", 422);
  }

  await registration.handler(envelope, {
    attempt: 1,
    signal: job.signal,
  });
}

function envelopeQueueKey(envelope: QueueJobEnvelope): string {
  return queueVersionKey({ name: envelope.queueName, version: envelope.handlerVersion });
}

export function queueError(
  code: string,
  retryable: boolean,
  errorClass: "dependency" | "validation" = "dependency",
  statusCode = 503,
): OperationalError {
  return new OperationalError({ code, errorClass, retryable, statusCode });
}

export type { QueueHandler };
