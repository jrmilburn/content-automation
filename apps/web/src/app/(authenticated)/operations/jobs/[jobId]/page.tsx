import { createWebRequestContext, reportError } from "@studio-parallel/observability";
import { headers } from "next/headers";
import Link from "next/link";
import { notFound } from "next/navigation";

import { JobDetail } from "../../../../../components/job-diagnostics";
import { PageHeader } from "../../../../../components/page-header";
import { ErrorSummary } from "../../../../../components/states";
import { loadOperationsDetail } from "../../../../../lib/server/operations-data";
import { webErrorMonitor, webLogger } from "../../../../../lib/server/observability";

export default async function JobDetailPage({
  params,
}: Readonly<{ params: Promise<{ jobId: string }> }>) {
  const { jobId } = await params;
  let job: Awaited<ReturnType<typeof loadOperationsDetail>>;

  try {
    job = await loadOperationsDetail(jobId);
  } catch (error) {
    const requestContext = createWebRequestContext(await headers());
    reportError(
      error,
      {
        correlationId: requestContext.correlationId,
        event: "operations.detail.failed",
        stage: "diagnostics",
      },
      { logger: webLogger, monitor: webErrorMonitor },
    );
    return (
      <div className="page-stack job-detail-page">
        <PageHeader
          action={
            <Link className="button button--secondary" href="/operations">
              Back to jobs
            </Link>
          }
          description="Safe diagnostic record"
          title="Job detail"
        />
        <ErrorSummary
          action={{ href: `/operations/jobs/${jobId}`, label: "Try again" }}
          correlationId={requestContext.correlationId}
          description="This job could not be loaded. Existing workspace data is unchanged and remains safe."
          title="Job detail did not load"
        />
      </div>
    );
  }

  if (!job) notFound();
  return <JobDetail generatedAt={new Date().toISOString()} job={job} />;
}
