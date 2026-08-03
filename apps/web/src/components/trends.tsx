import type { TrendContributor, TrendDetail, TrendListItem } from "@studio-parallel/db";
import {
  explainClassification,
  formatMetricValue,
  formatRelativeEffect,
  isTrendCalculationStale,
  presentConfidence,
  presentFeaturePath,
  presentFeatureValue,
  presentMetric,
} from "@studio-parallel/domain";
import Link from "next/link";
import type { ReactNode } from "react";

import type { TrendsSnapshot } from "../lib/server/trends-data";
import {
  comparisonRows,
  confidenceFilterOptions,
  confidenceTone,
  formatCalculatedAt,
  formatPublicationWindow,
  groupTrends,
  hasActiveTrendFilters,
  metricFilterOptions,
  presentAgeWindow,
  presentInterval,
  presentMissingness,
  presentSensitivity,
  trendAccessibleName,
  trendDetailHref,
  trendHeadline,
  type TrendsFilterValues,
} from "../lib/trends";
import { PageHeader } from "./page-header";
import { EmptyState, ErrorSummary } from "./states";
import { StatusBadge } from "./status-badge";

/**
 * What the account's own history shows, and what it does not.
 *
 * Results are read strongest first and limitations last, so a reader who stops
 * early has seen the best-evidenced findings rather than the largest numbers. No
 * section is hidden when empty: an absent "supported associations" heading reads
 * as "there were none", which is indistinguishable from "we did not look".
 *
 * There is no chart. Medians and interquartile ranges describe a small, skewed
 * sample better than a plot of them would, and a table is the equivalent the
 * contract requires anyway — building the chart first and the table second would
 * be two implementations of one truth.
 */

const description = "What this account's own history shows, and how strong the evidence is.";

export function TrendsScreen({
  snapshot,
  values,
}: Readonly<{ snapshot: TrendsSnapshot; values: TrendsFilterValues }>) {
  const { list } = snapshot;
  const filtered = hasActiveTrendFilters(values);
  const groups = groupTrends(list.trends);

  return (
    <div className="page-stack">
      <PageHeader description={description} title="Trends" />

      {list.calculation ? <CalculationFreshness calculation={list.calculation} /> : null}

      {snapshot.hasAccount ? <TrendsFilters snapshot={snapshot} values={values} /> : null}

      {list.trends.length > 0 ? (
        <>
          <p aria-live="polite" className="trends-count">
            {list.trends.length} {list.trends.length === 1 ? "comparison" : "comparisons"}
            {filtered ? " match these filters" : " calculated"}
          </p>
          {groups.map((group) => (
            <TrendGroupSection
              description={group.description}
              key={group.key}
              sectionKey={group.key}
              title={group.title}
              trends={group.trends}
              values={values}
            />
          ))}
        </>
      ) : (
        <TrendsEmpty
          filtered={filtered}
          hasAccount={snapshot.hasAccount}
          hasCalculation={list.calculation !== null}
        />
      )}
    </div>
  );
}

export function TrendsError({ reference }: Readonly<{ reference: string }>) {
  return (
    <div className="page-stack">
      <PageHeader description={description} title="Trends" />
      <ErrorSummary
        action={{ href: "/trends", label: "Try again" }}
        correlationId={reference}
        description="Calculated trends could not be loaded. Nothing was changed and the last published calculation remains safe."
        title="Trends did not load"
      />
    </div>
  );
}

/**
 * When the published calculation ran, and whether it has fallen behind.
 *
 * Shown above the results rather than beneath them: everything below is only as
 * current as this, and a reader who has already drawn a conclusion from a stale
 * number has been misled by the time they reach a footnote.
 */
function CalculationFreshness({
  calculation,
}: Readonly<{ calculation: NonNullable<TrendsSnapshot["list"]["calculation"]> }>) {
  const stale = isTrendCalculationStale(new Date(calculation.activatedAt), new Date());

  return (
    <section aria-labelledby="trends-freshness-heading" className="trends-freshness">
      <h2 className="visually-hidden" id="trends-freshness-heading">
        Calculation freshness
      </h2>
      <p className="trends-freshness__line">
        <StatusBadge tone={stale ? "warning" : "success"}>
          {stale ? "Calculation is behind" : "Calculation is current"}
        </StatusBadge>
        <span>
          Published{" "}
          <time dateTime={calculation.activatedAt}>
            {formatCalculatedAt(calculation.activatedAt)}
          </time>{" "}
          from {calculation.analysisCount}{" "}
          {calculation.analysisCount === 1 ? "analysed post" : "analysed posts"}, measured{" "}
          {presentAgeWindow(calculation.ageWindow)}.
        </span>
      </p>
      <p className="trends-freshness__scope">
        Published {formatPublicationWindow(calculation.publishedFrom, calculation.publishedTo)}.
        {stale
          ? " New posts or analyses since then are not included yet; a recalculation runs automatically."
          : ""}
      </p>
    </section>
  );
}

