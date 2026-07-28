export const serviceNames = ["web", "worker"] as const;

export {
  evaluateGoogleOidcProfile,
  isAllowedRequestOrigin,
  oidcDenialReasons,
  resolveSafeReturnUrl,
  type GoogleOidcDecision,
  type GoogleOidcIdentity,
  type OidcDenialReason,
} from "./auth.js";
export {
  createAvailableDashboardSection,
  dashboardAttentionPriorities,
  orderDashboardAttentionItems,
  type DashboardAction,
  type DashboardAttentionItem,
  type DashboardAttentionPriority,
  type DashboardAttentionSummary,
  type DashboardCoverageSummary,
  type DashboardIntegrationSummary,
  type DashboardMetric,
  type DashboardProcessingSummary,
  type DashboardSection,
  type DashboardStrategySummary,
  type DashboardSummary,
} from "./dashboard.js";
export {
  isQueueName,
  parseQueueJobEnvelope,
  queueDefinitions,
  queueVersionKey,
  type QueueHandler,
  type QueueHandlerContext,
  type QueueHandlerRegistration,
  type QueueJobEnvelope,
  type QueueName,
  type QueuePublisher,
  type QueuePublishResult,
  type VersionedQueue,
} from "./background-jobs.js";
export {
  assertJobTransition,
  backgroundJobStates,
  canTransitionJob,
  isSafeJobStage,
  isTerminalJobState,
  jobAttemptStates,
  terminalBackgroundJobStates,
  InvalidJobTransitionError,
  type BackgroundJobState,
  type JobAttemptState,
} from "./job-lifecycle.js";
export {
  classifyJobHandlerError,
  decideJobRetry,
  jobFailureClasses,
  JobHandlerFailure,
  jobNextActions,
  type JobFailure,
  type JobFailureClass,
  type JobNextAction,
  type JobRetryDecision,
} from "./job-retry.js";

export type ServiceName = (typeof serviceNames)[number];

export const healthKinds = ["live", "ready"] as const;

export type HealthKind = (typeof healthKinds)[number];

export type ServiceHealth = Readonly<{
  service: ServiceName;
  status: "ok";
  kind: HealthKind;
  checks: Readonly<{
    configuration?: "ok";
    process?: "ok";
  }>;
  timestamp: string;
}>;

export function createServiceHealth(
  service: ServiceName,
  kind: HealthKind,
  now: Date = new Date(),
): ServiceHealth {
  return {
    service,
    status: "ok",
    kind,
    checks: kind === "live" ? { process: "ok" } : { configuration: "ok" },
    timestamp: now.toISOString(),
  };
}
