import { describe, expect, it } from "vitest";

import {
  createDomainCommandContext,
  createWebRequestContext,
  createWorkerEventContext,
} from "./correlation.js";

const incomingCorrelationId = "019873d5-31e6-7c59-a531-1f2f4cbce141";

describe("correlation propagation", () => {
  it("carries one identifier through web request, domain command and worker event", () => {
    const webRequest = createWebRequestContext({
      "x-correlation-id": incomingCorrelationId,
    });
    const domainCommand = createDomainCommandContext(webRequest, {
      actorId: "user_01",
      postId: "post_01",
      workspaceId: "workspace_01",
    });
    const workerEvent = createWorkerEventContext(domainCommand, {
      attempt: 2,
      jobId: "job_01",
    });

    expect(webRequest.correlationId).toBe(incomingCorrelationId);
    expect(domainCommand.correlationId).toBe(incomingCorrelationId);
    expect(workerEvent.correlationId).toBe(incomingCorrelationId);
    expect(workerEvent).toMatchObject({
      attempt: 2,
      jobId: "job_01",
      postId: "post_01",
      workspaceId: "workspace_01",
    });
  });

  it("replaces an unsafe incoming identifier and drops unsafe resource identifiers", () => {
    const generated = "019873d5-31e6-7c59-a531-1f2f4cbce142";
    const webRequest = createWebRequestContext(
      { "x-correlation-id": "unsafe\nlog-entry" },
      () => generated,
    );
    const domainCommand = createDomainCommandContext(webRequest, {
      postId: "post?token=redaction-canary",
      workspaceId: "workspace_02",
    });

    expect(webRequest.correlationId).toBe(generated);
    expect(domainCommand).not.toHaveProperty("postId");
    expect(domainCommand.workspaceId).toBe("workspace_02");
  });
});
