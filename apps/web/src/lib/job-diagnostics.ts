import {
  backgroundJobStates,
  isQueueName,
  queueDefinitions,
  type BackgroundJobState,
  type QueueName,
} from "@studio-parallel/domain";
import type {
  JobActionUnavailableReason,
  JobDiagnosticFilters,
  JobDiagnosticListItem,
} from "@studio-parallel/db";

import type { StatusTone } from "../components/status-badge";

export type OperationsSearchParams = Record<string, string | string[] | undefined>;

export type OperationsFilterValues = Readonly<{
  attention: "all" | "clear" | "required";
  queueName: "all" | QueueName;
  resource: string;
  state: "all" | BackgroundJobState;
}>;

export type JobStatePresentation = Readonly<{
  description: string;
  label: string;
  tone: StatusTone;
}>;

export const queueLabels: Readonly<Record<QueueName, string>> = Object.freeze({
  "analysis.run": "Post analysis",
  "analytics.recalculate": "Analytics recalculation",
  "asset.cleanup": "Asset cleanup",
  "asset.validate": "Asset validation",
  "instagram.media.import": "Instagram video copy",
  "instagram.snapshot.post": "Post insight snapshot",
  "instagram.sync.account": "Instagram account sync",
  "instagram.token.maintain": "Instagram connection maintenance",
  "strategy.generate": "Strategy generation",
  "system.reconcile": "System reconciliation",
});

export const queueFilterOptions = queueDefinitions.map(({ name }) => ({
  label: queueLabels[name],
  value: name,
}));

export const stateFilterOptions: ReadonlyArray<
  Readonly<{ label: string; value: BackgroundJobState }>
> = [
  { label: "Queued", value: "QUEUED" },
  { label: "Processing", value: "PROCESSING" },
  { label: "Retry scheduled", value: "RETRY_SCHEDULED" },
  { label: "Needs attention", value: "FAILED_ATTENTION" },
  { label: "Completed", value: "SUCCEEDED" },
  { label: "Cancelled", value: "CANCELLED" },
];

export function parseOperationsFilters(searchParams: OperationsSearchParams): Readonly<{
  filters: JobDiagnosticFilters;
  values: OperationsFilterValues;
}> {
  const rawState = firstValue(searchParams.state);
  const rawQueueName = firstValue(searchParams.type);
  const rawAttention = firstValue(searchParams.attention);
  const resource = firstValue(searchParams.resource).trim().slice(0, 80);
  let matchesNothing = false;

  const state = backgroundJobStates.includes(rawState as BackgroundJobState)
    ? (rawState as BackgroundJobState)
    : undefined;
  if (rawState && rawState !== "all" && !state) matchesNothing = true;

  const queueName = isQueueName(rawQueueName) ? rawQueueName : undefined;
  if (rawQueueName && rawQueueName !== "all" && !queueName) matchesNothing = true;

  const attention =
    rawAttention === "required" ? true : rawAttention === "clear" ? false : undefined;
  if (rawAttention && rawAttention !== "all" && attention === undefined) matchesNothing = true;

  const resourceId = isUuidV7(resource) ? resource : undefined;
  if (resource && !resourceId) matchesNothing = true;

  return Object.freeze({
    filters: Object.freeze({
      ...(attention === undefined ? {} : { attention }),
      ...(matchesNothing ? { matchesNothing: true } : {}),
      ...(queueName ? { queueName } : {}),
      ...(resourceId ? { resourceId } : {}),
      ...(state ? { state } : {}),
    }),
    values: Object.freeze({
      attention: attention === true ? "required" : attention === false ? "clear" : ("all" as const),
      queueName: queueName ?? "all",
      resource,
      state: state ?? "all",
    }),
  });
}

export function presentJobState(job: JobDiagnosticListItem): JobStatePresentation {
  if (job.cancellationRequestedAt && job.state === "PROCESSING") {
    return {
      description:
        "Cancellation is recorded and will be applied at the next safe worker checkpoint.",
      label: "Cancellation requested",
      tone: "warning",
    };
  }

  switch (job.state) {
    case "QUEUED":
      return {
        description: "Waiting for an available worker. No processing has started yet.",
        label: "Queued",
        tone: "information",
      };
    case "PROCESSING":
      return {
        description: "A worker is active. The current safe stage is shown below.",
        label: "Processing",
        tone: "information",
      };
    case "RETRY_SCHEDULED":
      return {
        description: "A bounded automatic retry is scheduled after a recoverable failure.",
        label: "Retry scheduled",
        tone: "warning",
      };
    case "FAILED_ATTENTION":
      return {
        description: "Automatic attempts stopped. Review the safe detail before retrying.",
        label: "Needs attention",
        tone: "danger",
      };
    case "SUCCEEDED":
      return {
        description: "Processing completed and its committed result is available.",
        label: "Completed",
        tone: "success",
      };
    case "CANCELLED":
      return {
        description: "This work was cancelled. No further attempt will start.",
        label: "Cancelled",
        tone: "neutral",
      };
  }
}

export function queueLabel(queueName: JobDiagnosticListItem["queueName"]): string {
  return queueName === "unknown" ? "Unknown job type" : queueLabels[queueName];
}

export function resolveJobResourceHref(
  resourceType: string | null,
  resourceId: string | null,
): string | null {
  if (!resourceId || !isUuidV7(resourceId)) return null;
  switch (resourceType) {
    case "account":
    case "instagram_account":
      return `/accounts/${resourceId}`;
    case "analysis":
    case "instagram_post":
    case "post":
      return `/posts/${resourceId}`;
    default:
      return null;
  }
}

export function actionUnavailableCopy(reason: JobActionUnavailableReason): string {
  switch (reason) {
    case "ADMIN_REQUIRED":
      return "An administrator can act when this job's state allows it.";
    case "ATTEMPT_LIMIT_REACHED":
      return "The bounded attempt limit has been reached.";
    case "CANCELLATION_ALREADY_REQUESTED":
      return "Cancellation is already recorded.";
    case "PROCESSING_STAGE_NOT_CANCELLABLE":
      return "This processing stage cannot be interrupted safely.";
    case "RECONCILIATION_REQUIRED":
      return "Resolve the recorded consistency check before retrying.";
    case "STATE_NOT_CANCELLABLE":
      return "Completed, failed and cancelled jobs cannot be cancelled.";
    case "STATE_NOT_RETRYABLE":
      return "Only work that needs manual attention can be retried.";
  }
}

export function formatJobDate(value: string | null): string {
  if (!value) return "Not recorded";
  return new Intl.DateTimeFormat("en-AU", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Australia/Sydney",
  }).format(new Date(value));
}

export function formatIdentifier(value: string): string {
  return value
    .toLowerCase()
    .split(/[._-]+/u)
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function firstValue(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}

function isUuidV7(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
}
