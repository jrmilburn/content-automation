"use server";

import { createWebRequestContext, reportError } from "@studio-parallel/observability";
import { revalidatePath } from "next/cache";
import { headers } from "next/headers";

import {
  requestAnalysisForPost,
  type AnalysisRequestResult,
} from "../../../../../lib/server/analysis-request";
import { webErrorMonitor, webLogger } from "../../../../../lib/server/observability";
import { requireShellActor } from "../../../../../lib/server/shell-session";

/**
 * Requesting an analysis from the source-video page.
 *
 * Every outcome is reported in product language. The worker owns the analysis
 * and may not be running, so nothing here claims a result exists — only that
 * the request was accepted, which is the same reason the sync control says
 * "queued" rather than "synced".
 */

export type AnalysisActionState = Readonly<{
  message: string;
  reference?: string;
  status: "error" | "idle" | "success";
}>;

const refusalMessages: Readonly<Record<string, string>> = Object.freeze({
  asset_not_ready:
    "The video has not finished being checked yet. Reload this page once the check completes, then try again.",
  no_source_video: "This post has no source video to analyse. Upload one first.",
  post_not_found: "This post is unavailable in the current workspace.",
});

export async function requestAnalysisAction(
  _previous: AnalysisActionState,
  formData: FormData,
): Promise<AnalysisActionState> {
  const requestContext = createWebRequestContext(await headers());
  const rawPostId = formData.get("postId");
  const postId = typeof rawPostId === "string" ? rawPostId : "";

  try {
    const actor = await requireShellActor();
    const result = await requestAnalysisForPost(actor, {
      correlationId: requestContext.correlationId,
      postId,
    });

    revalidatePath(`/posts/${postId}/source-video`);
    return describeResult(result);
  } catch (error) {
    reportError(
      error,
      {
        correlationId: requestContext.correlationId,
        event: "analysis.request_failed",
        stage: "analysis_request",
      },
      { logger: webLogger, monitor: webErrorMonitor },
    );

    return Object.freeze({
      message:
        "The analysis could not be requested. Nothing was changed. Try again, and contact an administrator if it keeps failing.",
      reference: requestContext.correlationId,
      status: "error" as const,
    });
  }
}

function describeResult(result: AnalysisRequestResult): AnalysisActionState {
  if (!result.queued) {
    return Object.freeze({
      message: refusalMessages[result.reason] ?? "This video cannot be analysed yet.",
      status: "error" as const,
    });
  }

  return Object.freeze({
    message: result.alreadyRequested
      ? "This video has already been queued for analysis. It will not be analysed twice."
      : "Analysis queued. It runs in the background and can take several minutes.",
    status: "success" as const,
  });
}
