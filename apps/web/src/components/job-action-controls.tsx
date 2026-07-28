"use client";

import type { JobActionEligibility } from "@studio-parallel/db";
import { useRouter } from "next/navigation";
import { useActionState, useEffect, useRef } from "react";

import {
  cancelJobAction,
  retryJobAction,
  type JobOperationActionState,
} from "../app/(authenticated)/operations/actions";
import { actionUnavailableCopy } from "../lib/job-diagnostics";
import { ConfirmationDialog } from "./confirmation-dialog";

const initialState: JobOperationActionState = Object.freeze({ message: "", status: "idle" });

export function JobActionControls({
  cancel,
  jobId,
  retry,
}: Readonly<{
  cancel: JobActionEligibility;
  jobId: string;
  retry: JobActionEligibility;
}>) {
  if (retry.allowed) return <RetryControl jobId={jobId} />;
  if (cancel.allowed) return <CancelControl jobId={jobId} />;

  const reason = retry.reason !== "STATE_NOT_RETRYABLE" ? retry.reason : cancel.reason;
  return (
    <p className="job-action-unavailable">
      <strong>No operator action is available.</strong> {actionUnavailableCopy(reason)}
    </p>
  );
}

function CancelControl({ jobId }: Readonly<{ jobId: string }>) {
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);
  const [state, action, isPending] = useActionState(cancelJobAction, initialState);

  useRefreshAfterResponse(state, router.refresh);

  return (
    <div className="job-action-control">
      <p>
        Cancel only if this work should not continue. Processing cancellation applies at the next
        safe checkpoint.
      </p>
      <form action={action} ref={formRef}>
        <input name="jobId" type="hidden" value={jobId} />
        <ConfirmationDialog
          confirmLabel="Cancel job"
          description="Queued work stops immediately. Active work stops cooperatively at a safe checkpoint; provider work already in flight may finish."
          disabled={isPending}
          onConfirm={() => formRef.current?.requestSubmit()}
          title="Cancel this job?"
          triggerLabel={isPending ? "Cancelling…" : "Cancel job"}
        />
      </form>
      <ActionStatus state={state} />
    </div>
  );
}

function RetryControl({ jobId }: Readonly<{ jobId: string }>) {
  const router = useRouter();
  const [state, action, isPending] = useActionState(retryJobAction, initialState);

  useRefreshAfterResponse(state, router.refresh);

  return (
    <div className="job-action-control">
      <p>
        Retry preserves the existing job signature and grants exactly one additional bounded
        attempt.
      </p>
      <form action={action}>
        <input name="jobId" type="hidden" value={jobId} />
        <button className="button button--primary" disabled={isPending} type="submit">
          {isPending ? "Queueing retry…" : "Retry once"}
        </button>
      </form>
      <ActionStatus state={state} />
    </div>
  );
}

function ActionStatus({ state }: Readonly<{ state: JobOperationActionState }>) {
  if (state.status === "idle") return null;
  return (
    <p
      aria-atomic="true"
      aria-live="polite"
      className={`job-action-status job-action-status--${state.status}`}
    >
      {state.message}
      {state.reference ? (
        <span>
          {" "}
          Reference <code>{state.reference}</code>
        </span>
      ) : null}
    </p>
  );
}

function useRefreshAfterResponse(state: JobOperationActionState, refresh: () => void) {
  useEffect(() => {
    if (state.status !== "idle") refresh();
  }, [refresh, state]);
}
