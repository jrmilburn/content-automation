import type { Metadata } from "next";

import { LegalDocument, PendingDetail } from "../../../components/legal-document";

export const metadata: Metadata = {
  description:
    "How Studio Parallel Content Intelligence collects, uses, stores and deletes Instagram data, uploaded source video and related content.",
  title: "Privacy policy | Studio Parallel Content Intelligence",
};

const privacyContact = "team@studioparallel.com.au";

const retentionRows = [
  ["Instagram access credentials", "While the account stays connected", "Purged on disconnect"],
  [
    "Instagram account, media and metric records",
    "While the connected account is retained",
    "Deleted with the account",
  ],
  [
    "Uploaded source video",
    "While the associated post is retained",
    "Superseded versions kept 30 days, then purged",
  ],
  ["Abandoned or rejected uploads", "Up to 24 hours", "Removed automatically"],
  ["Transcripts, scripts and notes", "While the associated post is retained", "Deleted on request"],
  [
    "Temporary files sent to Google Gemini",
    "The duration of one analysis",
    "Deleted after processing; expire at the provider within 48 hours",
  ],
  [
    "Analysis, trends and strategy records",
    "Retained as product history",
    "Removed when the source account or workspace is erased",
  ],
  ["Processing and sync logs", "180 days", "Replaced by aggregate operational metrics"],
  ["Access and change audit records", "1 year", "Minimised personal detail"],
  ["Encrypted backups", "Up to 35 days", "Age out on the provider cycle"],
] as const;

