import { createWebRequestContext, reportError } from "@studio-parallel/observability";
import { headers } from "next/headers";

import { StrategyError, StrategyScreen } from "../../../components/strategy";
import { webErrorMonitor, webLogger } from "../../../lib/server/observability";
import { loadStrategySnapshot } from "../../../lib/server/strategy-data";
import { parseStrategyScope, type StrategySearchParams } from "../../../lib/strategy";

export default async function StrategyPage({
  searchParams,
}: Readonly<{ searchParams: Promise<StrategySearchParams> }>) {
  const scope = parseStrategyScope(await searchParams);

  try {
    const snapshot = await loadStrategySnapshot(scope);
    return <StrategyScreen snapshot={snapshot} />;
  } catch (error) {
    const requestContext = createWebRequestContext(await headers());
    reportError(
      error,
      {
        correlationId: requestContext.correlationId,
        event: "strategy.load.failed",
        stage: "strategy",
      },
      { logger: webLogger, monitor: webErrorMonitor },
    );
    return <StrategyError reference={requestContext.correlationId} />;
  }
}
