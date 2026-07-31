"use client";

import { useRouter } from "next/navigation";
import { useActionState, useEffect } from "react";

import {
  syncAccountAction,
  type DisconnectActionState,
} from "../app/(authenticated)/settings/integrations/actions";

const initialState: DisconnectActionState = Object.freeze({ message: "", status: "idle" });

/**
 * Starts an import for one account.
 *
 * The copy says the sync was queued rather than completed, because the worker
 * owns the import and may not even be running — claiming posts had been
 * fetched would be the one misleading thing this control could do.
 */
export function InstagramSyncControl({ accountId }: Readonly<{ accountId: string }>) {
  const router = useRouter();
  const [state, action, isPending] = useActionState(syncAccountAction, initialState);

  useEffect(() => {
    if (state.status !== "idle") router.refresh();
  }, [router, state]);

  return (
    <div className="integration-account__sync">
      <form action={action}>
        <input name="accountId" type="hidden" value={accountId} />
        <button className="button button--secondary" disabled={isPending} type="submit">
          {isPending ? "Starting sync…" : "Sync now"}
        </button>
      </form>
      {state.status === "idle" ? null : (
        <p
          aria-atomic="true"
          aria-live="polite"
          className={`integration-action-status integration-action-status--${state.status}`}
        >
          {state.message}
          {state.reference ? (
            <span>
              {" "}
              Reference <code>{state.reference}</code>
            </span>
          ) : null}
        </p>
      )}
    </div>
  );
}
