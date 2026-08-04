import type { TrendListItem } from "@studio-parallel/db";
import {
  confidenceClasses,
  derivedMetrics,
  formatMetricValue,
  presentConfidence,
  presentFeaturePath,
  presentFeatureValue,
  presentMetric,
  trendSectionFor,
  trendSections,
  type ConfidenceClass,
  type DerivedMetric,
  type TrendSectionKey,
} from "@studio-parallel/domain";

import type { StatusTone } from "../components/status-badge";

/**
 * Pure parsing and presentation for the trends screen.
 *
 * An unrecognised filter value sets `matchesNothing` rather than being dropped,
 * as on the posts list. On this screen the cost of getting that wrong is higher:
 * a silently widened filter reads as "here is everything we found", and a
 * silently emptied one reads as "this account has no patterns" — a conclusion
 * the data never supported.
 *
 * The wording of every evidence claim comes from the domain package, not from
 * here and not from a component. The analytics contract constrains it, and a
 * constraint spread across a view layer is one nobody can check.
 */

export type TrendsSearchParams = Record<string, string | string[] | undefined>;

export type TrendsFilterValues = Readonly<{
  account: string;
  confidence: "all" | ConfidenceClass;
  feature: string;
  metric: "all" | DerivedMetric;
}>;

export type TrendsFilters = Readonly<{
  confidence?: ConfidenceClass;
  featurePath?: string;
  instagramAccountId?: string;
  matchesNothing?: boolean;
  metric?: DerivedMetric;
}>;

export const confidenceFilterOptions: ReadonlyArray<
  Readonly<{ label: string; value: ConfidenceClass }>
> = confidenceClasses.map((value) => ({ label: presentConfidence(value).label, value }));

export const metricFilterOptions: ReadonlyArray<Readonly<{ label: string; value: DerivedMetric }>> =
  derivedMetrics.map((value) => ({ label: presentMetric(value).label, value }));

export function parseTrendsFilters(searchParams: TrendsSearchParams): Readonly<{
  filters: TrendsFilters;
  values: TrendsFilterValues;
}> {
  const rawAccount = firstValue(searchParams.account);
  const rawConfidence = firstValue(searchParams.confidence);
  const rawFeature = firstValue(searchParams.feature);
  const rawMetric = firstValue(searchParams.metric);
  let matchesNothing = false;

  const instagramAccountId = isUuidV7(rawAccount) ? rawAccount : undefined;
  if (rawAccount && rawAccount !== "all" && !instagramAccountId) matchesNothing = true;

  const confidence = isConfidence(rawConfidence) ? rawConfidence : undefined;
  if (rawConfidence && rawConfidence !== "all" && !confidence) matchesNothing = true;

  const metric = isMetric(rawMetric) ? rawMetric : undefined;
  if (rawMetric && rawMetric !== "all" && !metric) matchesNothing = true;

  // A feature path is not a closed set at this layer: the run decides which
  // paths exist and the form is built from what it produced. Bounding the length
  // keeps an arbitrary string out of a query without pretending to validate it.
  const featurePath = rawFeature && rawFeature !== "all" ? rawFeature.slice(0, 128) : undefined;

  return Object.freeze({
    filters: Object.freeze({
      ...(confidence ? { confidence } : {}),
      ...(featurePath ? { featurePath } : {}),
      ...(instagramAccountId ? { instagramAccountId } : {}),
      ...(matchesNothing ? { matchesNothing: true } : {}),
      ...(metric ? { metric } : {}),
    }),
    values: Object.freeze({
      account: instagramAccountId ?? (rawAccount === "all" ? "" : rawAccount),
      confidence: confidence ?? "all",
      feature: featurePath ?? "",
      metric: metric ?? "all",
    }),
  });
}

export function hasActiveTrendFilters(values: TrendsFilterValues): boolean {
  return (
    values.account !== "" ||
    values.confidence !== "all" ||
    values.feature !== "" ||
    values.metric !== "all"
  );
}

/** The account filter has to survive into a detail link, or the detail 404s. */
export function trendDetailHref(statisticId: string, values: TrendsFilterValues): string {
  const params = new URLSearchParams();
  if (values.account) params.set("account", values.account);

  const query = params.toString();
  return query ? `/trends/${statisticId}?${query}` : `/trends/${statisticId}`;
}

export type TrendGroup = Readonly<{
  description: string;
  key: TrendSectionKey;
  title: string;
  trends: readonly TrendListItem[];
}>;

/**
 * Groups results into the four sections, in the contract's order.
 *
 * Empty sections are kept. A reader who filtered down to nothing but outliers
 * needs to see that the supported section is empty rather than absent — an
 * absent section reads as "there were none to show", which is the same shape as
 * "we did not look".
 */
export function groupTrends(trends: readonly TrendListItem[]): readonly TrendGroup[] {
  return Object.freeze(
    trendSections.map((section) =>
      Object.freeze({
        description: section.description,
        key: section.key,
        title: section.title,
        trends: Object.freeze(
          trends.filter((trend) => trendSectionFor(trend.confidence) === section.key),
        ),
      }),
    ),
  );
}

const confidenceTones: Readonly<Record<ConfidenceClass, StatusTone>> = Object.freeze({
  insufficient_evidence: "neutral",
  moderate_association: "information",
  single_post_outlier: "warning",
  statistically_supported_association: "success",
  weak_directional_signal: "information",
});

