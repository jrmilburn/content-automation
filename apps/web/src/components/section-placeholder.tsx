import { EmptyState } from "./states";
import { PageHeader } from "./page-header";

export function SectionPlaceholder({
  actionHref,
  actionLabel,
  description,
  emptyDescription,
  emptyTitle,
  title,
}: Readonly<{
  actionHref?: string;
  actionLabel?: string;
  description: string;
  emptyDescription: string;
  emptyTitle: string;
  title: string;
}>) {
  const action = actionHref && actionLabel ? { href: actionHref, label: actionLabel } : undefined;

  return (
    <div className="page-stack">
      <PageHeader description={description} title={title} />
      <EmptyState
        description={emptyDescription}
        title={emptyTitle}
        {...(action ? { action } : {})}
      />
    </div>
  );
}
