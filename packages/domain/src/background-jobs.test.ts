import { describe, expect, it } from "vitest";

import { parseQueueJobEnvelope, queueDefinitions, queueVersionKey } from "./background-jobs.js";

const envelope = {
  correlationId: "01990000-0000-7000-8000-000000000003",
  domainJobId: "01990000-0000-7000-8000-000000000002",
  handlerVersion: 1,
  queueName: "analysis.run",
  workspaceId: "01990000-0000-7000-8000-000000000001",
} as const;

describe("background job contracts", () => {
  it("keeps every queue name explicitly versioned", () => {
    expect(queueDefinitions).toHaveLength(9);
    expect(new Set(queueDefinitions.map(queueVersionKey)).size).toBe(queueDefinitions.length);
    expect(
      queueDefinitions.every(({ version }) => Number.isSafeInteger(version) && version > 0),
    ).toBe(true);
  });

  it("accepts only opaque IDs and safe queue metadata", () => {
    expect(parseQueueJobEnvelope(envelope)).toEqual(envelope);
    expect(parseQueueJobEnvelope({ ...envelope, accessToken: "do-not-queue" })).toBeUndefined();
    expect(parseQueueJobEnvelope({ ...envelope, queueName: "unknown.handler" })).toBeUndefined();
    expect(
      parseQueueJobEnvelope({ ...envelope, workspaceId: "tenant-from-browser" }),
    ).toBeUndefined();
  });
});
