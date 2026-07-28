import type { ReactNode } from "react";

export function PageHeader({
  action,
  description,
  title,
}: Readonly<{ action?: ReactNode; description: string; title: string }>) {
  return (
    <header className="page-header">
      <div>
        <p className="page-location">Studio Parallel workspace</p>
        <h1>{title}</h1>
        <p className="page-description">{description}</p>
      </div>
      {action ? <div className="page-header__action">{action}</div> : null}
    </header>
  );
}
