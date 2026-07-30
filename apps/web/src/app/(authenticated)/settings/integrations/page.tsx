import { createWebRequestContext, reportError } from "@studio-parallel/observability";
import { headers } from "next/headers";

import { InstagramIntegrations } from "../../../../components/instagram-integration";
import { ErrorSummary } from "../../../../components/states";
import { PageHeader } from "../../../../components/page-header";
import { parseCallbackOutcome } from "../../../../lib/instagram-integration";
import { loadInstagramIntegrations } from "../../../../lib/server/integrations-data";
import { webErrorMonitor, webLogger } from "../../../../lib/server/observability";

export type IntegrationsSearchParams = Readonly<{ instagram?: string | string[] }>;

export default async function IntegrationsPage({
  searchParams,
}: Readonly<{ searchParams: Promise<IntegrationsSearchParams> }>) {
  const outcome = parseCallbackOutcome((await searchParams).instagram);

  try {
    const snapshot = await loadInstagramIntegrations();
    return <InstagramIntegrations outcome={outcome} snapshot={snapshot} />;
  } catch (error) {
    const requestContext = createWebRequestContext(await headers());
    reportError(
      error,
      {
        correlationId: requestContext.correlationId,
        event: "instagram.integrations.load_failed",
        stage: "settings",
      },
      { logger: webLogger, monitor: webErrorMonitor },
    );

    return (
      <div className="page-stack">
        <PageHeader
          description="Review connection health for authorised Instagram professional accounts."
          title="Instagram integration"
        />
        <ErrorSummary
          correlationId={requestContext.correlationId}
          description="Connection health is unavailable right now. No account was changed. Reload the page, and quote the reference below if it keeps failing."
          title="Integration status is unavailable"
        />
      </div>
    );
  }
}
