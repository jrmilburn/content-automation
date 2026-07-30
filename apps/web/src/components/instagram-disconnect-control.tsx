"use client";

import { useRouter } from "next/navigation";
import { useActionState, useEffect, useRef } from "react";

import {
  disconnectAccountAction,
  type DisconnectActionState,
} from "../app/(authenticated)/settings/integrations/actions";
import { ConfirmationDialog } from "./confirmation-dialog";

const initialState: DisconnectActionState = Object.freeze({ message: "", status: "idle" });

/**
 * Admin-only disconnect control.
 *
 * The confirmation copy states the impact in full — syncing stops, imported
 * history stays — because disconnecting is the one action on this screen that
 * an operator could otherwise mistake for a delete.
 */
export function InstagramDisconnectControl({
  accountId,
  username,
}: Readonly<{ accountId: string; username: string }>) {
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);
  const [state, action, isPending] = useActionState(disconnectAccountAction, initialState);

  useEffect(() => {
    if (state.status !== "idle") router.refresh();
  }, [router, state]);

  return (
    <div className="integration-account__disconnect">
      <h3>Disconnect</h3>
      <p>
        Disconnecting stops syncing and removes the stored connection. Posts and analyses already
        imported are kept.
      </p>
      <form action={action} ref={formRef}>
        <input name="accountId" type="hidden" value={accountId} />
        <ConfirmationDialog
          confirmLabel="Disconnect account"
          description={`Syncing for ${username} stops immediately and the stored connection is removed. Posts and analyses already imported remain available. You can reconnect this account later.`}
          disabled={isPending}
          onConfirm={() => formRef.current?.requestSubmit()}
          title="Disconnect this Instagram account?"
          triggerLabel={isPending ? "Disconnecting…" : "Disconnect account"}
        />
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
