import { createWebRequestContext, reportError } from "@studio-parallel/observability";
import { headers } from "next/headers";

import { webErrorMonitor, webLogger } from "../../../../../lib/server/observability";
import { requireShellActor } from "../../../../../lib/server/shell-session";
import { uploadJson, uploadRefusal } from "../../../../../lib/server/upload-responses";
import { abortVideoUpload } from "../../../../../lib/server/video-upload";

export const dynamic = "force-dynamic";

/**
 * Abandons an upload the user cancelled.
 *
 * Aborting is best-effort by design: if the provider call fails the intent is
 * still closed locally and the scheduled sweep releases the parts later, so a
 * user who cancels is never left with an upload they cannot restart.
 */
export async function POST(
  _request: Request,
  segment: Readonly<{ params: Promise<Readonly<{ intentId: string }>> }>,
): Promise<Response> {
  const requestContext = createWebRequestContext(await headers());

  try {
    const actor = await requireShellActor();
    const { intentId } = await segment.params;
    const result = await abortVideoUpload({
      actor,
      correlationId: requestContext.correlationId,
      intentId,
    });

    if (!result.aborted) {
      return uploadRefusal(result.reason, requestContext.correlationId);
    }

    return uploadJson({ alreadyClosed: result.alreadyClosed }, 200);
  } catch (error) {
    const reported = reportError(
      error,
      {
        correlationId: requestContext.correlationId,
        event: "video.upload.abort_failed",
        stage: "abort",
      },
      { logger: webLogger, monitor: webErrorMonitor },
    );

    return uploadJson(
      { reference: requestContext.correlationId },
      reported.statusCode >= 400 && reported.statusCode < 500 ? 403 : 500,
    );
  }
}
