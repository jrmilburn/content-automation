import { createWebRequestContext, reportError } from "@studio-parallel/observability";
import { headers } from "next/headers";

import { webErrorMonitor, webLogger } from "../../../../../../lib/server/observability";
import { requireShellActor } from "../../../../../../lib/server/shell-session";
import { uploadJson, uploadRefusal } from "../../../../../../lib/server/upload-responses";
import { signVideoUploadPart } from "../../../../../../lib/server/video-upload";

export const dynamic = "force-dynamic";

/**
 * Issues one short-lived signature for one part.
 *
 * Signing is a POST rather than a GET because it is not cacheable and must not
 * land in browser history or a proxy log: the returned URL is the credential
 * for that part.
 */
export async function POST(
  _request: Request,
  segment: Readonly<{ params: Promise<Readonly<{ intentId: string; partNumber: string }>> }>,
): Promise<Response> {
  const requestContext = createWebRequestContext(await headers());

  try {
    const actor = await requireShellActor();
    const { intentId, partNumber } = await segment.params;
    const result = await signVideoUploadPart({
      actor,
      correlationId: requestContext.correlationId,
      intentId,
      // A non-numeric segment becomes NaN and is refused by the range check
      // rather than reaching the provider.
      partNumber: /^[0-9]{1,5}$/u.test(partNumber) ? Number(partNumber) : Number.NaN,
    });

    if (!result.signed) {
      return uploadRefusal(result.reason, requestContext.correlationId);
    }

    return uploadJson(
      {
        expiresAt: result.expiresAt.toISOString(),
        partNumber: result.partNumber,
        url: result.url,
      },
      200,
    );
  } catch (error) {
    const reported = reportError(
      error,
      {
        correlationId: requestContext.correlationId,
        event: "video.upload.sign_part_failed",
        stage: "sign_part",
      },
      { logger: webLogger, monitor: webErrorMonitor },
    );

    return uploadJson(
      { reference: requestContext.correlationId },
      reported.statusCode >= 400 && reported.statusCode < 500 ? 403 : 500,
    );
  }
}
