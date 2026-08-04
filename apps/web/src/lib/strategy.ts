import type {
  StrategyEvidenceEntry,
  StrategyRequestPreview,
  StrategySummary,
} from "@studio-parallel/db";
import {
  derivedMetrics,
  presentMetric,
  type DerivedMetric,
  type StrategyEvidenceClass,
  type StrategyMode,
} from "@studio-parallel/domain";

/**
 * How a strategy reads, without deciding anything about it.
 *
 * Nothing here classifies, ranks or infers. The classification on a claim was
 * settled when the strategy was generated and is rendered as it was stored; a
 * screen that recomputed it could disagree with the evidence beside it, which
 * is the one thing a reader has no way to detect.
 *
 * Language is fixed rather than composed. "Appears associated in this account"
 * and "creative proposal" are the contract's terms, and paraphrasing them would
 * let a proposal read as a finding.
 */

export const strategySections = [
  "working",
  "weak",
  "tests",
  "recommendations",
  "pillars",
  "limitations",
] as const;

export type StrategySectionKey = (typeof strategySections)[number];

/** Section order is the contract's, not a layout choice. Decisions lead. */
export const strategySectionTitles: Readonly<Record<StrategySectionKey, string>> = Object.freeze({
  limitations: "What this cannot tell you",
  pillars: "Where to spend the next posts",
  recommendations: "Videos to make next",
  tests: "What to test next",
  weak: "What is not working",
  working: "What is working",
});

/**
 * What a section means when it is empty.
 *
 * Every section renders even with nothing in it, because a missing section and
 * an empty one look identical once the page is scrolled, and they mean opposite
 * things.
 */
export const strategySectionEmptyText: Readonly<Record<StrategySectionKey, string>> = Object.freeze(
  {
    limitations: "No limitations were recorded, which is itself unusual — treat with caution.",
    pillars: "No allocation was proposed for this period.",
    recommendations: "No videos were proposed.",
    tests: "No experiments were proposed.",
    weak: "Nothing was identified as working against this account in this period.",
    working:
      "Nothing reached the evidence needed to call it a working pattern. That is not a finding that nothing works.",
  },
);

/**
 * How each classification should be spoken about.
 *
 * Taken verbatim from the capability's terminology. A creative proposal is
 * never described in the language of evidence, however confident it sounds.
 */
export const strategyClassificationLabels: Readonly<Record<StrategyEvidenceClass, string>> =
  Object.freeze({
    creative_recommendation: "Creative proposal",
    insufficient_evidence: "Insufficient evidence",
    moderate_association: "Appears associated in this account",
    single_post_outlier: "Single-post outlier",
    statistically_supported_association: "Statistically supported in this account",
    unsupported: "Unsupported",
    weak_directional_signal: "Directional signal",
  });

export type StrategyTone = "danger" | "information" | "success" | "warning";

/** Only a supported association reads as strong. Nothing else is dressed up. */
export function strategyClassificationTone(classification: StrategyEvidenceClass): StrategyTone {
  switch (classification) {
    case "statistically_supported_association":
      return "success";
    case "moderate_association":
      return "information";
    case "weak_directional_signal":
    case "single_post_outlier":
      return "warning";
    default:
      return "danger";
  }
}

export const strategyModeLabels: Readonly<Record<StrategyMode, string>> = Object.freeze({
  evidence_led: "Evidence-led",
  exploratory: "Exploratory",
});

/**
 * What a mode commits the reader to.
 *
 * An exploratory strategy has to say so before anything it proposes is read,
 * because its proposals look exactly like an evidence-led one's.
 */
export const strategyModeDescriptions: Readonly<Record<StrategyMode, string>> = Object.freeze({
  evidence_led:
    "Built from this account's measured comparisons. Every empirical claim links to the evidence behind it.",
  exploratory:
    "Built with less evidence than an evidence-led strategy requires. Nothing here is a supported finding; it proposes experiments and data to collect.",
});

export function strategyDetailHref(strategyId: string): string {
  return `/strategy/${strategyId}`;
}

/**
 * What a cited evidence id resolves to.
 *
 * `missing` is the tombstone case and is deliberately distinct from `citation`.
 * A claim whose evidence has gone must say so where the claim is read; dropping
 * the row, or substituting the nearest surviving evidence, would leave the claim
 * looking as well-supported as one whose evidence is still there.
 */
export type StrategyEvidenceLink =
  | Readonly<{ entry: StrategyEvidenceEntry; href: string; kind: "link" }>
  | Readonly<{ entry: StrategyEvidenceEntry; kind: "citation" }>
  | Readonly<{ evidenceId: string; kind: "missing" }>;

/**
 * Where an entry can be opened, when it stands on a row a screen can show.
 *
 * A statistic opens the trend it came from and a post opens its source video.
 * Anything else — a data-quality note synthesised from the sample, a prior
 * strategy, a raw snapshot — is cited without a link rather than pointed at a
 * page that does not exist.
 */
