import {
  derivedMetricDefinitions,
  type DerivedMetric,
  type DerivedMetricUnit,
} from "./analytics-metrics.js";
import {
  durationBands,
  type ClassificationReason,
  type ConfidenceClass,
} from "./analytics-statistics.js";

/**
 * How a calculated trend is described to a reader.
 *
 * Every string a reader sees about evidence strength is here rather than in a
 * component, because the analytics contract constrains the wording and a
 * constraint spread across a view layer is a constraint nobody can check. Two
 * rules do most of the work:
 *
 * An association is never stated as a cause. "Posts with a question hook
 * performed better" is a claim about what would happen if you changed the hook;
 * the contract does not support one, so the copy says what was observed and
 * where it was observed.
 *
 * Every claim names its scope, and the scope is real rather than a hedge: a
 * cohort is bounded either to one account or to every linked account pooled, and
 * those describe different populations. That is why the copy is keyed by scope
 * instead of written once — "in this account's history" is a lie about a pooled
 * comparison, and "across every linked account" is a lie about a single one.
 *
 * The model's own confidence in reading a video never appears here. It says how
 * well the model could see a feature, not how much evidence there is that the
 * feature matters, and presenting one as the other is the single most misleading
 * thing this screen could do.
 */

/**
 * Whose history a calculation measured.
 *
 * `pooled` is every linked account counted together, which is a different
 * population rather than a wider view of the same one: the accounts have
 * different audiences, so a pooled median describes neither of them on its own.
 * Nothing downstream may treat the two as interchangeable, which is why the
 * scope is a type rather than a boolean buried in a component.
 */
export type AnalyticsScope = "account" | "pooled";

export type TrendSectionKey = "supported" | "directional" | "outlier" | "limited";

export type TrendSection = Readonly<{
  /** Why this group exists, in the reader's terms. */
  description: string;
  key: TrendSectionKey;
  title: string;
}>;

/** Only the supported section makes a claim about scope; the rest read the same either way. */
const supportedDescriptions: Readonly<Record<AnalyticsScope, string>> = Object.freeze({
  account:
    "Differences large enough, consistent enough and drawn from enough posts that they are unlikely to be noise. Still an association within this account, not a cause.",
  pooled:
    "Differences large enough, consistent enough and drawn from enough posts that they are unlikely to be noise. Still an association across the linked accounts taken together, not a cause.",
});

function sectionsFor(scope: AnalyticsScope): readonly TrendSection[] {
  return Object.freeze([
    Object.freeze({
      description: supportedDescriptions[scope],
      key: "supported" as const,
      title: "Supported associations",
    }),
    Object.freeze({
      description:
        "A direction worth testing. The difference is visible but the sample or the uncertainty is not yet enough to rely on it.",
      key: "directional" as const,
      title: "Directional signals",
    }),
    Object.freeze({
      description:
        "Carried by one post, or reversed when the best post is removed. Shown rather than hidden, because a pattern that depends on a single post is exactly what a summary would conceal.",
      key: "outlier" as const,
      title: "Outliers and counterexamples",
    }),
    Object.freeze({
      description:
        "Comparisons that could not be answered yet, and what is missing. Not a finding of no difference.",
      key: "limited" as const,
      title: "Not enough evidence",
    }),
  ]);
}

const trendSectionsByScope: Readonly<Record<AnalyticsScope, readonly TrendSection[]>> =
  Object.freeze({
    account: sectionsFor("account"),
    pooled: sectionsFor("pooled"),
  });

/**
 * The order results are read in.
 *
 * Supported first, limitations last. A reader who stops after the first section
 * should have seen the strongest evidence rather than the loudest number, and a
 * reader who reaches the end should find what the data could not answer instead
 * of an empty screen.
 */
export function trendSectionsFor(scope: AnalyticsScope): readonly TrendSection[] {
  return trendSectionsByScope[scope];
}

export function trendSectionFor(classification: ConfidenceClass): TrendSectionKey {
  switch (classification) {
    case "statistically_supported_association":
    case "moderate_association":
      return "supported";
    case "weak_directional_signal":
      return "directional";
    case "single_post_outlier":
      return "outlier";
    case "insufficient_evidence":
      return "limited";
  }
}

export type ConfidencePresentation = Readonly<{
  /**
   * One sentence a reader can act on, per scope. Never causal.
   *
   * Keyed rather than written once because the sentence has to name whose
   * history it describes, and a single string would be false for one of the two
   * scopes. The label and the badge are the same either way: the class says how
   * strong the evidence is, not who it is about.
   */
  claim: Readonly<Record<AnalyticsScope, string>>;
  label: string;
  /** True only for the class the contract allows a strong badge for. */
  strong: boolean;
}>;

