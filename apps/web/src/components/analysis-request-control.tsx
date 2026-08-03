"use client";

import { useRouter } from "next/navigation";
import { useActionState, useEffect } from "react";

import {
  requestAnalysisAction,
  type AnalysisActionState,
} from "../app/(authenticated)/posts/[postId]/source-video/actions";

const initialState: AnalysisActionState = Object.freeze({ message: "", status: "idle" });

/**
 * Asks for one post's source video to be analysed.
 *
 * The copy says the analysis was queued rather than produced, because the
 * worker owns it and may not even be running. Claiming a result existed would
 * be the one misleading thing this control could do — the same reason the
 * Instagram sync control says "queued".
 */
export function AnalysisRequestControl({ postId }: Readonly<{ postId: string }>) {
  const router = useRouter();
  const [state, action, isPending] = useActionState(requestAnalysisAction, initialState);

  useEffect(() => {
    if (state.status !== "idle") router.refresh();
  }, [router, state]);

  return (
    <div className="analysis-request">
      <form action={action}>
        <input name="postId" type="hidden" value={postId} />
        <button className="button button--secondary" disabled={isPending} type="submit">
          {isPending ? "Requesting analysis…" : "Analyse this video"}
        </button>
      </form>
      {state.status === "idle" ? null : (
        <p
          aria-atomic="true"
          aria-live="polite"
          className={`analysis-request__status analysis-request__status--${state.status}`}
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
