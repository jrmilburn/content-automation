import "server-only";

import { isQueueName, type QueueName } from "@studio-parallel/domain";
import type {
  JobDatabaseExecutor,
  ManualRetryJob,
  ManualRetryPrerequisiteResult,
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

const policies = {
  "analysis.run": foundationPolicy,
  "analytics.recalculate": foundationPolicy,
  "asset.cleanup": foundationPolicy,
  "asset.validate": foundationPolicy,
  "instagram.snapshot.post": foundationPolicy,
  "instagram.sync.account": foundationPolicy,
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
