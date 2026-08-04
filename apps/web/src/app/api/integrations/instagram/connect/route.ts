import { headers } from "next/headers";

import { loadRuntimeConfig } from "@studio-parallel/config";
import { instagramStateCookieName } from "@studio-parallel/domain";
import { createWebRequestContext, reportError } from "@studio-parallel/observability";

import {
  connectionAttemptWindowSeconds,
  startInstagramConnection,
} from "../../../../../lib/server/instagram-connection";
import { webErrorMonitor, webLogger } from "../../../../../lib/server/observability";
import { requireAdminActor } from "../../../../../lib/server/session";

const responseHeaders = {
  "Cache-Control": "no-store, max-age=0",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
} as const;

export const dynamic = "force-dynamic";

function emptyResponse(status: number, extra: Readonly<Record<string, string>> = {}): Response {
  return new Response(null, { headers: { ...responseHeaders, ...extra }, status });
}

/**
 * Reads the account a reconnect was started from, when the form carried one.
 *
 * A body that is absent or is not a form is not an error: connecting an
 * additional account posts the same form with no account at all.
 */
async function readReconnectAccountId(request: Request): Promise<string | null> {
  try {
    const submitted = (await request.formData()).get("accountId");
    return typeof submitted === "string" && submitted.length > 0 ? submitted : null;
  } catch {
    return null;
  }
}

/**
 * Starts Business Login for an authorised admin.
 *
 * POST only, so the redirect cannot be triggered by a cross-site link or an
 * image tag. The pending state is returned in an httpOnly, host-locked cookie
 * bound to the initiating admin; nothing about the provider request is echoed
 * into the response body.
 *
 * The same endpoint serves connecting an additional account and reconnecting an
 * existing one. The difference is the submitted account: a reconnect binds the
 * attempt to that account, and the callback refuses any other.
 */
export async function POST(request: Request): Promise<Response> {
  const requestContext = createWebRequestContext(await headers());

  try {
    const actor = await requireAdminActor();
    const result = await startInstagramConnection({
      actor,
      correlationId: requestContext.correlationId,
      reconnectAccountId: await readReconnectAccountId(request),
    });

    if (!result.started) {
      return result.reason === "ACCOUNT_NOT_FOUND"
        ? emptyResponse(404)
        : emptyResponse(429, { "Retry-After": String(connectionAttemptWindowSeconds) });
    }

    const secure = new URL(loadRuntimeConfig().PUBLIC_ORIGIN).protocol === "https:";
    const cookie = [
      `${instagramStateCookieName(secure)}=${result.sealedState}`,
      "Path=/",
      "HttpOnly",
      "SameSite=Lax",
      `Max-Age=${result.cookieMaxAgeSeconds}`,
      ...(secure ? ["Secure"] : []),
    ].join("; ");

    // 303 so the browser follows with GET regardless of this POST.
    return emptyResponse(303, { "Set-Cookie": cookie, Location: result.authorizeUrl });
  } catch (error) {
    const reported = reportError(
      error,
      {
        correlationId: requestContext.correlationId,
        event: "instagram.connect",
        stage: "initiate",
      },
      { logger: webLogger, monitor: webErrorMonitor },
    );

    // A denied caller and an under-privileged caller both get 403.
    return emptyResponse(reported.statusCode >= 400 && reported.statusCode < 500 ? 403 : 500);
  }
}
