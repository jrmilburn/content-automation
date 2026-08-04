"use server";

import { createWebRequestContext, reportError } from "@studio-parallel/observability";
import { revalidatePath } from "next/cache";
import { headers } from "next/headers";

import {
  requestAnalysisForPost,
  type AnalysisRequestResult,
} from "../../../../../lib/server/analysis-request";
import {
  requestInstagramMediaImport,
  type MediaImportRefusalReason,
  type MediaImportResult,
} from "../../../../../lib/server/instagram-media-import";
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

const importRefusalMessages: Readonly<Record<MediaImportRefusalReason, string>> = Object.freeze({
  ALREADY_HAS_SOURCE: "This post already has a source video. Replacing it is a separate action.",
  NOT_A_VIDEO: "This post is not a video, so there is nothing to bring across.",
  POST_NOT_FOUND: "This post is unavailable in the current workspace.",
  RATE_LIMITED: "Too many videos have been requested recently. Wait a few minutes and try again.",
});

/**
 * Bringing the post's own Instagram video across as its source.
 *
 * Says "queued" for the same reason every other control on this page does: the
 * worker owns the transfer and may not be running, so claiming the video had
 * arrived would be the one misleading thing this control could say.
 */
export async function importInstagramVideoAction(
  _previous: AnalysisActionState,
  formData: FormData,
): Promise<AnalysisActionState> {
  const requestContext = createWebRequestContext(await headers());
  const rawPostId = formData.get("postId");
  const postId = typeof rawPostId === "string" ? rawPostId : "";

  try {
    const actor = await requireShellActor();
    const result = await requestInstagramMediaImport({
      actor,
      correlationId: requestContext.correlationId,
      postId,
    });

    revalidatePath(`/posts/${postId}/source-video`);
    return describeImport(result);
  } catch (error) {
    reportError(
      error,
      {
        correlationId: requestContext.correlationId,
        event: "instagram.media_import.request_failed",
        stage: "media_import_request",
      },
      { logger: webLogger, monitor: webErrorMonitor },
    );

    return Object.freeze({
      message:
        "The video could not be requested. Nothing was changed. Try again, and contact an administrator if it keeps failing.",
      reference: requestContext.correlationId,
      status: "error" as const,
    });
  }
}

function describeImport(result: MediaImportResult): AnalysisActionState {
  if (!result.queued) {
    return Object.freeze({
      message: importRefusalMessages[result.reason],
      status: "error" as const,
    });
  }

  return Object.freeze({
    message:
      "Getting the video from Instagram. It is copied in the background and then checked, which usually takes a minute. Reload this page to see it.",
    status: "success" as const,
  });
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
