import { loadAuthConfig } from "@studio-parallel/config";
import { isAllowedRequestOrigin } from "@studio-parallel/domain";
import type { NextRequest } from "next/server";

import { handlers } from "../../../../auth";

export function GET(request: NextRequest): Promise<Response> | Response {
  const config = loadAuthConfig();

  if (!isAllowedRequestOrigin(request.url, config.PUBLIC_ORIGIN)) {
    return invalidRequest();
  }

  return handlers.GET(request);
}

export function POST(request: NextRequest): Promise<Response> | Response {
  const config = loadAuthConfig();

  if (
    !isAllowedRequestOrigin(request.url, config.PUBLIC_ORIGIN) ||
    !isAllowedRequestOrigin(request.headers.get("origin"), config.PUBLIC_ORIGIN)
  ) {
    return invalidRequest();
  }

  return handlers.POST(request);
}

function invalidRequest(): Response {
  return Response.json({ error: "invalid_request" }, { status: 403 });
}
