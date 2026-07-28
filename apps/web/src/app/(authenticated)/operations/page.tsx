import { createWebRequestContext, reportError } from "@studio-parallel/observability";
import { headers } from "next/headers";

import { OperationsError, OperationsList } from "../../../components/job-diagnostics";
import { parseOperationsFilters, type OperationsSearchParams } from "../../../lib/job-diagnostics";
import { loadOperationsList } from "../../../lib/server/operations-data";
import { webErrorMonitor, webLogger } from "../../../lib/server/observability";

export default async function OperationsPage({
  searchParams,
}: Readonly<{ searchParams: Promise<OperationsSearchParams> }>) {
  const parsed = parseOperationsFilters(await searchParams);

  try {
    const snapshot = await loadOperationsList(parsed.filters);
    return <OperationsList snapshot={snapshot} values={parsed.values} />;
  } catch (error) {
    const requestContext = createWebRequestContext(await headers());
    reportError(
      error,
      {
        correlationId: requestContext.correlationId,
        event: "operations.list.failed",
        stage: "diagnostics",
      },
      { logger: webLogger, monitor: webErrorMonitor },
    );
    return <OperationsError reference={requestContext.correlationId} />;
  }
}
