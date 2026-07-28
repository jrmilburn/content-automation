import { createHash, timingSafeEqual } from "node:crypto";

import { ConfigurationError, loadMetaWebhookConfig } from "@studio-parallel/config";

const responseHeaders = {
  "Cache-Control": "no-store, max-age=0",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
} as const;

const challengePattern = /^[0-9]{1,64}$/u;

export const dynamic = "force-dynamic";

function emptyResponse(status: 403 | 501 | 503): Response {
  return new Response(null, { headers: responseHeaders, status });
}

function tokensMatch(providedToken: string, configuredToken: string): boolean {
  const providedDigest = createHash("sha256").update(providedToken, "utf8").digest();
  const configuredDigest = createHash("sha256").update(configuredToken, "utf8").digest();

  return timingSafeEqual(providedDigest, configuredDigest);
}

export function GET(request: Request): Response {
  let configuredToken: string;

  try {
    configuredToken = loadMetaWebhookConfig().META_WEBHOOK_VERIFY_TOKEN;
  } catch (error) {
    if (error instanceof ConfigurationError) return emptyResponse(503);
    throw error;
  }

  const searchParameters = new URL(request.url).searchParams;
  const mode = searchParameters.get("hub.mode");
  const providedToken = searchParameters.get("hub.verify_token");
  const challenge = searchParameters.get("hub.challenge");

  if (
    mode !== "subscribe" ||
    providedToken === null ||
    challenge === null ||
    !challengePattern.test(challenge) ||
    !tokensMatch(providedToken, configuredToken)
  ) {
    return emptyResponse(403);
  }

  return new Response(challenge, {
    headers: {
      ...responseHeaders,
      "Content-Type": "text/plain; charset=utf-8",
    },
    status: 200,
  });
}

/** Event delivery remains disabled until payload signatures and replay controls are implemented. */
export function POST(): Response {
  return emptyResponse(501);
}
