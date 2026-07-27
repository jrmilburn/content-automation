import { createServiceHealth } from "@studio-parallel/domain";

import { loadRuntimeConfig } from "../../../lib/server/config";

export const dynamic = "force-dynamic";

export function GET(): Response {
  const config = loadRuntimeConfig();

  return Response.json(createServiceHealth("web", config.APP_ENV), {
    headers: {
      "cache-control": "no-store",
    },
  });
}