export default function PrivacyPage() {
  return (
    <LegalDocument
      lastUpdated="2026-07-29"
      summary="Studio Parallel Content Intelligence is a private internal tool used by approved Studio Parallel staff to review the performance of Studio Parallel's own Instagram content. It is not a public service and has no consumer sign-up."
      title="Privacy policy"
    >
      <section aria-labelledby="who">
        <h2 id="who">Who this covers</h2>
        <p>
          This policy applies to Studio Parallel Content Intelligence, operated by{" "}
          <PendingDetail>[registered legal entity to be confirmed]</PendingDetail> trading as Studio
          Parallel.
        </p>
        <p>
          Two groups of people are affected. Approved Studio Parallel staff sign in and use the
          tool. Separately, the tool reads data from a Studio Parallel Instagram professional
          account that the business itself owns and connects. It does not collect data about members
          of the public, and it does not read other people&rsquo;s Instagram accounts.
        </p>
      </section>

      <section aria-labelledby="collect">
        <h2 id="collect">What we collect</h2>
        <h3>Staff sign-in</h3>
        <p>
          Sign-in uses Google Workspace. We receive the name, email address and a stable account
          identifier for staff explicitly added to the internal allowlist. Access requires both an
          approved domain and an active allowlist entry.
        </p>
        <h3>Instagram data</h3>
        <p>
          When an authorised administrator connects a Studio Parallel Instagram professional
          account, we request only two permissions:
        </p>
        <ul>
          <li>
            <strong>instagram_business_basic</strong> — the account profile and the account&rsquo;s
            own published media, including captions, media type, permalinks and timestamps.
          </li>
          <li>
            <strong>instagram_business_manage_insights</strong> — the metrics Instagram reports for
            that account&rsquo;s own media, such as views, reach and interactions.
          </li>
          <li>
            <strong>instagram_business_manage_comments</strong> — the comments and replies left on
            that account&rsquo;s own posts, so the content strategy can reflect what the audience
            actually asks about. This permission is named for comment moderation, and we use only
            its read half: we never create, hide, delete or reply to a comment.
          </li>
        </ul>
        <p>
          When a comment is imported we store its text, the commenter&rsquo;s Instagram username,
          when it was posted and how many likes it has. That text is shown to staff of the connected
          business and is included in the material sent to our AI provider when a strategy is
          generated or a question is asked of the assistant.
        </p>
        <p>
          We do not request, and cannot read, direct messages, advertising accounts, comments on any
          post that is not the connected account&rsquo;s own, or any account other than the one
          connected.
        </p>
        <h3>Content staff upload</h3>
        <p>
          Staff may upload the original source video for a post, and may add a transcript, script,
          intended audience, content objective and internal notes.
        </p>
        <h3>Operational records</h3>
        <p>
          We keep processing and synchronisation logs and an audit record of significant actions,
          such as connecting or disconnecting an account, changing configuration and deleting data.
          These records use internal identifiers. Access tokens, signed links, video content,
          transcripts and raw provider payloads are excluded from logs by design.
        </p>
      </section>

      <section aria-labelledby="use">
        <h2 id="use">How we use it</h2>
        <p>
          The tool compares Studio Parallel&rsquo;s own published content against its own measured
          results, and produces creative analysis, trends and suggested next content. It is used
          only for that purpose.
        </p>
        <p>
          We do not sell data, use it for advertising or profiling, or share it with anyone outside
          the processors listed below. Statistics are calculated by the application from recorded
          metrics; the language model never calculates reported figures and has no access to the
          database, files or any tool.
        </p>
      </section>

      <section aria-labelledby="processors">
        <h2 id="processors">Services that process data for us</h2>
        <ul>
          <li>
            <strong>Meta</strong> — the source of Instagram account, media and metric data, read
            through the Instagram API with the permissions above.
          </li>
          <li>
            <strong>Google Gemini</strong> — analyses uploaded source video and its accompanying
            transcript or notes. We use a paid, billing-enabled project. Under Google&rsquo;s
            current{" "}
            <a href="https://ai.google.dev/gemini-api/terms" rel="noreferrer" target="_blank">
              Gemini API terms
            </a>
            , paid-service prompts, files and responses are not used to improve Google&rsquo;s
            products, although limited safety and security processing still applies. Optional
            developer request and response logging is disabled. Files sent for analysis are deleted
            after processing and expire at Google within 48 hours.
          </li>
          <li>
            <strong>Google Workspace</strong> — staff identity and sign-in.
          </li>
          <li>
            <strong>Hosting, database and object storage providers</strong> — run the application
            and store its data.
          </li>
        </ul>
        <p>
          We send Gemini only the selected video and the context needed to analyse it. Instagram
          access tokens, staff personal details and unrelated account history are never sent.
        </p>
      </section>

      <section aria-labelledby="security">
        <h2 id="security">How it is protected</h2>
        <ul>
          <li>Instagram access credentials are encrypted with a separate environment key.</li>
          <li>
            Uploaded video is held in a private store with public access disabled and encryption at
            rest. Access requires a short-lived link the server authorises for one exact file.
          </li>
          <li>Data is encrypted in transit.</li>
          <li>
            Access is limited to an explicit allowlist of Studio Parallel staff, and every request
            is authorised against the workspace on the server.
          </li>
          <li>
            Logs and error reports exclude tokens, signed links, video content, transcripts and raw
            provider payloads.
          </li>
        </ul>
      </section>

      <section aria-labelledby="retention">
        <h2 id="retention">How long we keep it</h2>
        <p>
          These are the retention periods the system applies. We review them, and this page is
          updated when they change.
        </p>
        <div
          aria-label="Retention periods"
          className="legal-table-scroll"
          role="region"
          tabIndex={0}
        >
          <table className="legal-table">
            <caption className="visually-hidden">Retention period by type of data</caption>
            <thead>
              <tr>
                <th scope="col">Data</th>
                <th scope="col">Retention</th>
                <th scope="col">What happens then</th>
              </tr>
            </thead>
            <tbody>
              {retentionRows.map(([data, retention, outcome]) => (
                <tr key={data}>
                  <th scope="row">{data}</th>
                  <td>{retention}</td>
                  <td>{outcome}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section aria-labelledby="rights">
        <h2 id="rights">Access, correction and deletion</h2>
        <p>
          Disconnecting the Instagram account stops all further reading and purges the stored access
          credentials.
        </p>
        <p>
          To request access to the data we hold, ask for a correction, or ask us to delete an
          account, a post, an uploaded video or a transcript, email{" "}
          <a href={`mailto:${privacyContact}`}>{privacyContact}</a>. Deletion removes the stored
          file and provider records, and removes derived analysis when the whole account or
          workspace is erased. Deletions already completed are reapplied if a backup is ever
          restored.
        </p>
        <p>
          If you believe we have handled personal information incorrectly, you may also complain to
          the relevant privacy regulator in{" "}
          <PendingDetail>[jurisdiction to be confirmed]</PendingDetail>.
        </p>
      </section>

      <section aria-labelledby="changes">
        <h2 id="changes">Changes</h2>
        <p>
          When this policy changes we update the date at the top of this page. Material changes to
          what we collect or how long we keep it are made before the change takes effect.
        </p>
      </section>

      <section aria-labelledby="contact">
        <h2 id="contact">Contact</h2>
        <p>
          Email <a href={`mailto:${privacyContact}`}>{privacyContact}</a> with any privacy question
          or request. Postal address and registered entity details:{" "}
          <PendingDetail>[to be confirmed]</PendingDetail>.
        </p>
      </section>
    </LegalDocument>
  );
}
