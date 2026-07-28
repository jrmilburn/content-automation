import { SectionPlaceholder } from "../../components/section-placeholder";

export default function DashboardPage() {
  return (
    <SectionPlaceholder
      actionHref="/accounts"
      actionLabel="Open Instagram accounts"
      description="See workspace readiness and the safest next step."
      emptyDescription="Connect an approved professional account before posts, trends and strategy can populate."
      emptyTitle="No Instagram account is connected"
      title="Dashboard"
    />
  );
}
