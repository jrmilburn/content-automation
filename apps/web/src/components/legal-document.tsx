import Link from "next/link";
import type { ReactNode } from "react";

/**
 * Frame for the publicly readable legal documents. These pages are reachable
 * without a session, so they deliberately carry no workspace navigation and
 * read nothing from the database.
 */
export function LegalDocument({
  children,
  lastUpdated,
  summary,
  title,
}: Readonly<{
  children: ReactNode;
  lastUpdated: string;
  summary: string;
  title: string;
}>) {
  return (
    <main className="legal-page">
      <article className="legal-document">
        <header className="legal-document__header">
          <Link className="legal-brand" href="/login">
            <span aria-hidden="true">SP</span>
            Studio Parallel
          </Link>
          <p className="page-location">Studio Parallel Content Intelligence</p>
          <h1>{title}</h1>
          <p className="legal-summary">{summary}</p>
          <p className="legal-updated">
            Last updated <time dateTime={lastUpdated}>{formatUpdatedDate(lastUpdated)}</time>
          </p>
        </header>
        {children}
      </article>
      <LegalFooter />
    </main>
  );
}

export function LegalFooter() {
  return (
    <footer className="legal-footer">
      <LegalLinks />
      <p>Studio Parallel Content Intelligence is an internal tool, not a public service.</p>
    </footer>
  );
}

/**
 * Compact links for the sign-in and access-denied pages, which use their own
 * layouts and cannot take a full-width footer without disturbing them.
 */
export function LegalLinks() {
  return (
    <nav aria-label="Legal documents" className="legal-links">
      <Link href="/privacy">Privacy policy</Link>
      <Link href="/terms">Terms of use</Link>
    </nav>
  );
}

/**
 * Marks wording that still needs an owner or legal decision. It is rendered
 * visibly so a document cannot be published while a decision is outstanding.
 */
export function PendingDetail({ children }: Readonly<{ children: string }>) {
  return (
    <mark className="legal-pending" title="This detail is not yet confirmed.">
      {children}
    </mark>
  );
}

function formatUpdatedDate(isoDate: string): string {
  return new Date(`${isoDate}T00:00:00Z`).toLocaleDateString("en-AU", {
    day: "numeric",
    month: "long",
    timeZone: "UTC",
    year: "numeric",
  });
}
