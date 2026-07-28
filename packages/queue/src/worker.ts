import {
  queueVersionKey,
  type QueueHandlerRegistration,
  type QueueJobEnvelope,
  type QueuePublishResult,
  type VersionedQueue,
} from "@studio-parallel/domain";
import { OperationalError } from "@studio-parallel/observability";

import { queueError, type QueueStopOptions, type WorkerQueueClient } from "./queue.js";

export type QueueHandlerRegistry = Readonly<{
  registrations: readonly QueueHandlerRegistration[];
  supports(queue: VersionedQueue): boolean;
}>;

export type QueueWorkerRuntime = Readonly<{
  start(): Promise<void>;
  stop(options?: QueueStopOptions): Promise<void>;
}>;

export function createQueueHandlerRegistry(
  registrations: readonly QueueHandlerRegistration[],
): QueueHandlerRegistry {
  const byKey = new Map<string, QueueHandlerRegistration>();

  for (const registration of registrations) {
    const key = queueVersionKey(registration.queue);
    if (byKey.has(key)) {
      throw queueError("QUEUE_HANDLER_DUPLICATE", false, "validation", 400);
    }
    byKey.set(key, registration);
  }

  return Object.freeze({
    registrations: Object.freeze([...byKey.values()]),
    supports: (queue: VersionedQueue) => byKey.has(queueVersionKey(queue)),
  });
}

export function createQueueWorkerRuntime(options: {
  client: WorkerQueueClient;
  registry: QueueHandlerRegistry;
  requiredQueues?: readonly VersionedQueue[];
}): QueueWorkerRuntime {
  let started = false;

  return Object.freeze({
    async start() {
      assertWorkerCompatibility(options.registry, options.requiredQueues ?? []);
      await options.client.start();

      try {
        await options.client.verifyQueues(options.registry.registrations.map(({ queue }) => queue));
        for (const registration of options.registry.registrations) {
          await options.client.work(registration);
        }
        started = true;
      } catch (error) {
        await options.client.stop({ graceful: true }).catch(() => undefined);
        throw error;
      }
    },
    async stop(stopOptions) {
      if (!started) return;
      await options.client.stop(stopOptions);
      started = false;
    },
  });
}

export function assertWorkerCompatibility(
  registry: QueueHandlerRegistry,
  requiredQueues: readonly VersionedQueue[],
): void {
  if (requiredQueues.some((queue) => !registry.supports(queue))) {
    throw queueError("QUEUE_HANDLER_VERSION_UNSUPPORTED", false);
  }
}

export function createInProcessQueue(): WorkerQueueClient &
  Readonly<{
    deliveryCount(): number;
    whenIdle(): Promise<void>;
  }> {
  const deliveries = new Map<string, { envelope: QueueJobEnvelope; processed: boolean }>();
  const handlers = new Map<string, QueueHandlerRegistration>();
  const active = new Set<Promise<void>>();
  let accepting = false;

  const drain = (): void => {
    if (!accepting) return;

    for (const delivery of deliveries.values()) {
      if (delivery.processed) continue;
      const registration = handlers.get(envelopeQueueKey(delivery.envelope));
      if (!registration) continue;

      delivery.processed = true;
      const operation = registration.handler(delivery.envelope, {
        attempt: 1,
        signal: new AbortController().signal,
      });
      active.add(operation);
      void operation.then(
        () => active.delete(operation),
        () => active.delete(operation),
      );
    }
  };

  return Object.freeze({
    deliveryCount: () => deliveries.size,
    async findDelivery(_queue, deliveryId) {
      const delivery = deliveries.get(deliveryId);
      return delivery
        ? Object.freeze({ id: deliveryId, state: delivery.processed ? "completed" : "created" })
        : undefined;
    },
    async publish(envelope): Promise<QueuePublishResult> {
      if (!accepting) throw queueError("QUEUE_NOT_STARTED", true);
      const existing = deliveries.get(envelope.domainJobId);
      if (!existing) deliveries.set(envelope.domainJobId, { envelope, processed: false });
      drain();
      return Object.freeze({
        created: !existing,
        deliveryId: envelope.domainJobId,
      });
    },
    async start() {
      accepting = true;
      drain();
    },
    async stop() {
      accepting = false;
      await Promise.allSettled([...active]);
    },
    async verifyQueues() {},
    async whenIdle() {
      await Promise.allSettled([...active]);
    },
    async work(registration) {
      const key = queueVersionKey(registration.queue);
      if (handlers.has(key)) {
        throw new OperationalError({
          code: "QUEUE_HANDLER_DUPLICATE",
          errorClass: "validation",
          statusCode: 400,
        });
      }
      handlers.set(key, registration);
      drain();
      return key;
    },
  });
}

function envelopeQueueKey(envelope: QueueJobEnvelope): string {
  return queueVersionKey({ name: envelope.queueName, version: envelope.handlerVersion });
}

export { createPgBossWorkerQueue, type WorkerQueueClient } from "./queue.js";
