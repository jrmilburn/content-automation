import type { Metadata } from "next";
import Link from "next/link";

import { LegalDocument, PendingDetail } from "../../../components/legal-document";

export const metadata: Metadata = {
  description:
    "The terms that apply to approved Studio Parallel staff using Studio Parallel Content Intelligence.",
  title: "Terms of use | Studio Parallel Content Intelligence",
};

const contact = "team@studioparallel.com.au";

export default function TermsPage() {
  return (
    <LegalDocument
      lastUpdated="2026-07-29"
      summary="These terms apply to approved Studio Parallel staff who sign in to Studio Parallel Content Intelligence. There is no public sign-up and no consumer offering."
      title="Terms of use"
    >
      <section aria-labelledby="who">
        <h2 id="who">Who may use this tool</h2>
        <p>
          Access is limited to Studio Parallel staff with an approved Google Workspace identity and
          an active entry on the internal allowlist. Accounts are provisioned deliberately; there is
          no self-service registration. Do not share your session, and do not attempt to reach data
          belonging to a workspace you have not been granted.
        </p>
        <p>
          This service is operated by{" "}
          <PendingDetail>[registered legal entity to be confirmed]</PendingDetail> trading as Studio
          Parallel.
        </p>
      </section>

      <section aria-labelledby="acceptable">
        <h2 id="acceptable">Acceptable use</h2>
        <ul>
          <li>Use the tool only for Studio Parallel&rsquo;s own content work.</li>
          <li>
            Connect only Instagram accounts Studio Parallel owns and is authorised to administer.
          </li>
          <li>
            Upload only video you have the rights to use, including any rights needed for the people
            appearing in it.
          </li>
          <li>
            Do not upload personal information that is not needed to analyse the content, and do not
            upload material you are not permitted to send to a third-party analysis service.
          </li>
          <li>
            Do not attempt to circumvent authorisation, enumerate identifiers, or interfere with
            background processing.
          </li>
        </ul>
      </section>

      <section aria-labelledby="content">
        <h2 id="content">Your content</h2>
        <p>
          Studio Parallel retains ownership of the video, transcripts and notes added to the tool.
          We process that content to provide the service, including sending it to Google Gemini for
          analysis as described in the <Link href="/privacy">privacy policy</Link>. Uploading
          content confirms you have the rights required to do so.
        </p>
      </section>

      <section aria-labelledby="output">
        <h2 id="output">What the analysis is, and is not</h2>
        <p>
          The tool reports what was observed and offers an interpretation of it. Those are different
          things, and the interface keeps them separate.
        </p>
        <ul>
          <li>
            Measured figures come from Instagram. Where a metric is unavailable it is shown as
            unavailable, never as zero.
          </li>
          <li>
            Creative analysis, trends, strategy and recommendations are generated interpretations.
            They are suggestions to inform a decision, not statements of fact and not a guarantee of
            any result.
          </li>
          <li>
            Nothing here explains how any platform&rsquo;s ranking works, and no output should be
            read as establishing that one creative choice caused a particular result.
          </li>
        </ul>
        <p>
          You remain responsible for what you choose to publish. Review any suggestion before acting
          on it.
        </p>
      </section>

      <section aria-labelledby="third-party">
        <h2 id="third-party">Third-party services</h2>
        <p>
          Using the tool also means complying with the terms of the services it depends on,
          including Meta&rsquo;s platform terms for Instagram data and Google&rsquo;s terms for the
          Gemini API and Google Workspace. Those services may change their interfaces, permissions
          or metric definitions, which can change or interrupt what this tool can show.
        </p>
      </section>

      <section aria-labelledby="availability">
        <h2 id="availability">Availability</h2>
        <p>
          This is an internal tool provided as-is, without a service level commitment. It may be
          unavailable during maintenance, provider outages or incident response. To the extent
          permitted by law, Studio Parallel is not liable for loss arising from unavailability or
          from decisions made on the basis of generated suggestions.
        </p>
      </section>

      <section aria-labelledby="ending">
        <h2 id="ending">Ending access</h2>
        <p>
          Access is removed when someone leaves Studio Parallel or no longer needs the tool.
          Deactivation takes effect immediately for new requests and ends existing sessions.
          Disconnecting an Instagram account stops further reading and purges the stored
          credentials.
        </p>
      </section>

      <section aria-labelledby="changes">
        <h2 id="changes">Changes and governing law</h2>
        <p>
          We update these terms as the tool changes, and revise the date at the top of this page.
          These terms are governed by the laws of{" "}
          <PendingDetail>[jurisdiction to be confirmed]</PendingDetail>.
        </p>
      </section>

      <section aria-labelledby="contact">
        <h2 id="contact">Contact</h2>
        <p>
          Questions about these terms: <a href={`mailto:${contact}`}>{contact}</a>.
        </p>
      </section>
    </LegalDocument>
  );
}
