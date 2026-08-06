"use client";

import { useRouter } from "next/navigation";
import { useActionState, useEffect } from "react";

import {
  requestStrategyAction,
  type StrategyActionState,
} from "../app/(authenticated)/strategy/actions";

/**
 * Asks for a strategy, and names which kind is about to be made.
 *
 * The button says "exploratory" when that is what pressing it produces, because
 * the two documents look alike and mean different things; a reader who agreed
 * to "generate a strategy" and received an exploratory one would have no way to
 * tell from the page that they had. The panel above states what the mode means
 * before the button is reached.
 *
 * `acceptExploratory` travels as a hidden field mirroring the previewed mode
 * rather than as a free choice. It is confirmation of what was shown, not an
 * instruction, and the command re-derives the mode from the evidence anyway.
 *
 * The scope travels the same way and for the same reason: it is the scope the
 * counts above describe, so the request is made against what the reader was
 * shown rather than against whatever the page would default to a moment later.
 */

const initialState: StrategyActionState = Object.freeze({ message: "", status: "idle" });

export function StrategyRequestControl({
  exploratory,
  scope,
}: Readonly<{ exploratory: boolean; scope: string }>) {
  const router = useRouter();
  const [state, action, isPending] = useActionState(requestStrategyAction, initialState);

  useEffect(() => {
    if (state.status !== "idle") router.refresh();
  }, [router, state]);

  return (
    <div className="strategy-request__control">
      <form action={action}>
        <input name="accountId" type="hidden" value={scope} />
        <input name="acceptExploratory" type="hidden" value={String(exploratory)} />
        <button className="button button--primary" disabled={isPending} type="submit">
          {isPending
            ? "Requesting…"
            : exploratory
              ? "Generate an exploratory strategy"
              : "Generate a strategy"}
        </button>
      </form>
      <p
        aria-atomic="true"
        aria-live="polite"
        className={`strategy-request__status strategy-request__status--${state.status}`}
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
