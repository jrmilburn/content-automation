import { loadDatabaseConfig } from "@studio-parallel/config";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type { SessionPrincipal } from "../../src/auth.js";
import { createDatabaseClient, type DatabaseClient } from "../../src/client.js";
import { loadJobDiagnosticDetail, loadJobDiagnosticList } from "../../src/job-diagnostics.js";
import { developmentWorkspace } from "../../src/seed-data.js";

const workspaceId = developmentWorkspace.id;
const foreignWorkspaceId = "019b0000-0000-7000-8000-000000000001";
const adminId = "019b0000-0000-7000-8000-000000000011";
const memberId = "019b0000-0000-7000-8000-000000000012";
const resourceA = "019b0000-0000-7000-8000-000000000021";
const resourceB = "019b0000-0000-7000-8000-000000000022";
const failedJobId = "019b0000-0000-7000-8000-000000000101";
const processingJobId = "019b0000-0000-7000-8000-000000000102";
const succeededJobId = "019b0000-0000-7000-8000-000000000103";
const foreignJobId = "019b0000-0000-7000-8000-000000000104";

let database: DatabaseClient;
let admin: SessionPrincipal;
let member: SessionPrincipal;

beforeAll(() => {
  database = createDatabaseClient(loadDatabaseConfig().DATABASE_URL);
});

beforeEach(async () => {
  await database.auditEvent.deleteMany();
  await database.jobAttempt.deleteMany();
  await database.jobOutbox.deleteMany();
  await database.backgroundJob.deleteMany();
  await database.systemSetting.deleteMany();
  await database.internalUser.deleteMany();
  await database.workspace.deleteMany({ where: { id: { not: workspaceId } } });

  await database.workspace.create({
    data: { id: foreignWorkspaceId, name: "Foreign diagnostics", slug: "foreign-diagnostics" },
  });
  const adminRecord = await database.internalUser.create({
    data: { email: "diagnostics-admin@example.invalid", id: adminId, role: "ADMIN", workspaceId },
  });
  const memberRecord = await database.internalUser.create({
    data: {
      email: "diagnostics-member@example.invalid",
      id: memberId,
      role: "MEMBER",
      workspaceId,
    },
  });
  admin = principal(adminRecord);
  member = principal(memberRecord);

  await createJob({
    attemptCount: 3,
    completedAt: new Date("2026-07-28T05:10:00.000Z"),
    id: failedJobId,
    lastErrorClass: "INVALID_INPUT",
    lastErrorCode: "SOURCE_VIDEO_REQUIRED",
    nextAction: "REPLACE_INPUT",
    queueName: "analysis.run",
    resourceId: resourceA,
    stage: "failed_attention",
    state: "FAILED_ATTENTION",
  });
  await createJob({
    attemptCount: 1,
    id: processingJobId,
    queueName: "instagram.sync.account",
    resourceId: resourceB,
    stage: "uploading_file",
    startedAt: new Date("2026-07-28T05:05:00.000Z"),
    state: "PROCESSING",
  });
  await createJob({
    attemptCount: 1,
    completedAt: new Date("2026-07-28T05:00:00.000Z"),
    id: succeededJobId,
    queueName: "analysis.run",
    resourceId: resourceA,
    stage: "completed",
    state: "SUCCEEDED",
  });
  await createJob({
    id: foreignJobId,
    queueName: "analysis.run",
    resourceId: resourceA,
    stage: "queued",
    state: "QUEUED",
    workspaceId: foreignWorkspaceId,
  });
});

afterAll(async () => {
  await database.auditEvent.deleteMany();
  await database.jobAttempt.deleteMany();
  await database.jobOutbox.deleteMany();
  await database.backgroundJob.deleteMany();
  await database.internalUser.deleteMany();
  await database.workspace.deleteMany({ where: { id: foreignWorkspaceId } });
  await database.$disconnect();
});

describe("job diagnostic list", () => {
  it("filters owned jobs by state, type, resource and manual-attention status", async () => {
    const now = new Date("2026-07-28T06:00:00.000Z");
    await expect(
      loadJobDiagnosticList(database, admin, { state: "FAILED_ATTENTION" }, now),
    ).resolves.toMatchObject({ jobs: [{ id: failedJobId }], totalCount: 1 });
    await expect(
      loadJobDiagnosticList(database, admin, { queueName: "instagram.sync.account" }, now),
    ).resolves.toMatchObject({ jobs: [{ id: processingJobId }], totalCount: 1 });
    await expect(
      loadJobDiagnosticList(database, admin, { resourceId: resourceA }, now),
    ).resolves.toMatchObject({ totalCount: 2 });
    await expect(
      loadJobDiagnosticList(database, admin, { attention: true }, now),
    ).resolves.toMatchObject({ jobs: [{ id: failedJobId }], totalCount: 1 });
    await expect(
      loadJobDiagnosticList(database, admin, { attention: false }, now),
    ).resolves.toMatchObject({ totalCount: 2 });
    await expect(
      loadJobDiagnosticList(database, admin, { matchesNothing: true }, now),
    ).resolves.toMatchObject({ fingerprint: "empty", jobs: [], totalCount: 0 });

    const all = await loadJobDiagnosticList(database, admin, {}, now);
    expect(all.jobs.map(({ id }) => id)).toEqual([failedJobId, processingJobId, succeededJobId]);
    expect(all.jobs.some(({ id }) => id === foreignJobId)).toBe(false);
  });
});

