import Link from "next/link";
import type { ReactNode } from "react";

import { StatusBadge } from "./status-badge";

type StateAction = Readonly<{ href: string; label: string }>;

function StateActionLink({ action }: Readonly<{ action?: StateAction }>) {
  return action ? (
    <Link className="button button--primary" href={action.href}>
      {action.label}
    </Link>
  ) : null;
}

export function LoadingState({ label }: Readonly<{ label: string }>) {
  return (
    <section aria-busy="true" aria-live="polite" className="state-panel state-panel--loading">
      <span className="visually-hidden">Loading {label}</span>
      <div aria-hidden="true" className="skeleton skeleton--title" />
      <div aria-hidden="true" className="skeleton skeleton--body" />
      <div aria-hidden="true" className="skeleton skeleton--body skeleton--short" />
    </section>
  );
}

export function EmptyState({
  action,
  description,
  title,
}: Readonly<{ action?: StateAction; description: string; title: string }>) {
  return (
    <section className="state-panel">
      <StatusBadge>Not yet available</StatusBadge>
      <h2>{title}</h2>
      <p>{description}</p>
      <StateActionLink {...(action ? { action } : {})} />
    </section>
  );
}

export function PartialState({
  action,
  available,
  missing,
  title,
}: Readonly<{
  action?: StateAction;
  available: ReactNode;
  missing: string;
  title: string;
}>) {
  return (
    <section className="state-panel state-panel--partial">
      <StatusBadge tone="warning">Partial data</StatusBadge>
      <h2>{title}</h2>
      <div>{available}</div>
      <p>
        <strong>Still unavailable:</strong> {missing}
      </p>
      <StateActionLink {...(action ? { action } : {})} />
    </section>
  );
}

export function ErrorSummary({
  action,
  correlationId,
  description,
  headingLevel = 2,
  title,
}: Readonly<{
  action?: StateAction;
  correlationId?: string;
  description: string;
  headingLevel?: 1 | 2;
  title: string;
}>) {
  const Heading = headingLevel === 1 ? "h1" : "h2";

  return (
    <section aria-live="polite" className="state-panel state-panel--error" tabIndex={-1}>
      <StatusBadge tone="danger">Action needed</StatusBadge>
      <Heading {...(headingLevel === 1 ? { tabIndex: -1 } : {})}>{title}</Heading>
      <p>{description}</p>
      {correlationId ? (
        <p className="state-panel__reference">
          Reference <code>{correlationId}</code>
        </p>
      ) : null}
      <StateActionLink {...(action ? { action } : {})} />
    </section>
  );
}

export function StatusMessage({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <p aria-atomic="true" aria-live="polite" className="status-message">
      {children}
    </p>
  );
}
