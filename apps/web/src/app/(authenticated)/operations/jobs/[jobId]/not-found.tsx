import Link from "next/link";

import { PageHeader } from "../../../../../components/page-header";
import { ErrorSummary } from "../../../../../components/states";

export default function JobNotFound() {
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
        action={{ href: "/operations", label: "Return to jobs" }}
        description="This job is unavailable in the current workspace. No diagnostic data was disclosed."
        title="Job not found"
      />
    </div>
  );
}
