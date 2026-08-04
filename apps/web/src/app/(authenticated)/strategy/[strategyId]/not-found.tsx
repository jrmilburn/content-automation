import { PageHeader } from "../../../../components/page-header";
import { ErrorSummary } from "../../../../components/states";

/**
 * Says nothing about whether the strategy exists elsewhere.
 *
 * A missing strategy and another workspace's read identically here, on purpose:
 * distinguishing them would let a crafted identifier confirm that something is
 * there to find.
 */
export default function StrategyNotFound() {
  return (
    <div className="page-stack">
      <PageHeader description="Strategy" title="Strategy not found" />
      <ErrorSummary
        action={{ href: "/strategy", label: "Back to the current strategy" }}
        description="No strategy is available at this address. It may never have existed, or it may belong to another workspace."
        title="Strategy not found"
      />
    </div>
  );
}
