import { headers } from "next/headers";

import { loadRuntimeConfig } from "@studio-parallel/config";
import { instagramStateCookieName } from "@studio-parallel/domain";
import { createWebRequestContext, reportError } from "@studio-parallel/observability";

import { completeInstagramConnection } from "../../../../../lib/server/instagram-connection";
import { webErrorMonitor, webLogger } from "../../../../../lib/server/observability";
import { requireAdminActor } from "../../../../../lib/server/session";

const callbackHeaders = {
  "Cache-Control": "no-store, max-age=0",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
} as const;

export const dynamic = "force-dynamic";

/**
 * Completes Business Login.
 *
 * Nothing supplied by the provider is reflected: the response is a redirect to a
 * fixed internal location carrying only a coarse outcome, so a crafted callback
 * cannot echo attacker text back to the browser. The state cookie is cleared on
 * every path, which is what makes a captured state single-use.
 */
export async function GET(request: Request): Promise<Response> {
  const requestContext = createWebRequestContext(await headers());
  const secure = new URL(loadRuntimeConfig().PUBLIC_ORIGIN).protocol === "https:";
  const cookieName = instagramStateCookieName(secure);

  const clearedCookie = [
    `${cookieName}=`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=0",
    ...(secure ? ["Secure"] : []),
  ].join("; ");

  const settle = (outcome: "connected" | "failed"): Response =>
    new Response(null, {
      headers: {
        ...callbackHeaders,
        "Set-Cookie": clearedCookie,
        Location: `/settings/integrations?instagram=${outcome}`,
      },
      status: 303,
    });

  try {
    const actor = await requireAdminActor();
    const url = new URL(request.url);

    // Read the sealed cookie directly from the request so the handler stays
    // testable without a Next.js cookie store.
    const sealedState = readCookie(request.headers.get("cookie"), cookieName);

    const result = await completeInstagramConnection({
      actor,
      code: url.searchParams.get("code"),
      correlationId: requestContext.correlationId,
      providerError: url.searchParams.get("error"),
      receivedState: url.searchParams.get("state"),
      sealedState,
    });

    return settle(result.connected ? "connected" : "failed");
  } catch (error) {
    reportError(
      error,
      {
        correlationId: requestContext.correlationId,
        event: "instagram.callback",
        stage: "complete",
      },
      { logger: webLogger, monitor: webErrorMonitor },
    );

    return settle("failed");
  }
}

function readCookie(header: string | null, name: string): string | null {
  if (!header) return null;

  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator <= 0) continue;
    if (part.slice(0, separator).trim() !== name) continue;
    return part.slice(separator + 1).trim() || null;
  }

  return null;
}
