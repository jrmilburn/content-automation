import { SectionPlaceholder } from "../../../components/section-placeholder";

export default function PostsPage() {
  return (
    <SectionPlaceholder
      actionHref="/accounts"
      actionLabel="Review Instagram accounts"
      description="Find imported posts and triage source, analysis and attention state."
      emptyDescription="Posts will appear after an Instagram account is connected and its first sync completes."
      emptyTitle="No posts imported"
      title="Posts"
    />
  );
}
