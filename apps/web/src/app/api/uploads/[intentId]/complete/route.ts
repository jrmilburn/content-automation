import { completeUploadRequestSchema } from "@studio-parallel/domain";
import { createWebRequestContext, reportError } from "@studio-parallel/observability";
import { headers } from "next/headers";

import { webErrorMonitor, webLogger } from "../../../../../lib/server/observability";
import { requireShellActor } from "../../../../../lib/server/shell-session";
import { uploadJson, uploadRefusal } from "../../../../../lib/server/upload-responses";
import { completeVideoUpload } from "../../../../../lib/server/video-upload";

export const dynamic = "force-dynamic";

/**
 * Finalises an upload into a pending-validation asset.
 *
 * `alreadyCompleted` is reported rather than hidden so a browser that retried
 * after a dropped response can tell the difference between having produced a
 * second asset (which cannot happen) and having found the first one.
 */
export async function POST(
  request: Request,
  segment: Readonly<{ params: Promise<Readonly<{ intentId: string }>> }>,
): Promise<Response> {
  const requestContext = createWebRequestContext(await headers());

  try {
    const actor = await requireShellActor();
    const { intentId } = await segment.params;
    let rawBody: unknown;

    try {
      rawBody = await request.json();
    } catch {
      return uploadJson({ reason: "INVALID_BODY" }, 400);
    }

    const parsed = completeUploadRequestSchema.safeParse(rawBody);

    if (!parsed.success) {
      // The body is echoed back only as a reason code; provider ETags and any
      // other supplied value stay out of the response and the logs.
      return uploadJson({ reason: "INVALID_BODY" }, 400);
    }

    const result = await completeVideoUpload({
      actor,
      correlationId: requestContext.correlationId,
      intentId,
      request: parsed.data,
    });

    if (!result.completed) {
      return uploadRefusal(result.reason, requestContext.correlationId);
    }

    return uploadJson(
      {
        alreadyCompleted: result.alreadyCompleted,
        assetId: result.assetId,
        bytes: result.bytes,
        state: "PENDING_VALIDATION",
      },
      result.alreadyCompleted ? 200 : 201,
    );
  } catch (error) {
    const reported = reportError(
      error,
      {
        correlationId: requestContext.correlationId,
        event: "video.upload.complete_failed",
        stage: "complete",
      },
      { logger: webLogger, monitor: webErrorMonitor },
    );

    return uploadJson(
      { reference: requestContext.correlationId },
      reported.statusCode >= 400 && reported.statusCode < 500 ? 403 : 500,
    );
  }
}
