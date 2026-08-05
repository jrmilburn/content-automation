import type { StrategyDetail, StrategyEvidenceEntry, StrategySummary } from "@studio-parallel/db";
import type { AnalyticsScope, StrategyEvidenceClass, StrategyV1 } from "@studio-parallel/domain";
import Link from "next/link";

import type { StrategySnapshot } from "../lib/server/strategy-data";
import {
  describeStrategyEvidence,
  describeStrategyPreviewPeriod,
  describeStrategyRefusal,
  formatStrategyPeriod,
  formatStrategyTimestamp,
  resolveStrategyEvidence,
  strategyClassificationLabel,
  strategyClassificationTone,
  strategyDetailHref,
  strategyEvidenceTombstone,
  strategyMetricLabel,
  strategyModeDescription,
  strategyModeLabels,
  strategyPrimaryMetric,
  strategyRequestState,
  strategyRequestStateLabels,
  strategyRequestStateTone,
  strategyScope,
  strategySectionEmptyText,
  strategySectionTitles,
} from "../lib/strategy";
import { EmptyState, ErrorSummary } from "./states";
import { PageHeader } from "./page-header";
import { StatusBadge } from "./status-badge";
import { StrategyRequestControl } from "./strategy-request-control";

/**
 * The strategy a reader acts on, and the evidence under every claim.
 *
 * Ordered by what a reader decides with, not by how the contract is stored:
 * what is working, what is not, what to test, what to make, where to spend, and
 * last what none of it can tell you. Sample size and classification stay beside
 * every claim rather than collecting in a footer, because a claim read without
 * them is read as stronger than it is.
 *
 * Nothing here computes a classification or infers a state. Both were settled
 * when the strategy was generated, and a screen that recalculated either could
 * disagree with the evidence printed next to it.
 */

function Classification({
  classification,
  sampleSize,
  scope,
}: Readonly<{
  classification: StrategyEvidenceClass;
  sampleSize?: number | null;
  scope: AnalyticsScope;
}>) {
  return (
    <p className="strategy-claim__classification">
      <StatusBadge tone={strategyClassificationTone(classification)}>
        {strategyClassificationLabel(classification, scope)}
      </StatusBadge>
      {typeof sampleSize === "number" ? (
        <span className="strategy-claim__sample">
          {sampleSize === 1 ? "1 post" : `${String(sampleSize)} posts`}
        </span>
      ) : null}
    </p>
  );
}

/**
 * The evidence a claim rests on, opened where it can be.
 *
 * Every citation is listed even when it does not resolve, because an absent
 * reference is a limitation a reader has to see rather than a row that quietly
 * disappears. Nothing is ever substituted: a missing entry says it is missing
 * instead of showing the nearest surviving evidence, which would leave a claim
 * looking as well-supported as one whose evidence is still there.
 */