function evidenceHref(entry: StrategyEvidenceEntry): string | null {
  if (entry.referenceId === null) return null;

  switch (entry.evidenceType) {
    case "feature_statistic":
      return `/trends/${entry.referenceId}`;
    case "post":
      return `/posts/${entry.referenceId}/source-video`;
    default:
      return null;
  }
}

export function resolveStrategyEvidence(
  manifest: readonly StrategyEvidenceEntry[],
  evidenceId: string,
): StrategyEvidenceLink {
  const entry = manifest.find((candidate) => candidate.evidenceKey === evidenceId);
  if (entry === undefined) return Object.freeze({ evidenceId, kind: "missing" as const });

  const href = evidenceHref(entry);
  return href === null
    ? Object.freeze({ entry, kind: "citation" as const })
    : Object.freeze({ entry, href, kind: "link" as const });
}

/** Said where the claim is read, not collected into a footnote. */
export const strategyEvidenceTombstone =
  "This evidence is no longer available. The claim above is left as it was written, and cannot be checked.";

/** A generation that has published a result a reader can open. */
export function isReadableStrategy(summary: StrategySummary): boolean {
  return summary.state === "SUCCEEDED";
}

export type StrategyRequestState = "failed" | "readable" | "running";

export function strategyRequestState(summary: StrategySummary): StrategyRequestState {
  if (summary.state === "SUCCEEDED") return "readable";
  return summary.state === "FAILED" ? "failed" : "running";
}

export const strategyRequestStateLabels: Readonly<Record<StrategyRequestState, string>> =
  Object.freeze({
    failed: "Did not complete",
    readable: "Generated",
    running: "In progress",
  });

export function strategyRequestStateTone(state: StrategyRequestState): StrategyTone {
  switch (state) {
    case "readable":
      return "success";
    case "failed":
      return "danger";
    default:
      return "information";
  }
}

function formatDay(value: string): string {
  return new Intl.DateTimeFormat("en-AU", {
    day: "numeric",
    month: "short",
    timeZone: "Australia/Sydney",
    year: "numeric",
  }).format(new Date(value));
}

export function formatStrategyPeriod(summary: StrategySummary): string {
  return `${formatDay(summary.publishedFrom)} to ${formatDay(summary.publishedTo)}`;
}

/**
 * The one metric a strategy is generated against.
 *
 * Held here rather than at each call site so the preview a reader agrees to and
 * the request that is actually made cannot drift apart: the counts shown before
 * the button would otherwise be able to describe a different measure from the
 * one the strategy is built on.
 */
export const strategyPrimaryMetric = "engagement_rate_reach";

/** Falls back to the stored string rather than inventing a label for it. */
export function strategyMetricLabel(metric: string): string {
  return (derivedMetrics as readonly string[]).includes(metric)
    ? presentMetric(metric as DerivedMetric).label
    : metric;
}

/**
 * The period the preview would cover, when there is one.
 *
 * An account with nothing to read has no period rather than an empty one, and
 * saying so is what tells a reader the counts beneath are zero because nothing
 * has been analysed, not because the window is narrow.
 */
export function describeStrategyPreviewPeriod(preview: StrategyRequestPreview): string {
  if (preview.publishedFrom === null || preview.publishedTo === null) {
    return "No posts in range yet";
  }

  return `${formatDay(preview.publishedFrom)} to ${formatDay(preview.publishedTo)}`;
}

export function formatStrategyTimestamp(value: string): string {
  return new Intl.DateTimeFormat("en-AU", {
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    month: "short",
    timeZone: "Australia/Sydney",
  }).format(new Date(value));
}

/**
 * The evidence counts, phrased so the sample stays next to the claim.
 *
 * Kept as one string because these three numbers are only meaningful together:
 * an analysed count without a comparable count invites reading coverage as
 * evidence.
 */
export function describeStrategyEvidence(summary: StrategySummary): string {
  return `${String(summary.analysedPostCount)} analysed posts, ${String(
    summary.comparablePostCount,
  )} with a comparable value, across ${String(summary.publicationWeekCount)} publication weeks`;
}

/** Why a request was refused, in the reader's terms rather than a code. */
export const strategyRefusalMessages: Readonly<Record<string, string>> = Object.freeze({
  account_not_found: "Connect an Instagram account before generating a strategy.",
  exploratory_not_confirmed:
    "This account has less evidence than an evidence-led strategy needs. Confirm an exploratory strategy to continue.",
  metric_not_comparable: "That metric has no comparable values in this account.",
  no_active_calculation:
    "No calculation has been published yet. Trends are calculated from analysed posts, and a strategy reads those trends.",
  no_analysed_posts:
    "No posts have been analysed yet. Upload a source video for a post and analyse it to begin.",
  stale_calculation:
    "A recalculation is in progress. A strategy generated now would cite numbers that have already changed.",
});

export function describeStrategyRefusal(reason: string | null): string | null {
  if (reason === null) return null;
  return strategyRefusalMessages[reason] ?? "This account cannot generate a strategy yet.";
}