function TrendsEmpty({
  filtered,
  hasAccount,
  hasCalculation,
}: Readonly<{ filtered: boolean; hasAccount: boolean; hasCalculation: boolean }>) {
  if (!hasAccount) {
    return (
      <EmptyState
        action={{ href: "/settings/integrations", label: "Connect Instagram account" }}
        description="Connect an Instagram professional account. Trends appear once its posts have been imported and analysed."
        title="No Instagram account connected"
      />
    );
  }

  if (filtered && hasCalculation) {
    return (
      <EmptyState
        action={{ href: "/trends", label: "Clear filters" }}
        description="These filters exclude every comparison in the published calculation. This is not a finding that no pattern exists."
        title="No comparisons match these filters"
      />
    );
  }

  return (
    <EmptyState
      action={{ href: "/posts", label: "Review posts awaiting analysis" }}
      description="Trends are calculated from analysed posts. Once enough posts have been analysed and their metrics captured, comparisons appear here automatically."
      title="Nothing has been calculated yet"
    />
  );
}

function TrendsFilters({
  snapshot,
  values,
}: Readonly<{ snapshot: TrendsSnapshot; values: TrendsFilterValues }>) {
  return (
    <section aria-labelledby="trends-filters-heading" className="trends-filters">
      <div className="trends-filters__heading">
        <h2 id="trends-filters-heading">Narrow the comparisons</h2>
        <Link href="/trends">Clear all</Link>
      </div>
      <form action="/trends" className="trends-filter-form" method="get">
        {snapshot.accounts.length > 1 ? (
          <label>
            <span>Account</span>
            <select defaultValue={values.account} name="account">
              {snapshot.accounts.map((account) => (
                <option key={account.id} value={account.id}>
                  {account.label}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <label>
          <span>Metric</span>
          <select defaultValue={values.metric} name="metric">
            <option value="all">All metrics</option>
            {metricFilterOptions.map(({ label, value }) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        {snapshot.featurePaths.length > 0 ? (
          <label>
            <span>Feature</span>
            <select defaultValue={values.feature} name="feature">
              <option value="all">All features</option>
              {/* Built from what the run produced. Offering a feature it
                  calculated nothing for would let a reader pick their way to an
                  empty screen and read it as "no patterns here". */}
              {snapshot.featurePaths.map((path) => (
                <option key={path} value={path}>
                  {presentFeaturePath(path)}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <label>
          <span>Evidence level</span>
          <select defaultValue={values.confidence} name="confidence">
            <option value="all">All evidence levels</option>
            {confidenceFilterOptions.map(({ label, value }) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <button className="button button--primary" type="submit">
          Apply filters
        </button>
      </form>
    </section>
  );
}

function TrendGroupSection({
  description: groupDescription,
  sectionKey,
  title,
  trends,
  values,
}: Readonly<{
  description: string;
  sectionKey: string;
  title: string;
  trends: readonly TrendListItem[];
  values: TrendsFilterValues;
}>) {
  const headingId = `trends-${sectionKey}-heading`;

  return (
    <section aria-labelledby={headingId} className="trends-group">
      <header className="trends-group__header">
        <h2 id={headingId}>{title}</h2>
        <p>{groupDescription}</p>
      </header>

      {trends.length > 0 ? (
        <ol className="trends-grid">
          {trends.map((trend) => (
            <TrendCard key={trend.id} trend={trend} values={values} />
          ))}
        </ol>
      ) : (
        <p className="trends-group__empty">
          Nothing in this group for the current filters.
          {sectionKey === "supported"
            ? " That is not evidence against the comparisons below it."
            : ""}
        </p>
      )}
    </section>
  );
}

/**
 * One comparison.
 *
 * The card always carries feature, value, metric, sample sizes, the difference,
 * the publication period and the evidence class — the acceptance criteria list
 * those together because any one of them missing lets the number be read as
 * stronger than it is. The difference is signed so the direction reads as the
 * finding rather than as a magnitude.
 */
function TrendCard({
  trend,
  values,
}: Readonly<{ trend: TrendListItem; values: TrendsFilterValues }>) {
  const confidence = presentConfidence(trend.confidence);
  const metric = presentMetric(trend.metric);
  const headingId = `trend-${trend.id}`;

  return (
    <li>
      <article aria-labelledby={headingId} className="trend-card">
        <div className="trend-card__meta">
          <StatusBadge tone={confidenceTone(trend.confidence)}>{confidence.label}</StatusBadge>
          <h3 id={headingId}>{trendHeadline(trend)}</h3>
        </div>

        <p className="trend-card__metric">
          {metric.label}
          {metric.denominator ? ` (per ${metric.denominator})` : ""}
        </p>

        <p className="trend-card__effect">
          <span className="trend-card__effect-value">
            {formatRelativeEffect(trend.relativeEffect)}
          </span>
          <span> against posts with another value for this feature</span>
        </p>

        <p className="trend-card__claim">{confidence.claim}</p>

        <dl className="trend-card__facts">
          <div>
            <dt>Sample</dt>
            <dd>
              {trend.groupCount} with this value, {trend.comparisonCount} compared against
            </dd>
          </div>
          <div>
            <dt>Published</dt>
            <dd>{formatPublicationWindow(trend.publishedFrom, trend.publishedTo)}</dd>
          </div>
          <div>
            <dt>Measured</dt>
            <dd>{presentAgeWindow(trend.ageWindow)}</dd>
          </div>
        </dl>

        <p className="trend-card__actions">
          <Link href={trendDetailHref(trend.id, values)}>
            See the evidence
            {/* Every card repeats this text, so the link needs the comparison's
                own identity to be usable out of context. */}
            <span className="visually-hidden"> for {trendAccessibleName(trend)}</span>
          </Link>
        </p>
      </article>
    </li>
  );
}

/**
 * The evidence behind one comparison.
 *
 * Progressive disclosure by route rather than by a collapsed region: the detail
 * is a page a reader can link to, cite and return to, which is what evidence has
 * to be if a strategy is going to reference it later.
 */
export function TrendDetailScreen({ detail }: Readonly<{ detail: TrendDetail }>) {
  const { calculation, contributors, trend } = detail;
  const confidence = presentConfidence(trend.confidence);
  const metric = presentMetric(trend.metric);
  const group = contributors.filter((contributor) => contributor.membership === "group");
  const comparison = contributors.filter((contributor) => contributor.membership === "comparison");

  return (
    <div className="page-stack">
      <PageHeader
        description={`${metric.label}${
          metric.denominator ? ` per ${metric.denominator}` : ""
        }, in this account's published calculation.`}
        title={trendHeadline(trend)}
      />

      <p className="trend-detail__back">
        <Link href="/trends">Back to all trends</Link>
      </p>

      <section aria-labelledby="trend-claim-heading" className="trend-detail__claim">
        <h2 id="trend-claim-heading">What this shows</h2>
        <p>
          <StatusBadge tone={confidenceTone(trend.confidence)}>{confidence.label}</StatusBadge>
        </p>
        <p>{confidence.claim}</p>
        <p>{explainClassification(trend.classificationReason)}</p>
      </section>

      <section aria-labelledby="trend-comparison-heading" className="trend-detail__comparison">
        <h2 id="trend-comparison-heading">The comparison</h2>
        <TableScroll label={`Median and spread of ${metric.label} for each side of the comparison`}>
          <table className="trend-table">
            <caption className="visually-hidden">
              Median and spread of {metric.label} for each side of the comparison
            </caption>
            <thead>
              <tr>
                <th scope="col">Group</th>
                <th scope="col">Posts</th>
                <th scope="col">Median</th>
                <th scope="col">Interquartile range</th>
              </tr>
            </thead>
            <tbody>
              {comparisonRows(trend).map((row) => (
                <tr key={row.label}>
                  <th scope="row">{row.label}</th>
                  <td>{row.count}</td>
                  <td>{row.median}</td>
                  <td>{row.interquartileRange}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableScroll>
        <p className="trend-detail__difference">
          Difference between the medians:{" "}
          {formatMetricValue(trend.differenceOfMedians, metric.unit)} (
          {formatRelativeEffect(trend.relativeEffect)}).
        </p>
      </section>

      <section aria-labelledby="trend-method-heading" className="trend-detail__method">
        <h2 id="trend-method-heading">How it was calculated</h2>
        <dl className="trend-detail__facts">
          <Fact label="Metric formula" value={metric.formula} />
          <Fact label="Denominator" value={metric.denominator ?? "None — this is a count"} />
          <Fact label="Snapshot age" value={presentAgeWindow(trend.ageWindow)} />
          <Fact
            label="Publication period"
            value={formatPublicationWindow(trend.publishedFrom, trend.publishedTo)}
          />
          <Fact
            label="Spread of publication"
            value={`${trend.distinctPublicationDates} distinct dates across ${trend.distinctPublicationWeeks} weeks`}
          />
          <Fact label="Uncertainty" value={presentInterval(trend)} />
          <Fact label="Sensitivity" value={presentSensitivity(trend)} />
          <Fact label="Missing values" value={presentMissingness(trend)} />
          <Fact
            label="Multiple testing"
            value={
              trend.multipleTestingApplied
                ? "Corrected across every comparison calculated in the same pass, at a 10% false-discovery rate."
                : "Not applicable — this comparison did not reach the threshold where the correction is applied."
            }
          />
          {trend.topContributorShare === null ? null : (
            <Fact
              label="Top post share"
              value={`One post accounts for ${(trend.topContributorShare * 100).toFixed(0)}% of the group total.`}
            />
          )}
          <Fact label="Analytics version" value={calculation.analyticsVersion} />
          <Fact label="Statistics version" value={calculation.statisticsVersion} />
          <Fact label="Calculation published" value={formatCalculatedAt(calculation.activatedAt)} />
        </dl>
        {metric.limitations.length > 0 ? (
          <>
            <h3>Limitations of this metric</h3>
            <ul className="trend-detail__limitations">
              {metric.limitations.map((limitation) => (
                <li key={limitation}>{limitation}</li>
              ))}
            </ul>
          </>
        ) : null}
      </section>

      <ContributorTable
        contributors={group}
        heading="Posts with this value"
        headingId="trend-group-posts-heading"
        metricLabel={metric.label}
        summary={`The ${group.length} posts whose analysis recorded ${presentFeatureValue(
          trend.featurePath,
          trend.featureValue,
        )}.`}
      />

      <ContributorTable
        contributors={comparison}
        heading="Posts compared against"
        headingId="trend-comparison-posts-heading"
        metricLabel={metric.label}
        summary={`The ${comparison.length} posts with a different known value for ${presentFeaturePath(
          trend.featurePath,
        )}. Posts with no readable value are excluded and counted separately.`}
      />
    </div>
  );
}

export function TrendDetailError({ reference }: Readonly<{ reference: string }>) {
  return (
    <div className="page-stack">
      <PageHeader description="Evidence behind one comparison." title="Trend evidence" />
      <ErrorSummary
        action={{ href: "/trends", label: "Back to all trends" }}
        correlationId={reference}
        description="This comparison's evidence could not be loaded. Nothing was changed and the published calculation remains safe."
        title="Evidence did not load"
      />
    </div>
  );
}

function ContributorTable({
  contributors,
  heading,
  headingId,
  metricLabel,
  summary,
}: Readonly<{
  contributors: readonly TrendContributor[];
  heading: string;
  headingId: string;
  metricLabel: string;
  summary: string;
}>) {
  return (
    <section aria-labelledby={headingId} className="trend-detail__posts">
      <h2 id={headingId}>{heading}</h2>
      <p>{summary}</p>

      {contributors.length === 0 ? (
        <p className="trends-group__empty">No posts recorded on this side of the comparison.</p>
      ) : (
        <TableScroll label={summary}>
          <table className="trend-table">
            <caption className="visually-hidden">{summary}</caption>
            <thead>
              <tr>
                <th scope="col">Published</th>
                <th scope="col">{metricLabel}</th>
                <th scope="col">Caption</th>
                <th scope="col">Post</th>
              </tr>
            </thead>
            <tbody>
              {contributors.map((contributor) => (
                <tr key={contributor.instagramPostId}>
                  <th scope="row">
                    <time dateTime={contributor.publishedAt}>
                      {formatCalculatedAt(contributor.publishedAt)}
                    </time>
                  </th>
                  <td>{contributor.value.toFixed(4)}</td>
                  <td>{contributor.caption ?? "No caption"}</td>
                  <td>
                    <Link href={`/posts/${contributor.instagramPostId}/source-video`}>
                      Open post
                      <span className="visually-hidden">
                        {" "}
                        published {formatCalculatedAt(contributor.publishedAt)}
                      </span>
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableScroll>
      )}
    </section>
  );
}

/**
 * A table that scrolls inside its own box.
 *
 * Focusable and named, because a region a mouse can scroll and a keyboard
 * cannot is unreachable for anyone not using a pointer. The scroll is what keeps
 * a four-column table readable at 390px without widening the document, so the
 * keyboard affordance has to come with it rather than after it.
 */
function TableScroll({ children, label }: Readonly<{ children: ReactNode; label: string }>) {
  return (
    <div aria-label={label} className="trend-table-scroll" role="region" tabIndex={0}>
      {children}
    </div>
  );
}

function Fact({ label, value }: Readonly<{ label: string; value: string }>) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}
