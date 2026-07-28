import { SectionPlaceholder } from "../../../components/section-placeholder";

export default function SettingsPage() {
  return (
    <SectionPlaceholder
      description="Review safe operational configuration without exposing secret values."
      emptyDescription="Versioned safe settings will appear here as their owning features are delivered."
      emptyTitle="No editable settings available"
      title="Settings"
    />
  );
}
