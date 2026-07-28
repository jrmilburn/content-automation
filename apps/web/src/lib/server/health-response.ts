import "server-only";

import { createServiceHealth, type HealthKind } from "@studio-parallel/domain";
import { correlationHeaderName, createWebRequestContext } from "@studio-parallel/observability";

import { webLogger, webMetrics } from "./observability";

export function createWebHealthResponse(
  request: Request,
  kind: HealthKind,
  route: string,
): Response {
  const context = createWebRequestContext(request.headers);
  const attributes = {
    correlationId: context.correlationId,
    healthKind: kind,
    method: request.method,
    route,
    stage: "health",
    statusCode: 200,
  } as const;

  webLogger.info(`health.${kind}.checked`, attributes);
  webMetrics.increment("health.check.count", attributes);

  return Response.json(createServiceHealth("web", kind), {
    headers: {
      "cache-control": "no-store",
      [correlationHeaderName]: context.correlationId,
    },
  });
}