describe("job diagnostic detail", () => {
  it("returns only safe owned metadata, attempt history and server-derived eligibility", async () => {
    await database.jobAttempt.create({
      data: {
        attemptNumber: 3,
        backgroundJobId: failedJobId,
        completedAt: new Date("2026-07-28T05:10:00.000Z"),
        correlationId: failedJobId,
        errorClass: "INVALID_INPUT",
        errorCode: "SOURCE_VIDEO_REQUIRED",
        handlerVersion: 1,
        heartbeatAt: new Date("2026-07-28T05:10:00.000Z"),
        id: "019b0000-0000-7000-8000-000000000201",
        leaseId: "019b0000-0000-7000-8000-000000000202",
        nextAction: "REPLACE_INPUT",
        stage: "failed_attention",
        startedAt: new Date("2026-07-28T05:09:00.000Z"),
        state: "FAILED_ATTENTION",
        workspaceId,
      },
    });
    const detail = await loadJobDiagnosticDetail(database, admin, failedJobId);
    expect(detail).toMatchObject({
      attempts: [{ attemptNumber: 3, errorCode: "SOURCE_VIDEO_REQUIRED" }],
      cancel: { allowed: false, reason: "STATE_NOT_CANCELLABLE" },
      inputVersion: "input.v1",
      retry: { allowed: true },
      safeErrorDetail: expect.stringContaining("Existing completed data remains safe"),
    });
    const serialised = JSON.stringify(detail);
    expect(serialised).not.toContain("signed.example.invalid");
    expect(serialised).not.toContain("SECRET_TOKEN");
    expect(serialised).not.toContain("raw prompt");

    await expect(loadJobDiagnosticDetail(database, member, failedJobId)).resolves.toMatchObject({
      retry: { allowed: false, reason: "ADMIN_REQUIRED" },
    });
    await expect(loadJobDiagnosticDetail(database, admin, foreignJobId)).resolves.toBeNull();
    await expect(loadJobDiagnosticDetail(database, admin, "not-a-job-id")).resolves.toBeNull();
  });

  it("does not authorise a crafted or stale principal", async () => {
    await expect(
      loadJobDiagnosticDetail(database, { ...admin, sessionVersion: 999 }, failedJobId),
    ).rejects.toMatchObject({ code: "ACCESS_DENIED" });
  });
});

function principal(record: {
  id: string;
  sessionVersion: number;
  workspaceId: string;
}): SessionPrincipal {
  return {
    internalUserId: record.id,
    sessionVersion: record.sessionVersion,
    workspaceId: record.workspaceId,
  };
}

async function createJob(
  input: Readonly<{
    attemptCount?: number;
    completedAt?: Date;
    id: string;
    lastErrorClass?: string;
    lastErrorCode?: string;
    nextAction?: string;
    queueName: string;
    resourceId: string;
    stage: string;
    startedAt?: Date;
    state: "FAILED_ATTENTION" | "PROCESSING" | "QUEUED" | "SUCCEEDED";
    workspaceId?: string;
  }>,
): Promise<void> {
  await database.backgroundJob.create({
    data: {
      attemptCount: input.attemptCount ?? 0,
      correlationId: input.id,
      handlerVersion: 1,
      id: input.id,
      idempotencyKey:
        input.id === failedJobId
          ? "SECRET_TOKEN raw prompt https://signed.example.invalid/object"
          : `diagnostic-${input.id}`,
      inputVersion: "input.v1",
      queueName: input.queueName,
      resourceId: input.resourceId,
      resourceType: "instagram_post",
      stage: input.stage,
      state: input.state,
      workspaceId: input.workspaceId ?? workspaceId,
      ...(input.state === "PROCESSING"
        ? {
            heartbeatAt: input.startedAt ?? new Date("2026-07-28T05:05:00.000Z"),
            leaseExpiresAt: new Date("2026-07-28T05:15:00.000Z"),
            leaseId: "019b0000-0000-7000-8000-000000000302",
          }
        : {}),
      ...(input.completedAt ? { completedAt: input.completedAt } : {}),
      ...(input.lastErrorClass ? { lastErrorClass: input.lastErrorClass } : {}),
      ...(input.lastErrorCode ? { lastErrorCode: input.lastErrorCode } : {}),
      ...(input.nextAction ? { nextAction: input.nextAction } : {}),
      ...(input.startedAt ? { startedAt: input.startedAt } : {}),
    },
  });
}
