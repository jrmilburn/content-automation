"use client";

import { useActionState, useEffect, useOptimistic, useRef } from "react";
import { useRouter } from "next/navigation";

import { chatQuestionMaxLength } from "@studio-parallel/domain";

import { sendChatMessageAction, type ChatActionState } from "../app/(authenticated)/chat/actions";

/**
 * Asking one question.
 *
 * The question appears the moment it is sent, before the answer exists, because
 * the alternative is a form that empties itself and a screen that shows no sign
 * of having heard. It is rendered from optimistic state rather than left in the
 * textarea, so what a reader sees during the wait is the conversation they are
 * having rather than a form they are unsure they submitted.
 *
 * The wait is announced rather than only drawn. A reply takes seconds, the
 * pending row is visual, and a reader who cannot see it would otherwise have no
 * indication that anything is happening at all.
 */

const initialState: ChatActionState = Object.freeze({ message: "", status: "idle" });

export function ChatComposer({
  autoFocus = false,
  presetQuestion,
  sessionId,
}: Readonly<{ autoFocus?: boolean; presetQuestion?: string; sessionId: string }>) {
  const router = useRouter();
  const formRef = useRef<HTMLFormElement>(null);
  const fieldRef = useRef<HTMLTextAreaElement>(null);
  const [state, action, isPending] = useActionState(sendChatMessageAction, initialState);
  const [pendingQuestion, setPendingQuestion] = useOptimistic<string | null, string>(
    null,
    (_current, question) => question,
  );

  useEffect(() => {
    if (state.status === "idle") return;
    router.refresh();
    if (state.status === "success") fieldRef.current?.focus();
  }, [router, state]);

  return (
    <div className="chat-composer">
      {pendingQuestion === null ? null : (
        <div className="chat-message chat-message--user chat-message--pending">
          <p className="chat-message__speaker">You</p>
          <p>{pendingQuestion}</p>
        </div>
      )}

      <p aria-atomic="true" aria-live="polite" className="visually-hidden">
        {isPending ? "Waiting for an answer." : ""}
      </p>

      <form
        action={(formData) => {
          setPendingQuestion(String(formData.get("question") ?? ""));
          formRef.current?.reset();
          return action(formData);
        }}
        ref={formRef}
      >
        <input name="sessionId" type="hidden" value={sessionId} />
        <label className="chat-composer__label" htmlFor="chat-question">
          Ask about this account&rsquo;s strategy
        </label>
        <textarea
          autoFocus={autoFocus}
          className="chat-composer__field"
          defaultValue={presetQuestion ?? ""}
          id="chat-question"
          maxLength={chatQuestionMaxLength}
          name="question"
          ref={fieldRef}
          rows={3}
        />
        <div className="chat-composer__actions">
          <p className="chat-composer__hint">
            Answers come from this account&rsquo;s current strategy and the evidence behind it.
          </p>
          <button className="button button--primary" disabled={isPending} type="submit">
            {isPending ? "Asking…" : "Ask"}
          </button>
        </div>
      </form>

      <p
        aria-atomic="true"
        aria-live="polite"
        className={`chat-composer__status chat-composer__status--${state.status}`}
      >
        {state.message}
        {state.reference ? (
          <>
            {" "}
            Reference <code>{state.reference}</code>
          </>
        ) : null}
      </p>
    </div>
  );
}
