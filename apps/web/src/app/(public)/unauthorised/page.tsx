import { LegalLinks } from "../../../components/legal-document";
import { beginGoogleSignIn } from "../../actions";

export default function UnauthorisedPage() {
  return (
    <main className="boundary-page">
      <div className="boundary-panel">
        <p className="page-location">Access unavailable</p>
        <h1>This account cannot open the workspace</h1>
        <p>
          Use an approved Studio Parallel Google Workspace identity. No workspace data was shown.
        </p>
        <form action={beginGoogleSignIn}>
          <input name="returnTo" type="hidden" value="/" />
          <button className="button button--primary" type="submit">
            Try another Google account
          </button>
        </form>
        <LegalLinks />
      </div>
    </main>
  );
}
