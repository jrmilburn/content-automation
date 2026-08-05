import { createWebRequestContext, reportError } from "@studio-parallel/observability";
import { headers } from "next/headers";
import { notFound } from "next/navigation";

import { TrendDetailError, TrendDetailScreen } from "../../../../components/trends";
import { webErrorMonitor, webLogger } from "../../../../lib/server/observability";
import { loadTrendDetailSnapshot } from "../../../../lib/server/trends-data";
import { parseTrendsFilters, type TrendsSearchParams } from "../../../../lib/trends";

export default async function TrendDetailPage({
  params,
  searchParams,
}: Readonly<{
  params: Promise<{ statisticId: string }>;
  searchParams: Promise<TrendsSearchParams>;
}>) {
  const { statisticId } = await params;
  // The scope travels in the query so a shared link resolves the same
  // comparison. Without it a workspace with two accounts and a pooled run would
  // fall back to whichever scope is default and report the statistic as missing.
  const { filters } = parseTrendsFilters(await searchParams);
  let detail: Awaited<ReturnType<typeof loadTrendDetailSnapshot>>;

  try {
    detail = await loadTrendDetailSnapshot(statisticId, filters.instagramAccountId);
  } catch (error) {
    const requestContext = createWebRequestContext(await headers());
    reportError(
      error,
      {
        correlationId: requestContext.correlationId,
        event: "trends.detail.failed",
        stage: "analytics",
      },
      { logger: webLogger, monitor: webErrorMonitor },
    );
    return <TrendDetailError reference={requestContext.correlationId} />;
  }

  if (!detail) notFound();
  return <TrendDetailScreen detail={detail} />;
}
