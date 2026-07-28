import {
  reconcileBackgroundJobs,
  reconcileJobOutbox,
  type DatabaseClient,
} from "@studio-parallel/db";
import type { QueuePublisher } from "@studio-parallel/domain";
import {
  createCorrelationId,
  createErrorMonitor,
  createJsonLogger,
  createMetricRecorder,
} from "@studio-parallel/observability";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createOutboxReconciler } from "./outbox-reconciler.js";

vi.mock("@studio-parallel/db", () => ({
  reconcileBackgroundJobs: vi.fn(),
  reconcileJobOutbox: vi.fn(),
}));

const logicalReconcile = vi.mocked(reconcileBackgroundJobs);
const outboxReconcile = vi.mocked(reconcileJobOutbox);

beforeEach(() => {
  vi.useFakeTimers();
  logicalReconcile.mockReset().mockResolvedValue({ flagged: 0, inspected: 0, repaired: 1 });
  outboxReconcile.mockReset().mockResolvedValue({ claimed: 1, dispatched: 1, failed: 0 });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("worker reconciliation schedule", () => {
  it("runs logical repair before outbox dispatch on startup and each bounded interval", async () => {
    const reconciler = createOutboxReconciler({
      batchSize: 20,
      correlationId: createCorrelationId(),
      database: {} as DatabaseClient,
      errorMonitor: createErrorMonitor({
        environment: "test",
        release: "test",
        service: "worker",
      }),
      intervalMs: 1_000,
      logger: createJsonLogger({
        environment: "test",
        release: "test",
        service: "worker",
        sink: () => {},
      }),
      metrics: createMetricRecorder({
        environment: "test",
        release: "test",
        service: "worker",
      }),
      publisher: {} as QueuePublisher,
    });

    reconciler.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(logicalReconcile).toHaveBeenCalledTimes(1);
    expect(outboxReconcile).toHaveBeenCalledTimes(1);
    expect(logicalReconcile.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY).toBeLessThan(
      outboxReconcile.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );

    await vi.advanceTimersByTimeAsync(1_000);
    expect(logicalReconcile).toHaveBeenCalledTimes(2);
    expect(outboxReconcile).toHaveBeenCalledTimes(2);
    await reconciler.stop();
  });
});
