import { createWebHealthResponse } from "../../../lib/server/health-response";

export const dynamic = "force-dynamic";

export function GET(request: Request): Response {
  return createWebHealthResponse(request, "live", "/health/live");
}