const confidencePresentations: Readonly<Record<ConfidenceClass, ConfidencePresentation>> =
  Object.freeze({
    insufficient_evidence: Object.freeze({
      claim: Object.freeze({
        account:
          "There is not enough evidence in this account to compare these posts yet. This is not a finding that the feature makes no difference.",
        pooled:
          "There is not enough evidence across the linked accounts to compare these posts yet. This is not a finding that the feature makes no difference.",
      }),
      label: "Insufficient evidence",
      strong: false,
    }),
    moderate_association: Object.freeze({
      claim: Object.freeze({
        account:
          "A moderate observed association in this account's history. It describes what these posts did, not why they did it.",
        pooled:
          "A moderate observed association across the linked accounts' combined history. It describes what these posts did, not why they did it, and it is not a claim about either account on its own.",
      }),
      label: "Moderate association",
      strong: false,
    }),
    single_post_outlier: Object.freeze({
      claim: Object.freeze({
        account:
          "Driven by a single post in this account. Worth reading on its own terms; it is not a pattern.",
        pooled:
          "Driven by a single post among the linked accounts. Worth reading on its own terms; it is not a pattern.",
      }),
      label: "Single-post outlier",
      strong: false,
    }),
    statistically_supported_association: Object.freeze({
      claim: Object.freeze({
        account:
          "A statistically supported association in this account's history. This does not establish causation.",
        // A pooled comparison is held at moderate while the uncertainty range
        // still treats posts from the same account as independent, so this
        // sentence should never reach a reader. It is written honestly anyway:
        // copy that only exists to be unreachable is copy nobody maintains, and
        // the cap is a property of the calculation rather than of the wording.
        pooled:
          "A statistically supported association across the linked accounts' combined history. This does not establish causation, and it is not a claim about either account on its own.",
      }),
      label: "Statistically supported",
      strong: true,
    }),
    weak_directional_signal: Object.freeze({
      claim: Object.freeze({
        account: "A weak directional signal in this account; test it further before relying on it.",
        pooled:
          "A weak directional signal across the linked accounts; test it further before relying on it.",
      }),
      label: "Weak directional signal",
      strong: false,
    }),
  });

export function presentConfidence(classification: ConfidenceClass): ConfidencePresentation {
  return confidencePresentations[classification];
}

export type TrendScopePresentation = Readonly<{
  /** The screen's own subtitle: whose history every figure below came from. */
  description: string;
  /** A trailing clause naming the calculation one figure was read from. */
  source: string;
}>;

const scopePresentations: Readonly<Record<AnalyticsScope, TrendScopePresentation>> = Object.freeze({
  account: Object.freeze({
    description: "What this account's own history shows, and how strong the evidence is.",
    source: "in this account's published calculation",
  }),
  pooled: Object.freeze({
    description:
      "What the linked accounts' history shows when they are measured together, and how strong the evidence is.",
    source: "in the published calculation across every linked account",
  }),
});

/**
 * How a screen names the population it is describing.
 *
 * Kept beside the claims rather than in a component because it is the same
 * constraint: a heading that says "this account" over pooled figures misleads
 * exactly as much as a claim that does, and nobody reviewing a component would
 * check it against the contract.
 */
export function presentTrendScope(scope: AnalyticsScope): TrendScopePresentation {
  return scopePresentations[scope];
}

/**
 * What was missing, and what would answer it.
 *
 * Every reason names the next experiment rather than stopping at the diagnosis.
 * "Insufficient evidence" on its own tells a reader nothing they can act on, and
 * the acceptance criteria require the difference between "no pattern" and "we
 * could not measure this" to be legible.
 */
const classificationExplanations: Readonly<Record<ClassificationReason, string>> = Object.freeze({
  below_minimum_samples:
    "Too few posts on one side of the comparison. Publishing more posts with and without this feature is what closes the gap.",
  effect_below_threshold:
    "The difference is real but small — under the 10% the contract treats as practically meaningful. Nothing to act on either way.",
  few_publication_dates:
    "The posts carrying this feature were published across too few dates, so the result would reflect when they went out as much as what they were.",
  interval_ignores_clustering:
    "Measured across every linked account at once, where the uncertainty range treats each post as independent and posts from the same account are not. Held at moderate until the range accounts for that; the same comparison within one account can still reach the stronger class.",
  interval_includes_no_difference:
    "The uncertainty range still includes no difference at all. More posts would narrow it.",
  meets_moderate_thresholds: "Meets the sample, effect and uncertainty thresholds for this class.",
  meets_supported_thresholds:
    "Meets the sample, effect, uncertainty, spread and multiple-testing thresholds for this class.",
  missingness_too_high:
    "More than 40% of otherwise eligible posts had no readable value for this feature, so what is missing could change the answer.",
  multiple_testing_rejected:
    "Did not survive the correction applied across every comparison calculated together. Testing many features and reporting the strongest is how noise becomes a finding.",
  one_source_dominates_sample:
    "Most of the posts on one side of this comparison came from a single source — one campaign, or one account when accounts are measured together — so it would describe that source rather than the feature.",
  sensitivity_changes_materiality:
    "Removing the best or worst post changes the result materially, so it rests on too few posts to generalise.",
  single_eligible_post:
    "Only one post carries this feature. Publishing more is the only thing that turns it into a comparison.",
  top_post_dominates_total:
    "One post accounts for more than half the group's total, so the group median describes that post more than the feature.",
});

