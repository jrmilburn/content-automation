import "server-only";

import { loadAuthConfig } from "@studio-parallel/config";
import {
  loadJobDiagnosticDetail,
  loadJobDiagnosticList,
  type JobActionEligibility,
  type JobDiagnosticDetail,
  type JobDiagnosticFilters,
  type JobDiagnosticList,
  type JobDiagnosticListItem,
} from "@studio-parallel/db";

import { getDatabase } from "./database";
import { requireShellActor } from "./shell-session";

const testResourceId = "019a0000-0000-7000-8000-000000000201";
const testJobs: ReadonlyArray<JobDiagnosticListItem> = [
  testJob({
    attemptCount: 3,
    completedAt: "2026-07-28T05:10:00.000Z",
    id: "019a0000-0000-7000-8000-000000000101",
    lastErrorClass: "INVALID_INPUT",
    lastErrorCode: "SOURCE_VIDEO_REQUIRED",
    nextAction: "REPLACE_INPUT",
    queueName: "analysis.run",
    requiresManualAttention: true,
    retry: { allowed: true },
    stage: "failed_attention",
    state: "FAILED_ATTENTION",
  }),
  testJob({
    attemptCount: 1,
    id: "019a0000-0000-7000-8000-000000000102",
    queueName: "instagram.sync.account",
    stage: "loading_inputs",
    startedAt: "2026-07-28T05:12:00.000Z",
    state: "PROCESSING",
  }),
  testJob({
    attemptCount: 2,
    id: "019a0000-0000-7000-8000-000000000103",
    lastErrorClass: "TRANSIENT",
    lastErrorCode: "PROVIDER_TIMEOUT",
    nextAction: "RETRY_AUTOMATIC",
    nextAttemptAt: "2026-07-28T05:20:00.000Z",
    queueName: "instagram.snapshot.post",
    stage: "retry_scheduled",
    state: "RETRY_SCHEDULED",
  }),
  testJob({
    id: "019a0000-0000-7000-8000-000000000104",
    queueName: "asset.validate",
    stage: "queued",
    state: "QUEUED",
  }),
  testJob({
    attemptCount: 1,
    completedAt: "2026-07-28T05:00:00.000Z",
    id: "019a0000-0000-7000-8000-000000000105",
    queueName: "analytics.recalculate",
    stage: "completed",
    state: "SUCCEEDED",
  }),
  testJob({
    completedAt: "2026-07-28T04:58:00.000Z",
    id: "019a0000-0000-7000-8000-000000000106",
    queueName: "asset.cleanup",
    stage: "cancelled",
    state: "CANCELLED",
  }),
];

export async function loadOperationsList(
  filters: JobDiagnosticFilters,
): Promise<JobDiagnosticList> {
  const principal = await requireShellActor();
  const now = new Date();
  if (loadAuthConfig().APP_ENV === "test") return createTestList(filters, now);
  return loadJobDiagnosticList(getDatabase(), principal, filters, now);
}

export async function loadOperationsDetail(jobId: string): Promise<JobDiagnosticDetail | null> {
  const principal = await requireShellActor();
  if (loadAuthConfig().APP_ENV === "test") return createTestDetail(jobId);
  return loadJobDiagnosticDetail(getDatabase(), principal, jobId);
}

function createTestList(filters: JobDiagnosticFilters, now: Date): JobDiagnosticList {
  const jobs = filters.matchesNothing
    ? []
    : testJobs.filter(
        (job) =>
          (!filters.state || job.state === filters.state) &&
          (!filters.queueName || job.queueName === filters.queueName) &&
          (!filters.resourceId || job.resourceId === filters.resourceId) &&
          (filters.attention === undefined || job.requiresManualAttention === filters.attention),
      );
  return Object.freeze({
    filters,
    fingerprint: jobs.map((job) => `${job.id}:${job.version}:${job.state}`).join("|") || "empty",
    generatedAt: now.toISOString(),
    isTruncated: false,
    jobs: Object.freeze(jobs),
    totalCount: jobs.length,
  });
}

function createTestDetail(jobId: string): JobDiagnosticDetail | null {
  const job = testJobs.find(({ id }) => id === jobId);
  if (!job) return null;
  const failed = job.state === "FAILED_ATTENTION";
  return Object.freeze({
    ...job,
    attempts: Object.freeze(
      failed
        ? [
            Object.freeze({
              attemptNumber: 3,
              completedAt: "2026-07-28T05:10:00.000Z",
              errorClass: "INVALID_INPUT",
              errorCode: "SOURCE_VIDEO_REQUIRED",
              handlerVersion: 1,
              heartbeatAt: "2026-07-28T05:10:00.000Z",
              nextAction: "REPLACE_INPUT",
              nextAttemptAt: null,
              stage: "failed_attention",
              startedAt: "2026-07-28T05:09:00.000Z",
              state: "FAILED_ATTENTION" as const,
            }),
          ]
        : [],
    ),
    safeErrorDetail: failed
      ? "The recorded input did not pass validation. Existing completed data remains safe."
      : null,
    validationIssues: Object.freeze(
      failed ? ["COUNT_IMPLAUSIBLE at content.majorSectionCount.value"] : [],
    ),
    usage: Object.freeze({
      estimatedCostMicros: null,
      inputTokens: null,
      outputTokens: null,
      providerRequests: null,
    }),
  });
}

function testJob(
  overrides: Partial<JobDiagnosticListItem> &
    Pick<JobDiagnosticListItem, "id" | "queueName" | "stage" | "state">,
): JobDiagnosticListItem {
  const terminal =
    overrides.state === "SUCCEEDED" ||
    overrides.state === "FAILED_ATTENTION" ||
    overrides.state === "CANCELLED";
  const cancel: JobActionEligibility =
    overrides.cancel ??
    (overrides.state === "QUEUED" ||
    overrides.state === "RETRY_SCHEDULED" ||
    overrides.state === "PROCESSING"
      ? { allowed: true }
      : { allowed: false, reason: "STATE_NOT_CANCELLABLE" });
  const retry: JobActionEligibility = overrides.retry ?? {
    allowed: false,
    reason: "STATE_NOT_RETRYABLE",
  };

  return Object.freeze({
    attemptCount: 0,
    cancel,
    cancellationRequestedAt: null,
    completedAt: terminal ? "2026-07-28T05:00:00.000Z" : null,
    correlationId: overrides.id,
    handlerVersion: 1,
    inputVersion: "input.v1",
    lastErrorClass: null,
    lastErrorCode: null,
    maxAttempts: 8,
    nextAction: null,
    nextAttemptAt: null,
    queuedAt: "2026-07-28T04:55:00.000Z",
    reconciliationCode: null,
    requiresManualAttention: false,
    resourceId: testResourceId,
    resourceType: "instagram_post",
    retry,
    startedAt: null,
    updatedAt: "2026-07-28T05:12:00.000Z",
    version: 2,
    ...overrides,
  });
}
