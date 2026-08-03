import Link from "next/link";

import { PageHeader } from "../../../../components/page-header";
import { ErrorSummary } from "../../../../components/states";

export default function TrendNotFound() {
  return (
    <div className="page-stack">
      <PageHeader
        action={
          <Link className="button button--secondary" href="/trends">
            Back to all trends
          </Link>
        }
        description="Evidence behind one comparison."
        title="Trend evidence"
      />
      <ErrorSummary
        action={{ href: "/trends", label: "Return to trends" }}
        description="This comparison is not part of the account's published calculation. A later calculation may have replaced it, or it belongs to another workspace. No data was disclosed."
        title="Comparison not available"
      />
    </div>
  );
}
