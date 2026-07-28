import { createServer, type RequestListener, type Server } from "node:http";

import { createServiceHealth, type HealthKind } from "@studio-parallel/domain";
import {
  correlationHeaderName,
  createWebRequestContext,
  type JsonLogger,
  type MetricRecorder,
} from "@studio-parallel/observability";

type HealthDependencies = Readonly<{
  logger?: JsonLogger;
  metrics?: MetricRecorder;
}>;

export function createHealthRequestListener(
  dependencies: HealthDependencies = {},
): RequestListener {
  return (request, response) => {
    const route = request.url?.split("?", 1)[0];
    const kind = getHealthKind(route);

    if (request.method !== "GET" || !kind) {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "not_found" }));
      return;
    }

    const context = createWebRequestContext(request.headers);
    const attributes = {
      correlationId: context.correlationId,
      healthKind: kind,
      method: request.method,
      route: route ?? "/health",
      stage: "health",
      statusCode: 200,
    } as const;

    dependencies.logger?.info(`health.${kind}.checked`, attributes);
    dependencies.metrics?.increment("health.check.count", attributes);

    response.writeHead(200, {
      "cache-control": "no-store",
      "content-type": "application/json",
      [correlationHeaderName]: context.correlationId,
    });
    response.end(JSON.stringify(createServiceHealth("worker", kind)));
  };
}

export function createHealthServer(dependencies: HealthDependencies = {}): Server {
  return createServer(createHealthRequestListener(dependencies));
}

function getHealthKind(route: string | undefined): HealthKind | undefined {
  if (route === "/health" || route === "/health/live") return "live";
  if (route === "/health/ready") return "ready";
  return undefined;
}
