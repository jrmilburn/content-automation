import "server-only";

import { isQueueName, type QueueName } from "@studio-parallel/domain";
import {
  createWorkspaceContext,
  instagramSyncRunSucceededForJob,
  type JobDatabaseExecutor,
  type ManualRetryJob,
  type ManualRetryPrerequisiteResult,
} from "@studio-parallel/db";

type RetryPolicy = Readonly<{
  checkPrerequisites(
    database: JobDatabaseExecutor,
    job: ManualRetryJob,
  ): Promise<ManualRetryPrerequisiteResult>;
  resultExists(database: JobDatabaseExecutor, job: ManualRetryJob): Promise<boolean>;
}>;

// Every queue is intentionally enumerated. These foundation queues do not have a persisted
// immutable result model yet, so FAILED_ATTENTION plus the reconciliation guard is authoritative.
// A vertical must replace its entry with concrete result and prerequisite checks when it adds one.
const foundationPolicy: RetryPolicy = Object.freeze({
  checkPrerequisites: async (_database, job) =>
    job.reconciliationCode
      ? { eligible: false, reasonCode: "JOB_RECONCILIATION_REQUIRED" }
      : { eligible: true },
  resultExists: async () => false,
});

// The sync vertical now has a persisted immutable result, so a retry can be
// refused on the evidence rather than on job state alone: a run that already
// succeeded for this job must never be re-imported.
const syncPolicy: RetryPolicy = Object.freeze({
  checkPrerequisites: foundationPolicy.checkPrerequisites,
  resultExists: (database, job) =>
    instagramSyncRunSucceededForJob(database, createWorkspaceContext(job.workspaceId), job.id),
});

const policies = {
  "analysis.run": foundationPolicy,
  "analytics.recalculate": foundationPolicy,
  "asset.cleanup": foundationPolicy,
  "asset.validate": foundationPolicy,
  // Snapshots stay on the foundation policy deliberately: a snapshot is
  // content-addressed, so re-running either collapses onto the existing row or
  // records a genuinely changed observation. Refusing on a prior result would
  // suppress the second, legitimate case.
  "instagram.snapshot.post": foundationPolicy,
  "instagram.sync.account": syncPolicy,
  "instagram.token.maintain": foundationPolicy,
  "strategy.generate": foundationPolicy,
  "system.reconcile": foundationPolicy,
} satisfies Readonly<Record<QueueName, RetryPolicy>>;

export function resolveJobRetryPolicy(queueName: string): RetryPolicy {
  if (!isQueueName(queueName)) {
    return {
      checkPrerequisites: async () => ({
        eligible: false,
        reasonCode: "JOB_HANDLER_UNSUPPORTED",
      }),
      resultExists: async () => true,
    };
  }
  return policies[queueName];
}
