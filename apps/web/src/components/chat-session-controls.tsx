"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

import { chatTitleMaxLength } from "../lib/chat";
import {
  deleteChatSessionAction,
  renameChatSessionAction,
  type ChatActionState,
} from "../app/(authenticated)/chat/actions";
import { ConfirmationDialog } from "./confirmation-dialog";

/**
 * Renaming and deleting one conversation.
 *
 * Renaming opens a field rather than presenting one, because the title is
 * usually right and a form standing permanently open invites edits nobody
 * wanted. Focus moves into the field when it opens and back to the button when
 * it closes, so the control is usable without a pointer.
 *
 * Deleting is confirmed and says what goes with it. Messages are removed with
 * the conversation and nothing restores them, which is exactly the kind of
 * downstream effect this product states before it happens rather than after.
 * Confirming calls `requestSubmit` on the form the dialog sits inside, rather
 * than clicking a second hidden submit button: the form's own action runs and
 * carries the session id, and the accessibility tree gains no duplicate control
 * that reads as a second way to delete.
 */

const initialState: ChatActionState = Object.freeze({ message: "", status: "idle" });

export function ChatSessionControls({
  sessionId,
  title,
}: Readonly<{ sessionId: string; title: string }>) {
  const router = useRouter();
  const deleteFormRef = useRef<HTMLFormElement>(null);
  const fieldRef = useRef<HTMLInputElement>(null);
  const renameRef = useRef<HTMLButtonElement>(null);
  const [isRenaming, setIsRenaming] = useState(false);
  const [state, action, isPending] = useActionState(renameChatSessionAction, initialState);

  useEffect(() => {
    if (isRenaming) fieldRef.current?.focus();
  }, [isRenaming]);

  useEffect(() => {
    if (state.status === "idle") return;
    if (state.status === "success") {
      setIsRenaming(false);
      renameRef.current?.focus();
    }
    router.refresh();
  }, [router, state]);

  return (
    <div className="chat-session-controls">
      {isRenaming ? (
        <form action={action} className="chat-session-controls__form">
          <input name="sessionId" type="hidden" value={sessionId} />
          <label className="visually-hidden" htmlFor="chat-session-title">
            Conversation name
          </label>
          <input
            className="chat-session-controls__field"
            defaultValue={title}
            id="chat-session-title"
            maxLength={chatTitleMaxLength}
            name="title"
            ref={fieldRef}
            type="text"
          />
          <button className="button button--primary" disabled={isPending} type="submit">
            {isPending ? "Saving…" : "Save name"}
          </button>
          <button
            className="button button--secondary"
            onClick={() => {
              setIsRenaming(false);
              renameRef.current?.focus();
            }}
            type="button"
          >
            Cancel
          </button>
        </form>
      ) : (
        <button
          className="button button--secondary"
          onClick={() => setIsRenaming(true)}
          ref={renameRef}
          type="button"
        >
          Rename
        </button>
      )}

      <form action={deleteChatSessionAction} ref={deleteFormRef}>
        <input name="sessionId" type="hidden" value={sessionId} />
        <ConfirmationDialog
          confirmLabel="Delete conversation"
          description="Every message in this conversation is deleted with it. Nothing restores them, and the strategy it drew on is not affected."
          onConfirm={() => deleteFormRef.current?.requestSubmit()}
          title="Delete this conversation?"
          triggerLabel="Delete"
        />
      </form>

      <p aria-atomic="true" aria-live="polite" className="chat-session-controls__status">
        {state.status === "error" ? state.message : ""}
      </p>
    </div>
  );
}
