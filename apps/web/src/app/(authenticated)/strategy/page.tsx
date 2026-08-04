import { createWebRequestContext, reportError } from "@studio-parallel/observability";
import { headers } from "next/headers";

import { StrategyError, StrategyScreen } from "../../../components/strategy";
import { webErrorMonitor, webLogger } from "../../../lib/server/observability";
import { loadStrategySnapshot } from "../../../lib/server/strategy-data";

export default async function StrategyPage() {
  try {
    const snapshot = await loadStrategySnapshot();
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
