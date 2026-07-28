import { describe, expect, it, vi } from "vitest";

import type { QueueJobEnvelope } from "@studio-parallel/domain";

import {
  assertWorkerCompatibility,
  createInProcessQueue,
  createQueueHandlerRegistry,
  createQueueWorkerRuntime,
} from "./worker.js";

const queue = { name: "analysis.run", version: 1 } as const;
const envelope: QueueJobEnvelope = {
  correlationId: "01990000-0000-7000-8000-000000000003",
  domainJobId: "01990000-0000-7000-8000-000000000002",
  handlerVersion: 1,
  queueName: "analysis.run",
  workspaceId: "01990000-0000-7000-8000-000000000001",
};

describe("queue worker runtime", () => {
  it("leases only registered handler versions and preserves the handler contract", async () => {
    const handler = vi.fn(async () => undefined);
    const registry = createQueueHandlerRegistry([{ handler, queue }]);
    const client = createInProcessQueue();
    const runtime = createQueueWorkerRuntime({ client, registry, requiredQueues: [queue] });

    await runtime.start();
    await expect(client.publish(envelope)).resolves.toEqual({
      created: true,
      deliveryId: envelope.domainJobId,
    });
    await client.whenIdle();

    expect(handler).toHaveBeenCalledWith(
      envelope,
      expect.objectContaining({ attempt: 1, signal: expect.any(AbortSignal) }),
    );
    await runtime.stop({ graceful: true, timeoutMs: 1_000 });
  });

  it("deduplicates repeat delivery by domain job ID", async () => {
    const client = createInProcessQueue();
    await client.start();

    await expect(client.publish(envelope)).resolves.toMatchObject({ created: true });
    await expect(client.publish(envelope)).resolves.toMatchObject({ created: false });
    expect(client.deliveryCount()).toBe(1);
    await client.stop();
  });

  it("fails compatibility before leasing an unsupported version", () => {
    const registry = createQueueHandlerRegistry([]);

    expect(() => assertWorkerCompatibility(registry, [queue])).toThrow(
      expect.objectContaining({ code: "QUEUE_HANDLER_VERSION_UNSUPPORTED" }),
    );
  });

  it("stops leasing before awaiting in-flight work", async () => {
    let finish!: () => void;
    const handler = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const client = createInProcessQueue();
    const runtime = createQueueWorkerRuntime({
      client,
      registry: createQueueHandlerRegistry([{ handler, queue }]),
    });

    await runtime.start();
    await client.publish(envelope);
    const stopping = runtime.stop({ graceful: true, timeoutMs: 1_000 });
    await expect(
      client.publish({ ...envelope, domainJobId: "01990000-0000-7000-8000-000000000004" }),
    ).rejects.toMatchObject({
      code: "QUEUE_NOT_STARTED",
    });
    finish();
    await expect(stopping).resolves.toBeUndefined();
  });
});
