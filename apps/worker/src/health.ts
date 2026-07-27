import { createServer, type RequestListener, type Server } from "node:http";

import { createServiceHealth } from "@studio-parallel/domain";

export function createHealthRequestListener(environment: string): RequestListener {
  return (request, response) => {
    if (request.method !== "GET" || request.url !== "/health") {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "not_found" }));
      return;
    }

    response.writeHead(200, {
      "cache-control": "no-store",
      "content-type": "application/json",
    });
    response.end(JSON.stringify(createServiceHealth("worker", environment)));
  };
}

export function createHealthServer(environment: string): Server {
  return createServer(createHealthRequestListener(environment));
}
