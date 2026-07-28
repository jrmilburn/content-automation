import { SectionPlaceholder } from "../../../components/section-placeholder";

export default function AccountsPage() {
  return (
    <SectionPlaceholder
      description="Configure authorised professional accounts and review connection health."
      emptyDescription="Account connection and token-health controls will appear here when the Instagram integration is available."
      emptyTitle="No Instagram accounts configured"
      title="Instagram accounts"
    />
  );
}
