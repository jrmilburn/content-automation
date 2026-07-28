import { describe, expect, it } from "vitest";

import type { CorrelationId } from "./correlation.js";
import { createJsonLogger, type JsonLogEvent, type LogAttributes } from "./logger.js";

const correlationId = "019873d5-31e6-7c59-a531-1f2f4cbce143" as CorrelationId;

describe("createJsonLogger", () => {
  it("emits the required schema with only allowlisted safe fields", () => {
    const events: JsonLogEvent[] = [];
    const canaries = {
      authorization: "Bearer auth-redaction-canary",
      cookie: "session=cookie-redaction-canary",
      prompt: "prompt-redaction-canary",
      signedUrl: "https://objects.example/video?signature=url-redaction-canary",
      transcript: "transcript-redaction-canary",
      video: "video-redaction-canary",
    };
    const attributes = {
      correlationId,
      stage: "dispatch",
      workspaceId: "workspace_03",
      jobId: "job_03",
      providerRequestId: canaries.signedUrl,
      route: `/commands/run?prompt=${canaries.prompt}`,
      headers: canaries,
      error: new Error(canaries.transcript, {
        cause: { cookie: canaries.cookie, video: canaries.video },
      }),
    } as unknown as LogAttributes;

    const logger = createJsonLogger({
      environment: "staging",
      level: "debug",
      now: () => new Date("2026-07-28T01:02:03.000Z"),
      release: "git-a1b2c3d",
      service: "worker",
      sink: (event) => events.push(event),
    });

    logger.info("job.dispatched", attributes);

    expect(events).toEqual([
      expect.objectContaining({
        timestamp: "2026-07-28T01:02:03.000Z",
        level: "info",
        service: "worker",
        environment: "staging",
        release: "git-a1b2c3d",
        event: "job.dispatched",
        stage: "dispatch",
        correlationId,
        workspaceId: "workspace_03",
        jobId: "job_03",
        route: "/commands/run",
      }),
    ]);

    const serialised = JSON.stringify(events);
    for (const canary of Object.values(canaries)) {
      expect(serialised).not.toContain(canary);
    }
    expect(events[0]).not.toHaveProperty("headers");
    expect(events[0]).not.toHaveProperty("error");
    expect(events[0]).not.toHaveProperty("providerRequestId");
  });

  it("honours the configured minimum level", () => {
    const events: JsonLogEvent[] = [];
    const logger = createJsonLogger({
      environment: "production",
      level: "warn",
      release: "release-1",
      service: "web",
      sink: (event) => events.push(event),
    });

    logger.info("request.completed", { correlationId, stage: "response" });
    logger.warn("request.rejected", { correlationId, stage: "validation" });

    expect(events.map(({ level }) => level)).toEqual(["warn"]);
  });
});
