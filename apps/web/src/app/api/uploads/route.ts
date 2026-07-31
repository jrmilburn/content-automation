import { createWebRequestContext, reportError } from "@studio-parallel/observability";
import { headers } from "next/headers";

import { webErrorMonitor, webLogger } from "../../../lib/server/observability";
import { requireShellActor } from "../../../lib/server/shell-session";
import { uploadJson, uploadRefusal } from "../../../lib/server/upload-responses";
import { initiateVideoUpload } from "../../../lib/server/video-upload";

export const dynamic = "force-dynamic";

type InitiateBody = Readonly<{
  contentType?: unknown;
  postId?: unknown;
  sizeBytes?: unknown;
}>;

/**
 * Reserves an upload for a post.
 *
 * The response carries the part plan and the intent id, never a bucket name,
 * object key or credential: the browser only ever learns what it needs to ask
 * for the next signature.
 */
export async function POST(request: Request): Promise<Response> {
  const requestContext = createWebRequestContext(await headers());

  try {
    const actor = await requireShellActor();
    let body: InitiateBody;

    try {
      body = (await request.json()) as InitiateBody;
    } catch {
      return uploadJson({ reason: "INVALID_BODY" }, 400);
    }

    const result = await initiateVideoUpload({
      actor,
      correlationId: requestContext.correlationId,
      declaredBytes: typeof body.sizeBytes === "number" ? body.sizeBytes : Number.NaN,
      declaredContentType: typeof body.contentType === "string" ? body.contentType : "",
      postId: typeof body.postId === "string" ? body.postId : "",
    });

    if (!result.initiated) {
      return uploadRefusal(result.reason, requestContext.correlationId);
    }

    return uploadJson(
      {
        expiresAt: result.expiresAt.toISOString(),
        intentId: result.intentId,
        partCount: result.partCount,
        partSizeBytes: result.partSizeBytes,
      },
      201,
    );
  } catch (error) {
    const reported = reportError(
      error,
      {
        correlationId: requestContext.correlationId,
        event: "video.upload.initiate_failed",
        stage: "initiate",
      },
      { logger: webLogger, monitor: webErrorMonitor },
    );

    return uploadJson(
      { reference: requestContext.correlationId },
      reported.statusCode >= 400 && reported.statusCode < 500 ? 403 : 500,
    );
  }
}
