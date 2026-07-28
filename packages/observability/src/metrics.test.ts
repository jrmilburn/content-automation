import { describe, expect, it } from "vitest";

import type { CorrelationId } from "./correlation.js";
import { createMetricRecorder, type MetricEvent } from "./metrics.js";

const correlationId = "019873d5-31e6-7c59-a531-1f2f4cbce145" as CorrelationId;

describe("createMetricRecorder", () => {
  it("records an allowlisted metric with deployment and correlation dimensions", () => {
    const events: MetricEvent[] = [];
    const metrics = createMetricRecorder({
      environment: "preview",
      now: () => new Date("2026-07-28T02:03:04.000Z"),
      release: "git-d4e5f6",
      service: "web",
      sink: (event) => events.push(event),
    });

    metrics.observe("operation.duration_ms", 42, "milliseconds", {
      correlationId,
      stage: "response",
      workspaceId: "workspace_05",
    });

    expect(events).toEqual([
      {
        timestamp: "2026-07-28T02:03:04.000Z",
        service: "web",
        environment: "preview",
        release: "git-d4e5f6",
        metric: "operation.duration_ms",
        value: 42,
        unit: "milliseconds",
        stage: "response",
        correlationId,
        workspaceId: "workspace_05",
      },
    ]);
  });

  it("drops invalid numeric samples", () => {
    const events: MetricEvent[] = [];
    const metrics = createMetricRecorder({
      environment: "test",
      release: "test",
      service: "worker",
      sink: (event) => events.push(event),
    });

    metrics.observe("operation.duration_ms", Number.NaN, "milliseconds", {
      correlationId,
      stage: "provider_call",
    });

    expect(events).toEqual([]);
  });
});