export function explainClassification(reason: ClassificationReason): string {
  return classificationExplanations[reason];
}

/** Human label for a feature path, and for the taxonomy value beneath it. */
const featureLabels: Readonly<Record<string, string>> = Object.freeze({
  "callToAction.type": "Call to action",
  "content.contentFormat": "Format",
  "content.contentPillar": "Content pillar",
  "content.durationBand": "Duration",
  "content.hook.category": "Hook type",
  "content.presenterMode": "Presenter",
});

export function presentFeaturePath(path: string): string {
  return featureLabels[path] ?? path;
}

const durationBandLabels: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(durationBands.map((band) => [band.key, band.label])),
);

/**
 * Turns a stored taxonomy value into a label.
 *
 * Duration bands carry their own label from the domain definition so the
 * displayed boundaries and the calculated ones cannot drift apart. Everything
 * else is a snake_case taxonomy term, which is readable once unpicked and which
 * the presenter must not silently rename — a value the reader sees has to match
 * the value the analysis recorded.
 */
export function presentFeatureValue(path: string, value: string): string {
  if (path === "content.durationBand") return durationBandLabels[value] ?? value;

  const spaced = value.replaceAll("_", " ");

  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

export type MetricPresentation = Readonly<{
  /** The exact expression the value came from. */
  formula: string;
  /** What the value was divided by, or null for a count. */
  denominator: string | null;
  label: string;
  limitations: readonly string[];
  unit: DerivedMetricUnit;
}>;

const metricLabels: Readonly<Record<DerivedMetric, string>> = Object.freeze({
  average_watch_percentage: "Average watch percentage",
  comment_rate_reach: "Comment rate",
  completion_proxy: "Completion proxy",
  engagement_count: "Engagement count",
  engagement_rate_reach: "Engagement rate",
  follow_conversion_rate: "Follow conversion rate",
  follow_rate_reach: "Follow rate",
  like_rate_reach: "Like rate",
  profile_visit_rate_reach: "Profile visit rate",
  save_rate_reach: "Save rate",
  share_rate_reach: "Share rate",
});

/**
 * Names a metric and the denominator it is a rate of.
 *
 * The denominator travels with the label everywhere it is shown, because
 * `follow_rate_reach` and `follow_conversion_rate` share a numerator and answer
 * different questions. "Follow rate" alone is ambiguous between them.
 */
export function presentMetric(metric: DerivedMetric): MetricPresentation {
  const definition = derivedMetricDefinitions[metric];

  return Object.freeze({
    denominator:
      definition.denominator.kind === "none" ? null : (definition.denominator.label ?? null),
    formula: definition.formula,
    label: metricLabels[metric],
    limitations: definition.limitations,
    unit: definition.unit,
  });
}

/**
 * Formats a metric value in its own unit.
 *
 * A ratio is shown as a percentage and a count as a count. Returning a bare
 * number and letting a component decide would put the unit decision next to the
 * markup, where a rate can quietly become a count.
 */
export function formatMetricValue(value: number | null, unit: DerivedMetricUnit): string {
  if (value === null || !Number.isFinite(value)) return "Not available";
  if (unit === "count") return value.toLocaleString("en-AU", { maximumFractionDigits: 0 });

  return `${(value * 100).toFixed(2)}%`;
}

/**
 * Formats the difference between the group and its comparison.
 *
 * Signed deliberately: the direction is the finding, and an unsigned magnitude
 * beside the word "difference" reads as an improvement whichever way it went.
 */
export function formatRelativeEffect(effect: number | null): string {
  if (effect === null || !Number.isFinite(effect)) return "Not available";

  const percent = effect * 100;
  const rounded = Math.abs(percent) < 10 ? percent.toFixed(1) : percent.toFixed(0);

  return `${percent >= 0 ? "+" : ""}${rounded}%`;
}

/** How stale a published calculation is allowed to look before it is called out. */
export const trendStalenessMs = 24 * 60 * 60 * 1_000;

export function isTrendCalculationStale(activatedAt: Date, now: Date): boolean {
  return now.getTime() - activatedAt.getTime() > trendStalenessMs;
}
