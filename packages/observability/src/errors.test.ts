import { describe, expect, it } from "vitest";

import type { CorrelationId } from "./correlation.js";
import {
  createErrorMonitor,
  OperationalError,
  reportError,
  type ErrorMonitoringEvent,
} from "./errors.js";
import { createJsonLogger, type JsonLogEvent } from "./logger.js";

const correlationId = "019873d5-31e6-7c59-a531-1f2f4cbce144" as CorrelationId;

describe("safe operational errors", () => {
  it("handles expected validation errors without sending noisy monitoring events", () => {
    const logs: JsonLogEvent[] = [];
    const monitoring: ErrorMonitoringEvent[] = [];
    const logger = createJsonLogger({
      environment: "test",
      release: "release-test",
      service: "web",
      sink: (event) => logs.push(event),
    });
    const monitor = createErrorMonitor({
      environment: "test",
      release: "release-test",
      service: "web",
      transport: (event) => monitoring.push(event),
    });

    const result = reportError(
      new OperationalError({
        code: "INVALID_COMMAND",
        errorClass: "validation",
        statusCode: 400,
      }),
      { correlationId, event: "command.rejected", stage: "validation" },
      { logger, monitor },
    );

    expect(result).toMatchObject({
      errorCode: "INVALID_COMMAND",
      expected: true,
      statusCode: 400,
    });
    expect(logs).toEqual([
      expect.objectContaining({
        level: "warn",
        errorClass: "validation",
        expected: true,
      }),
    ]);
    expect(monitoring).toEqual([]);
  });

  it("separates monitoring environment and release without collecting nested error content", () => {
    const events: ErrorMonitoringEvent[] = [];
    const staging = createErrorMonitor({
      environment: "staging",
      release: "release-staging",
      service: "worker",
      transport: (event) => events.push(event),
    });
    const production = createErrorMonitor({
      environment: "production",
      release: "1bed2c9",
      service: "worker",
      transport: (event) => events.push(event),
    });
    const error = new Error("signed-url-redaction-canary", {
      cause: {
        authorization: "auth-redaction-canary",
        prompt: "prompt-redaction-canary",
      },
    });
    const context = {
      correlationId,
      event: "job.failed",
      jobId: "job_04",
      stage: "provider_call",
      workspaceId: "workspace_04",
    } as const;

    staging.captureException(error, context);
    production.captureException(error, context);

    expect(events.map(({ environment, release }) => ({ environment, release }))).toEqual([
      { environment: "staging", release: "release-staging" },
      { environment: "production", release: "1bed2c9" },
    ]);
    expect(events[0]).toMatchObject({
      errorClass: "unexpected",
      errorCode: "UNEXPECTED_ERROR",
      errorName: "Error",
      jobId: "job_04",
      workspaceId: "workspace_04",
    });
    expect(JSON.stringify(events)).not.toMatch(
      /signed-url-redaction-canary|auth-redaction-canary|prompt-redaction-canary/u,
    );
  });
});
