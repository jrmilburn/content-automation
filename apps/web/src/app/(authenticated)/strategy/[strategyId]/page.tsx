import type { StrategyDetail } from "@studio-parallel/db";
import { createWebRequestContext, reportError } from "@studio-parallel/observability";
import { headers } from "next/headers";
import { notFound } from "next/navigation";

import { StrategyDetailScreen, StrategyError } from "../../../../components/strategy";
import { webErrorMonitor, webLogger } from "../../../../lib/server/observability";
import { loadStrategyDetail } from "../../../../lib/server/strategy-data";

export default async function StrategyDetailPage({
  params,
}: Readonly<{ params: Promise<Readonly<{ strategyId: string }>> }>) {
  const { strategyId } = await params;

  let detail: StrategyDetail | null;
  try {
    detail = await loadStrategyDetail(strategyId);
  } catch (error) {
    const requestContext = createWebRequestContext(await headers());
    reportError(
      error,
      {
        correlationId: requestContext.correlationId,
        event: "strategy.detail.failed",
        stage: "strategy",
      },
      { logger: webLogger, monitor: webErrorMonitor },
    );
    return <StrategyError reference={requestContext.correlationId} />;
  }

  // Outside the catch, so the not-found signal is not swallowed as an error.
  if (!detail) notFound();

  return <StrategyDetailScreen detail={detail} />;
}
