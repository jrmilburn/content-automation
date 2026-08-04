"use server";

import { createWorkspaceContext, requestStrategyGeneration } from "@studio-parallel/db";
import { headers } from "next/headers";
import { revalidatePath } from "next/cache";

import { describeStrategyRefusal, strategyPrimaryMetric } from "../../../lib/strategy";
import { getDatabase } from "../../../lib/server/database";
import { requireShellActor } from "../../../lib/server/shell-session";
import { webErrorMonitor, webLogger } from "../../../lib/server/observability";
import { createWebRequestContext, reportError } from "@studio-parallel/observability";

/**
 * Asking for one strategy.
 *
 * The account arrives in the form, so it is never trusted: the workspace comes
 * from the session and the command resolves the account inside that workspace,
 * which turns another workspace's id into the same "no such account" refusal a
 * nonexistent one gets. The form decides which of the reader's own accounts to
 * spend a provider call on, and nothing more.
 *
 * The metric is not in the form at all. A caller able to name it could ask for
 * a strategy built on a measure the preview never showed, so it is fixed to the
 * same constant the preview reads.
 */

export type StrategyActionState = Readonly<{
  message: string;
  reference?: string;
  status: "error" | "idle" | "success";
}>;

export async function requestStrategyAction(
  _previous: StrategyActionState,
  formData: FormData,
): Promise<StrategyActionState> {
  const requestContext = createWebRequestContext(await headers());
  const acceptExploratory = formData.get("acceptExploratory") === "true";
  const accountId = String(formData.get("accountId") ?? "");

  try {
    const actor = await requireShellActor();
    const outcome = await requestStrategyGeneration(
      getDatabase(),
      createWorkspaceContext(actor.workspaceId),
      {
        acceptExploratory,
        correlationId: requestContext.correlationId,
        editorialConstraint: null,
        formatEmphasis: [],
        instagramAccountId: accountId,
        pillarEmphasis: [],
        primaryMetric: strategyPrimaryMetric,
        requestedByUserId: actor.internalUserId,
      },
    );

    revalidatePath("/strategy");

    if (!outcome.requested) {
      return Object.freeze({
        message:
          describeStrategyRefusal(outcome.reason) ?? "This account cannot generate a strategy yet.",
        status: "error" as const,
      });
    }

    return Object.freeze({
      message: outcome.created
        ? "Generating. This page does not update on its own — reload it to see the result."
        : "That strategy was already requested. Reload to see its result.",
      status: "success" as const,
    });
  } catch (error) {
    reportError(
      error,
      {
        correlationId: requestContext.correlationId,
        event: "strategy.request.failed",
        stage: "strategy",
      },
      { logger: webLogger, monitor: webErrorMonitor },
    );

    return Object.freeze({
      message: "The request could not be made. Nothing was generated.",
      reference: requestContext.correlationId,
      status: "error" as const,
    });
  }
}
