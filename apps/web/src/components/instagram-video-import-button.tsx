"use client";

import { useRouter } from "next/navigation";
import { useActionState, useEffect } from "react";

import {
  importInstagramVideoAction,
  type AnalysisActionState,
} from "../app/(authenticated)/posts/[postId]/source-video/actions";

const initialState: AnalysisActionState = Object.freeze({ message: "", status: "idle" });

/**
 * The button that brings one post's Instagram video across, on its own.
 *
 * Separated from the explanatory card around it because the posts list repeats
 * this control once per row, where that card's heading and copy would be
 * duplicated twenty-four times over — and its heading carries an id, so the
 * repetition would break the accessible name of every one of them.
 *
 * `context` names the post the button belongs to. On the source-video page the
 * page itself is the context and there is nothing to add; in a list every button
 * reads "Use the Instagram video" and nothing else tells them apart.
 */
export function InstagramVideoImportButton({
  context,
  postId,
}: Readonly<{ context?: string; postId: string }>) {
  const router = useRouter();
  const [state, action, isPending] = useActionState(importInstagramVideoAction, initialState);

  useEffect(() => {
    if (state.status !== "idle") router.refresh();
  }, [router, state]);

  return (
    <>
      <form action={action}>
        <input name="postId" type="hidden" value={postId} />
        <button className="button button--secondary" disabled={isPending} type="submit">
          {isPending ? "Requesting video…" : "Use the Instagram video"}
          {context ? <span className="visually-hidden"> {context}</span> : null}
        </button>
      </form>
      {state.status === "idle" ? null : (
        <p
          aria-atomic="true"
          aria-live="polite"
          className={`video-import__status video-import__status--${state.status}`}
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
    </>
  );
}
