"use server";

import {
  cancelBackgroundJob,
  retryBackgroundJob,
  type JobOperationResult,
} from "@studio-parallel/db";
import { createWebRequestContext, reportError } from "@studio-parallel/observability";
import { headers } from "next/headers";
import { revalidatePath } from "next/cache";

import { getDatabase } from "../../../lib/server/database";
import { resolveJobRetryPolicy } from "../../../lib/server/job-retry-policy";
import { webErrorMonitor, webLogger, webMetrics } from "../../../lib/server/observability";
import { requireShellActor } from "../../../lib/server/shell-session";

export type JobOperationActionState = Readonly<{
  message: string;
  reference?: string;
  status: "error" | "idle" | "success";
}>;

export async function cancelJobAction(
  _previous: JobOperationActionState,
  formData: FormData,
): Promise<JobOperationActionState> {
  return performJobOperation("cancel", formData);
}

export async function retryJobAction(
  _previous: JobOperationActionState,
  formData: FormData,
): Promise<JobOperationActionState> {
  return performJobOperation("retry", formData);
}

async function performJobOperation(
  operation: "cancel" | "retry",
  formData: FormData,
): Promise<JobOperationActionState> {
  const requestContext = createWebRequestContext(await headers());
  const rawJobId = formData.get("jobId");
  const jobId = typeof rawJobId === "string" ? rawJobId : "";

  try {
    const principal = await requireShellActor();
    const database = getDatabase();
    const context = { correlationId: requestContext.correlationId, principal };
    const telemetry = { logger: webLogger, metrics: webMetrics };
    const result =
      operation === "cancel"
        ? await cancelBackgroundJob({
            context,
            database,
            jobId,
            reasonCode: "OPERATOR_REQUEST",
            telemetry,
          })
        : await retryBackgroundJob({
            checkPrerequisites: (executor, job) =>
              resolveJobRetryPolicy(job.queueName).checkPrerequisites(executor, job),
            context,
            database,
            jobId,
            reasonCode: "OPERATOR_REQUEST",
            resultExists: (executor, job) =>
              resolveJobRetryPolicy(job.queueName).resultExists(executor, job),
            telemetry,
          });

    revalidatePath("/operations");
    if (jobId) revalidatePath(`/operations/jobs/${jobId}`);
    return actionResult(operation, result);
  } catch (error) {
    reportError(
      error,
      {
        correlationId: requestContext.correlationId,
        event: `job.${operation}.action_failed`,
        stage: `user_${operation}`,
      },
      { logger: webLogger, monitor: webErrorMonitor },
    );
    return Object.freeze({
      message: "This action could not be completed. Existing workspace data is unchanged.",
      reference: requestContext.correlationId,
      status: "error",
    });
  }
}

function actionResult(
  operation: "cancel" | "retry",
  result: JobOperationResult,
): JobOperationActionState {
  if (result.outcome === "CANCELLED") {
    return { message: "The job was cancelled before another attempt started.", status: "success" };
  }
  if (result.outcome === "CANCELLATION_REQUESTED") {
    return {
      message: "Cancellation is recorded and will apply at the next safe checkpoint.",
      status: "success",
    };
  }
  if (result.outcome === "RETRY_QUEUED") {
    return { message: "One bounded manual retry was queued.", status: "success" };
  }
  if (result.outcome === "ALREADY_APPLIED") {
    return {
      message:
        operation === "cancel"
          ? "Cancellation was already recorded."
          : "A manual retry was already queued.",
      status: "success",
    };
  }
  if (result.outcome === "NOT_FOUND") {
    return { message: "This job is unavailable in the current workspace.", status: "error" };
  }
  if (result.outcome === "RATE_LIMITED") {
    return { message: "Too many recent operator actions. Try again shortly.", status: "error" };
  }

  const reasonMessages: Readonly<Record<string, string>> = {
    ADMIN_REQUIRED: "Administrator access is required for this action.",
    JOB_ATTEMPT_LIMIT_REACHED: "The bounded attempt limit has been reached.",
    JOB_RECONCILIATION_REQUIRED: "Resolve the recorded consistency check before retrying.",
    JOB_RESULT_ALREADY_EXISTS: "A committed result already exists, so retry was refused.",
    PROCESSING_STAGE_NOT_CANCELLABLE: "This processing stage cannot be interrupted safely.",
  };
  return {
    message:
      reasonMessages[result.reasonCode] ??
      "The job changed before this action completed. Review its current state and try again if eligible.",
    status: "error",
  };
}
