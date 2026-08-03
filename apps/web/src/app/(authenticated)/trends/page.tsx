import { createWebRequestContext, reportError } from "@studio-parallel/observability";
import { headers } from "next/headers";

import { TrendsError, TrendsScreen } from "../../../components/trends";
import { webErrorMonitor, webLogger } from "../../../lib/server/observability";
import { loadTrendsSnapshot } from "../../../lib/server/trends-data";
import { parseTrendsFilters, type TrendsSearchParams } from "../../../lib/trends";

export default async function TrendsPage({
  searchParams,
}: Readonly<{ searchParams: Promise<TrendsSearchParams> }>) {
  const parsed = parseTrendsFilters(await searchParams);

  try {
    const snapshot = await loadTrendsSnapshot(parsed.filters);
    return <TrendsScreen snapshot={snapshot} values={parsed.values} />;
  } catch (error) {
    const requestContext = createWebRequestContext(await headers());
    reportError(
      error,
      {
        correlationId: requestContext.correlationId,
        event: "trends.list.failed",
        stage: "analytics",
      },
      { logger: webLogger, monitor: webErrorMonitor },
    );
    return <TrendsError reference={requestContext.correlationId} />;
  }
}
