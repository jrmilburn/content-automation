import { SectionPlaceholder } from "../../../components/section-placeholder";

export default function StrategyPage() {
  return (
    <SectionPlaceholder
      actionHref="/trends"
      actionLabel="Review trends"
      description="Inspect current and historical evidence-linked strategy."
      emptyDescription="A strategy can be generated after the workspace has a bounded set of eligible evidence."
      emptyTitle="No strategy generated"
      title="Strategy"
    />
  );
}