export function confidenceTone(classification: ConfidenceClass): StatusTone {
  return confidenceTones[classification];
}

/**
 * The one-line heading of a trend card.
 *
 * Deliberately descriptive rather than advisory. "Use question hooks" is a
 * recommendation the statistics do not license; naming the feature, the metric
 * and the account leaves the reader to draw the conclusion the evidence
 * actually supports.
 */
export function trendHeadline(trend: TrendListItem): string {
  return `${presentFeaturePath(trend.featurePath)}: ${presentFeatureValue(
    trend.featurePath,
    trend.featureValue,
  )}`;
}

export function trendAccessibleName(trend: TrendListItem): string {
  const metric = presentMetric(trend.metric);

  return `${trendHeadline(trend)} measured by ${metric.label}, ${presentConfidence(
    trend.confidence,
  ).label.toLowerCase()}`;
}

export type TrendComparisonRow = Readonly<{
  count: number;
  interquartileRange: string;
  label: string;
  median: string;
}>;

/**
 * The chart-equivalent table behind a trend.
 *
 * There is no chart on this screen at all, which is the simplest way to satisfy
 * "every chart has a table equivalent": the table is the primary presentation.
 * Medians and spreads say more about a skewed, small sample than any plot of
 * them would, and they survive a screen reader, a zoom and a 390px viewport
 * without a second implementation.
 */
export function comparisonRows(trend: TrendListItem): readonly TrendComparisonRow[] {
  const { unit } = presentMetric(trend.metric);

  return Object.freeze([
    Object.freeze({
      count: trend.groupCount,
      interquartileRange: formatMetricValue(trend.groupIqr, unit),
      label: `Posts with ${presentFeatureValue(trend.featurePath, trend.featureValue)}`,
      median: formatMetricValue(trend.groupMedian, unit),
    }),
    Object.freeze({
      count: trend.comparisonCount,
      interquartileRange: formatMetricValue(trend.comparisonIqr, unit),
      label: "Posts with another value",
      median: formatMetricValue(trend.comparisonMedian, unit),
    }),
  ]);
}

/**
 * The uncertainty range, or why there is none.
 *
 * An absent interval is not the same as a wide one. A comparison that never
 * reached the sample thresholds was never bootstrapped, and printing a dash
 * would let a reader take it for a precise result.
 */
export function presentInterval(trend: TrendListItem): string {
  if (trend.intervalLower === null || trend.intervalUpper === null) {
    return "Not calculated — the sample did not reach the threshold for an uncertainty range.";
  }

  const percent = trend.intervalConfidence === null ? null : trend.intervalConfidence * 100;
  const level = percent === null ? "" : `${percent.toFixed(0)}% `;

  return `${level}range for the difference: ${formatSigned(trend.intervalLower)} to ${formatSigned(
    trend.intervalUpper,
  )}`;
}

/** Missingness as the reader's question: how much of the account could be read. */
export function presentMissingness(trend: TrendListItem): string {
  const percent = trend.missingRatio * 100;

  if (percent < 1) return "Every eligible post could be classified for this feature.";

  return `${percent.toFixed(0)}% of otherwise eligible posts had no readable value for this feature.`;
}

export function presentSensitivity(trend: TrendListItem): string {
  if (trend.sensitivityHoldsDirection === null) {
    return "Not checked — the sample was too small to remove a post from.";
  }

  return trend.sensitivityHoldsDirection
    ? "Direction holds when the best or worst post is removed."
    : "Direction changes when the best or worst post is removed, so it rests on too few posts.";
}

export function formatPublicationWindow(from: string, to: string): string {
  const format = (value: string): string =>
    new Intl.DateTimeFormat("en-AU", {
      dateStyle: "medium",
      timeZone: "Australia/Sydney",
    }).format(new Date(value));

  return `${format(from)} to ${format(to)}`;
}

export function formatCalculatedAt(value: string): string {
  return new Intl.DateTimeFormat("en-AU", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Australia/Sydney",
  }).format(new Date(value));
}

/** How each snapshot-age window reads, so a reader knows what was compared. */
const ageWindowLabels: Readonly<Record<string, string>> = Object.freeze({
  day_1: "24 hours after publication",
  day_3: "3 days after publication",
  day_7: "7 days after publication",
  day_30: "30 days after publication",
  hour_1: "1 hour after publication",
  import: "at import",
  // Named for what it costs the reader rather than for the age it covers, since
  // it covers all of them. A comparison drawn here mixes posts measured at
  // different ages, which is weaker than one drawn at a matched age.
  lifetime: "at mixed ages, because too few posts share a comparable age",
  mature: "settled, more than 40 days after publication",
});

export function presentAgeWindow(ageWindow: string): string {
  return ageWindowLabels[ageWindow] ?? ageWindow;
}

function formatSigned(value: number): string {
  const percent = value * 100;
  return `${percent >= 0 ? "+" : ""}${percent.toFixed(2)}%`;
}

function isConfidence(value: string): value is ConfidenceClass {
  return (confidenceClasses as readonly string[]).includes(value);
}

function isMetric(value: string): value is DerivedMetric {
  return (derivedMetrics as readonly string[]).includes(value);
}

function firstValue(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}

function isUuidV7(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value);
}