function Evidence({
  manifest,
  references,
}: Readonly<{
  manifest: readonly StrategyEvidenceEntry[];
  references: readonly Readonly<{ evidenceId: string; explanation: string; role: string }>[];
}>) {
  if (references.length === 0) {
    return <p className="strategy-evidence__empty">No evidence was cited for this.</p>;
  }

  return (
    <ul className="strategy-evidence">
      {references.map((reference) => {
        const resolved = resolveStrategyEvidence(manifest, reference.evidenceId);

        return (
          <li key={`${reference.evidenceId}-${reference.role}`}>
            <span className="strategy-evidence__role">{reference.role}</span>{" "}
            {resolved.kind === "link" ? (
              <Link className="strategy-evidence__id" href={resolved.href}>
                {reference.evidenceId}
              </Link>
            ) : (
              <code className="strategy-evidence__id">{reference.evidenceId}</code>
            )}
            <span className="strategy-evidence__explanation">{reference.explanation}</span>
            {resolved.kind === "missing" ? (
              <span className="strategy-evidence__tombstone">{strategyEvidenceTombstone}</span>
            ) : (
              <span className="strategy-evidence__summary">{resolved.entry.summaryText}</span>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function Section({
  children,
  count,
  emptyText,
  id,
  title,
}: Readonly<{
  children: React.ReactNode;
  count: number;
  emptyText: string;
  id: string;
  title: string;
}>) {
  return (
    <section aria-labelledby={id} className="strategy-section">
      <header className="strategy-section__header">
        <h2 id={id}>{title}</h2>
      </header>
      {count > 0 ? children : <p className="strategy-section__empty">{emptyText}</p>}
    </section>
  );
}

function Claims({
  claims,
  manifest,
  scope,
}: Readonly<{
  claims: StrategyV1["workingPatterns"] | StrategyV1["weakPatterns"];
  manifest: readonly StrategyEvidenceEntry[];
  scope: AnalyticsScope;
}>) {
  return (
    <ol className="strategy-claims">
      {claims.map((claim) => (
        <li className="strategy-claim" key={claim.key}>
          <article aria-label={claim.statement}>
            <h3 className="strategy-claim__statement">{claim.statement}</h3>
            <Classification
              classification={claim.classification}
              sampleSize={claim.sampleSize}
              scope={scope}
            />
            <p className="strategy-claim__why">{claim.whyItMatters}</p>
            <Evidence manifest={manifest} references={claim.evidence} />
          </article>
        </li>
      ))}
    </ol>
  );
}

function Experiments({
  experiments,
  manifest,
}: Readonly<{
  experiments: StrategyV1["testsNext"];
  manifest: readonly StrategyEvidenceEntry[];
}>) {
  return (
    <ol className="strategy-tests">
      {experiments.map((experiment) => (
        <li className="strategy-test" key={experiment.hypothesis}>
          <article aria-label={experiment.hypothesis}>
            <h3>{experiment.hypothesis}</h3>
            <dl className="strategy-test__facts">
              <div>
                <dt>Change</dt>
                <dd>{experiment.variableToChange}</dd>
              </div>
              <div>
                <dt>Hold stable</dt>
                <dd>{experiment.variablesToHoldStable.join(", ")}</dd>
              </div>
              <div>
                <dt>Measure</dt>
                <dd>
                  {experiment.primaryMetric} over {experiment.observationWindow}
                </dd>
              </div>
              <div>
                <dt>Minimum posts</dt>
                <dd>{experiment.minimumPosts}</dd>
              </div>
            </dl>
            <p className="strategy-test__rule">{experiment.decisionRule}</p>
            <Evidence manifest={manifest} references={experiment.evidence} />
          </article>
        </li>
      ))}
    </ol>
  );
}

function Recommendations({
  manifest,
  recommendations,
  scope,
}: Readonly<{
  manifest: readonly StrategyEvidenceEntry[];
  recommendations: StrategyV1["recommendations"];
  scope: AnalyticsScope;
}>) {
  return (
    <ol className="strategy-recommendations">
      {recommendations.map((recommendation) => (
        <li className="strategy-recommendation" key={recommendation.key}>
          <article aria-label={recommendation.title}>
            <h3>{recommendation.title}</h3>
            {/*
              Always a creative proposal by contract, never a finding. The badge
              says so before the hooks are read, because a list of ready-to-film
              ideas is the easiest thing on the page to mistake for evidence.
            */}
            <Classification classification={recommendation.classification} scope={scope} />
            <dl className="strategy-recommendation__facts">
              <div>
                <dt>Pillar</dt>
                <dd>{recommendation.contentPillar}</dd>
              </div>
              <div>
                <dt>Format</dt>
                <dd>{recommendation.format}</dd>
              </div>
              <div>
                <dt>Audience</dt>
                <dd>{recommendation.intendedAudience}</dd>
              </div>
              <div>
                <dt>Call to action</dt>
                <dd>{recommendation.cta.text}</dd>
              </div>
            </dl>
            <h4>Hook options</h4>
            <ul className="strategy-recommendation__hooks">
              {recommendation.hookOptions.map((hook) => (
                <li key={hook}>{hook}</li>
              ))}
            </ul>
            <p className="strategy-recommendation__rationale">{recommendation.rationale}</p>
            <Evidence manifest={manifest} references={recommendation.evidence} />
          </article>
        </li>
      ))}
    </ol>
  );
}

function Pillars({
  manifest,
  plan,
  scope,
}: Readonly<{
  manifest: readonly StrategyEvidenceEntry[];
  plan: StrategyV1["pillarPlan"];
  scope: AnalyticsScope;
}>) {
  return (
    <ul className="strategy-pillars">
      {plan.map((entry) => (
        <li className="strategy-pillar" key={entry.pillar}>
          <p className="strategy-pillar__head">
            <span className="strategy-pillar__name">{entry.pillar}</span>
            <span className="strategy-pillar__share">{entry.allocationPercent}%</span>
          </p>
          <Classification classification={entry.classification} scope={scope} />
          <p>{entry.rationale}</p>
          <Evidence manifest={manifest} references={entry.evidence} />
        </li>
      ))}
    </ul>
  );
}

/** The strategy itself, in the order a reader decides in. */
export function StrategyReport({ detail }: Readonly<{ detail: StrategyDetail }>) {
  const { evidence: manifest, strategy, summary } = detail;
  // The population every claim below is about. Taken from the generation, not
  // from the account the reader has selected: a strategy argues from one
  // analytics run, and it keeps that run's scope wherever it is later read.
  const scope = strategyScope(summary.instagramAccountId);

  if (strategy === null) {
    return (
      <EmptyState
        description="This strategy was stored under a contract version this page cannot read. Generating a new one will use the current contract."
        title="This strategy cannot be displayed"
      />
    );
  }

  return (
    <div className="strategy-report">
      <section aria-labelledby="strategy-summary-heading" className="strategy-summary">
        <h2 id="strategy-summary-heading">{strategy.title}</h2>
        <p className="strategy-summary__mode">
          <StatusBadge tone={summary.mode === "evidence_led" ? "success" : "warning"}>
            {strategyModeLabels[summary.mode]}
          </StatusBadge>
        </p>
        <p className="strategy-summary__mode-description">
          {strategyModeDescription(summary.mode, scope)}
        </p>
        <p>{strategy.periodSummary}</p>
        <dl className="strategy-summary__facts">
          {/* Stated as a fact of the strategy rather than left to the badges,
              so a reader who scans the summary and skips the claims still
              knows which population the whole document is about. */}
          <div>
            <dt>Measured across</dt>
            <dd>
              {scope === "pooled"
                ? "Every linked account, pooled into one calculation"
                : "One account's own posts"}
            </dd>
          </div>
          <div>
            <dt>Period</dt>
            <dd>{formatStrategyPeriod(summary)}</dd>
          </div>
          <div>
            <dt>Evidence</dt>
            <dd>{describeStrategyEvidence(summary)}</dd>
          </div>
          <div>
            <dt>Generated</dt>
            <dd>
              {summary.generatedAt === null
                ? "Not recorded"
                : formatStrategyTimestamp(summary.generatedAt)}
            </dd>
          </div>
        </dl>
      </section>

      <Section
        count={strategy.workingPatterns.length}
        emptyText={strategySectionEmptyText.working}
        id="strategy-working-heading"
        title={strategySectionTitles.working}
      >
        <Claims claims={strategy.workingPatterns} manifest={manifest} scope={scope} />
      </Section>

      <Section
        count={strategy.weakPatterns.length}
        emptyText={strategySectionEmptyText.weak}
        id="strategy-weak-heading"
        title={strategySectionTitles.weak}
      >
        <Claims claims={strategy.weakPatterns} manifest={manifest} scope={scope} />
      </Section>

      <Section
        count={strategy.testsNext.length}
        emptyText={strategySectionEmptyText.tests}
        id="strategy-tests-heading"
        title={strategySectionTitles.tests}
      >
        <Experiments experiments={strategy.testsNext} manifest={manifest} />
      </Section>

      <Section
        count={strategy.recommendations.length}
        emptyText={strategySectionEmptyText.recommendations}
        id="strategy-recommendations-heading"
        title={strategySectionTitles.recommendations}
      >
        <Recommendations
          manifest={manifest}
          recommendations={strategy.recommendations}
          scope={scope}
        />
      </Section>

      <Section
        count={strategy.pillarPlan.length}
        emptyText={strategySectionEmptyText.pillars}
        id="strategy-pillars-heading"
        title={strategySectionTitles.pillars}
      >
        <Pillars manifest={manifest} plan={strategy.pillarPlan} scope={scope} />
      </Section>

      <Section
        count={strategy.limitations.length}
        emptyText={strategySectionEmptyText.limitations}
        id="strategy-limitations-heading"
        title={strategySectionTitles.limitations}
      >
        <ul className="strategy-limitations">
          {strategy.limitations.map((limitation) => (
            <li key={limitation.text}>
              <p>{limitation.text}</p>
              <Evidence manifest={manifest} references={limitation.evidence} />
            </li>
          ))}
        </ul>
      </Section>
    </div>
  );
}

function History({ history }: Readonly<{ history: readonly StrategySummary[] }>) {
  if (history.length === 0) return null;

  return (
    <section aria-labelledby="strategy-history-heading" className="strategy-section">
      <header className="strategy-section__header">
        <h2 id="strategy-history-heading">Previous strategies</h2>
      </header>
      <ol className="strategy-history">
        {history.map((entry) => {
          const state = strategyRequestState(entry);

          return (
            <li className="strategy-history__item" key={entry.id}>
              <p className="strategy-history__head">
                <StatusBadge tone={strategyRequestStateTone(state)}>
                  {strategyRequestStateLabels[state]}
                </StatusBadge>
                <span>{formatStrategyTimestamp(entry.requestedAt)}</span>
                <StatusBadge tone={entry.mode === "evidence_led" ? "success" : "warning"}>
                  {strategyModeLabels[entry.mode]}
                </StatusBadge>
              </p>
              <p className="strategy-history__facts">{describeStrategyEvidence(entry)}</p>
              {state === "readable" ? (
                <Link href={strategyDetailHref(entry.id)}>
                  Open this strategy
                  <span className="visually-hidden">
                    {" "}
                    from {formatStrategyTimestamp(entry.requestedAt)}
                  </span>
                </Link>
              ) : (
                <p className="strategy-history__unavailable">
                  {state === "failed"
                    ? "This request did not produce a strategy. The previous one is unaffected."
                    : "This request is still running."}
                </p>
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}

/**
 * What the account may do next, and why it may not.
 *
 * The refusal reason is shown rather than hidden behind a disabled button, so a
 * reader learns what to change instead of guessing why nothing happens.
 */
function RequestPanel({ snapshot }: Readonly<{ snapshot: StrategySnapshot }>) {
  const { preview } = snapshot;
  if (preview === null) return null;

  const refusal = describeStrategyRefusal(preview.reason);

  return (
    <section aria-labelledby="strategy-request-heading" className="strategy-request">
      <header className="strategy-section__header">
        <h2 id="strategy-request-heading">Generate a strategy</h2>
      </header>
      <dl className="strategy-request__facts">
        {/*
          The period and the metric come first because they say what the counts
          below are counts of. A reader shown "20 comparable posts" without them
          cannot tell which six months or which measure they would be agreeing
          to.
        */}
        <div>
          <dt>Period</dt>
          <dd>{describeStrategyPreviewPeriod(preview)}</dd>
        </div>
        <div>
          <dt>Metric</dt>
          <dd>{strategyMetricLabel(strategyPrimaryMetric)}</dd>
        </div>
        <div>
          <dt>Analysed posts</dt>
          <dd>{preview.analysedPostCount}</dd>
        </div>
        <div>
          <dt>With a comparable value</dt>
          <dd>{preview.comparablePostCount}</dd>
        </div>
        <div>
          <dt>Publication weeks</dt>
          <dd>{preview.publicationWeekCount}</dd>
        </div>
        <div>
          <dt>Observation window</dt>
          <dd>{preview.ageWindow ?? "Not calculated"}</dd>
        </div>
      </dl>
      {preview.mode === null ? null : (
        <p className="strategy-request__mode">
          <StatusBadge tone={preview.mode === "evidence_led" ? "success" : "warning"}>
            {strategyModeLabels[preview.mode]}
          </StatusBadge>{" "}
          {strategyModeDescription(preview.mode, "account")}
        </p>
      )}
      {refusal === null ? (
        <StrategyRequestControl
          accountId={snapshot.selectedAccountId ?? ""}
          exploratory={preview.mode === "exploratory"}
        />
      ) : (
        <p className="strategy-request__refusal">{refusal}</p>
      )}
    </section>
  );
}

export function StrategyScreen({ snapshot }: Readonly<{ snapshot: StrategySnapshot }>) {
  return (
    <div className="page-stack">
      <PageHeader
        description="What this account's measured evidence suggests to make next, with the evidence under every claim."
        title="Strategy"
      />

      {snapshot.hasAccount ? null : (
        <EmptyState
          action={{ href: "/settings/integrations", label: "Connect Instagram account" }}
          description="Connect an Instagram professional account. A strategy is built from analysed posts and the trends calculated from them."
          title="No Instagram account connected"
        />
      )}

      {snapshot.hasAccount ? <RequestPanel snapshot={snapshot} /> : null}

      {snapshot.current === null && snapshot.hasAccount ? (
        <EmptyState
          action={{ href: "/trends", label: "Review trends" }}
          description="No strategy has been generated for this account yet. One reads the trends already calculated from analysed posts."
          title="No strategy generated yet"
        />
      ) : null}

      {snapshot.current ? <StrategyReport detail={snapshot.current} /> : null}

      <History history={snapshot.history} />
    </div>
  );
}

export function StrategyDetailScreen({ detail }: Readonly<{ detail: StrategyDetail }>) {
  return (
    <div className="page-stack">
      <PageHeader
        description={`Requested ${formatStrategyTimestamp(detail.summary.requestedAt)}.`}
        title="Strategy"
      />
      <p>
        <Link href="/strategy">Back to the current strategy</Link>
      </p>
      <StrategyReport detail={detail} />
    </div>
  );
}

export function StrategyError({ reference }: Readonly<{ reference: string }>) {
  return (
    <div className="page-stack">
      <PageHeader description="Strategy could not be loaded." title="Strategy" />
      <ErrorSummary
        description="Nothing was changed. Try again, and quote this reference if it keeps happening."
        correlationId={reference}
        title="Strategy is unavailable"
      />
    </div>
  );
}
