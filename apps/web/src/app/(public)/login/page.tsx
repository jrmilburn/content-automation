import Link from "next/link";

import { LegalLinks } from "../../../components/legal-document";
import { beginGoogleSignIn } from "../../actions";

const reasonMessages = {
  session_expired: {
    label: "Session ended",
    message: "Your session ended. Sign in again to continue. No workspace data was shown.",
  },
  sign_in_required: {
    label: "Sign-in required",
    message: "Use an approved Studio Parallel Google Workspace account to continue.",
  },
} as const;

type LoginSearchParams = Promise<Record<string, string | string[] | undefined>>;

export default async function LoginPage({
  searchParams,
}: Readonly<{ searchParams: LoginSearchParams }>) {
  const parameters = await searchParams;
  const requestedReason = typeof parameters.reason === "string" ? parameters.reason : "";
  const reason =
    requestedReason in reasonMessages
      ? reasonMessages[requestedReason as keyof typeof reasonMessages]
      : undefined;
  const returnTo = typeof parameters.returnTo === "string" ? parameters.returnTo : "/";

  return (
    <main className="access-page">
      <section className="access-panel" aria-labelledby="access-title">
        <Link className="access-brand" href="/login">
          <span aria-hidden="true">SP</span>
          Studio Parallel
        </Link>
        <div className="access-panel__copy">
          <p className="page-location">Internal workspace</p>
          <h1 id="access-title">Content intelligence, with the evidence attached.</h1>
          <p>
            Sign in to review Studio Parallel posts, processing, trends and strategy in the shared
            workspace.
          </p>
        </div>
        {reason ? (
          <div aria-live="polite" className="access-notice">
            <strong>{reason.label}</strong>
            <span>{reason.message}</span>
          </div>
        ) : null}
        <form action={beginGoogleSignIn}>
          <input name="returnTo" type="hidden" value={returnTo} />
          <button className="button button--primary access-action" type="submit">
            Sign in with Google Workspace
          </button>
        </form>
        <p className="access-help">
          Access is limited to explicitly approved Studio Parallel users.
        </p>
        <LegalLinks />
      </section>
      <aside className="access-aside" aria-label="Workspace principles">
        <p>One workspace</p>
        <ul>
          <li>Observed results stay separate from creative interpretation.</li>
          <li>Every trend and recommendation keeps its evidence trail.</li>
          <li>Missing metrics remain unavailable—not zero.</li>
        </ul>
      </aside>
    </main>
  );
}
