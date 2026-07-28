import { SectionPlaceholder } from "../../../components/section-placeholder";

export default function TrendsPage() {
  return (
    <SectionPlaceholder
      actionHref="/posts"
      actionLabel="Review posts"
      description="Compare creative features with compatible performance observations."
      emptyDescription="Trends require enough analysed posts with comparable metric snapshots. Missing evidence remains explicit."
      emptyTitle="Not enough comparable evidence"
      title="Trends"
    />
  );
}
