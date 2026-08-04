import { createHash } from "node:crypto";

import { analyticsVersion, type DerivedMetric } from "./analytics-metrics.js";

/**
 * Comparable cohort selection and robust baselines.
 *
 * One rule drives this module: a comparison is only meaningful between posts
 * observed at a comparable age. A post's numbers climb for days after it is
 * published, so a 6-hour observation and a 30-day observation of the same metric
 * are different measurements, and a median taken across both measures nothing.
 *
 * Selection therefore reads `postAgeSeconds` — the age at capture — and never the
 * stored `ageBucket`. Those are not the same question. `instagramSnapshotBuckets`
 * partitions every possible age so that each observation lands somewhere, which
 * means it assigns by upper edge alone: a snapshot taken 10 hours after
 * publication is stored as `day_1` because 10h is under 36h. The windows below
 * are tolerances, not a partition, and `day_1` means 18–36h. Trusting the stored
 * label would pull that 10-hour observation into a 24-hour cohort and quietly
 * compare an immature post against settled ones.
 *
 * Medians rather than means, because post performance is skewed and a single
 * viral post would otherwise move a baseline it should only ever be an outlier
 * against. Nothing here classifies confidence or reads a creative feature; those
 * consume this and are versioned alongside it.
 *
 * Nothing in this module performs a request or touches a database.
 */

export const cohortSelectionVersion = "account-cohort-v1.0.0" as const;

/**
 * Post-age tolerance windows, in seconds since publication.
 *
 * These deliberately overlap `instagramSnapshotBuckets` without matching it. The
 * upper edges agree, because both come from the same contract table, but each
 * window here also carries the lower edge that makes it a tolerance rather than a
 * catch-all, and a target to measure closeness against.
 *
 * `day_30` and `mature` both admit exactly 40 days. That overlap is intended: a
 * selection window answers "is this observation comparable for the requested
 * cohort", which two windows can both answer yes to, unlike a storage bucket
 * which must choose one home per row.
 *
 * `import` and `mature` have no target. Neither names a moment — one is "whatever
 * we could capture when the post was first imported", the other is "after the
 * numbers settled" — so closeness is undefined and the most mature observation in
 * the window wins instead.
 */
export const snapshotAgeWindows = Object.freeze([
  { key: "import", targetSeconds: null, minimumSeconds: 0, maximumSeconds: 1_800 },
  { key: "hour_1", targetSeconds: 3_600, minimumSeconds: 1_800, maximumSeconds: 7_200 },
  { key: "day_1", targetSeconds: 86_400, minimumSeconds: 64_800, maximumSeconds: 129_600 },
  { key: "day_3", targetSeconds: 259_200, minimumSeconds: 216_000, maximumSeconds: 345_600 },
  { key: "day_7", targetSeconds: 604_800, minimumSeconds: 518_400, maximumSeconds: 777_600 },
  {
    key: "day_30",
    targetSeconds: 2_592_000,
    minimumSeconds: 2_160_000,
    maximumSeconds: 3_456_000,
  },
  {
    key: "mature",
    targetSeconds: null,
    minimumSeconds: 3_456_000,
    maximumSeconds: Number.POSITIVE_INFINITY,
  },
  /**
   * Every observation, whatever its age.
   *
   * The only window with no storage bucket behind it: nothing is ever captured
   * "for lifetime", so it names a way of reading observations rather than a
   * moment to take one. Each post contributes its most mature snapshot.
   *
   * It exists because the alternative was worse. The windows above are
   * tolerances with deliberate gaps between them, so a post observed at five
   * days belongs to none of them, and an account could carry analysed posts that
   * no calculation would ever look at. A comparison drawn across mixed exposure
   * is weaker than one drawn at a matched age — but it is evidence, and the run
   * records that it used this window so a reader knows which they are looking at.
   *
   * Chosen only when no matched window has enough posts to compare, so it never
   * displaces a better answer.
   */
  {
    key: "lifetime",
    targetSeconds: null,
    minimumSeconds: 0,
    maximumSeconds: Number.POSITIVE_INFINITY,
  },
] as const);

export type SnapshotAgeWindow = (typeof snapshotAgeWindows)[number];
export type SnapshotAgeWindowKey = SnapshotAgeWindow["key"];

const windowsByKey = Object.freeze(
  Object.fromEntries(snapshotAgeWindows.map((window) => [window.key, window])) as Record<
    SnapshotAgeWindowKey,
    SnapshotAgeWindow
  >,
);

export function snapshotAgeWindowFor(key: SnapshotAgeWindowKey): SnapshotAgeWindow {
  return windowsByKey[key];
}

/** How settled a window is. Higher means the numbers have had longer to arrive. */
export function snapshotAgeWindowMaturity(key: SnapshotAgeWindowKey): number {
  return snapshotAgeWindows.findIndex((window) => window.key === key);
}

/**
 * Windows a recalculation may publish for, least to most mature.
 *
 * The earlier windows are absent on purpose. `import`, `hour_1`, `day_1` and
 * `day_3` observe a post while it is still being distributed, so a difference
 * between two groups there is as likely to be a difference in how far each has
 * been carried as one in the posts themselves.
 *
 * `mature` is included despite being unbounded, because it is the only window
 * that can see a post the account already had when it connected. It mixes
 * exposure times, which a run states as a limitation for count metrics; the
 * rate metrics that carry a strategy are not affected, since their numerator
 * and denominator accumulate together.
 */
export const recalculationWindowCandidates = Object.freeze([
  "day_7",
  "day_30",
  "mature",
  "lifetime",
] as const satisfies readonly SnapshotAgeWindowKey[]);

/**
 * The window that compares nothing at a matched age.
 *
 * Held apart from the others in selection: it admits every observation, so it
 * would always hold the most posts and would win any contest decided on sample
 * size alone — permanently hiding the matched comparison it is meant to stand in
 * for.
 */
export const unmatchedAgeWindow = "lifetime" as const satisfies SnapshotAgeWindowKey;

export type AnalyticsWindowCandidate = Readonly<{
  ageWindow: SnapshotAgeWindowKey;
  eligiblePosts: number;
}>;

function mostMature(candidates: readonly AnalyticsWindowCandidate[]): AnalyticsWindowCandidate {
  return candidates.reduce((winner, candidate) =>
    snapshotAgeWindowMaturity(candidate.ageWindow) > snapshotAgeWindowMaturity(winner.ageWindow)
      ? candidate
      : winner,
  );
}

/**
 * The window a run should publish for, or null when no window has anything.
 *
 * This is the default view the contract already describes: "the most mature
 * comparable bucket with adequate coverage". Past the coverage floor maturity
 * leads rather than sample size, because a settled observation is a better
 * basis for a claim than a larger immature one — a 7-day cohort measures how
 * far each post has been carried so far as much as it measures the posts.
 *
 * `adequateCoverage` is supplied rather than read here. The floor is a sampling
 * question and the thresholds that answer it are built on this module, so
 * taking it as an argument keeps the dependency pointing one way and puts the
 * choice where a reader can see it.
 *
 * When nothing clears the floor the floor cannot discriminate, so the largest
 * sample wins instead — publishing the widest evidence available beats
 * publishing nothing. The ordering is total and content-derived either way, so
 * the result cannot depend on the order candidates were assembled in.
 */
export function selectAnalyticsAgeWindow(
  candidates: readonly AnalyticsWindowCandidate[],
  adequateCoverage: number,
  /**
   * Posts a matched window needs before it is preferred to the unmatched one.
   *
   * Below this a matched comparison has too few posts to say anything, and
   * showing nothing at all is the worse answer: the account has analysed posts
   * and no calculation would ever look at them.
   */
  minimumMatchedPosts = 0,
): SnapshotAgeWindowKey | null {
  const measured = candidates.filter((candidate) => candidate.eligiblePosts > 0);
  if (measured.length === 0) return null;

  const matched = measured.filter((candidate) => candidate.ageWindow !== unmatchedAgeWindow);

  const covered = matched.filter((candidate) => candidate.eligiblePosts >= adequateCoverage);
  if (covered.length > 0) return mostMature(covered).ageWindow;

  const usable = matched.filter((candidate) => candidate.eligiblePosts >= minimumMatchedPosts);
  if (usable.length > 0) return widest(usable).ageWindow;

  // No matched window can compare anything. Reading every observation together
  // is weaker than comparing at one age, and it is what the account has.
  const unmatched = measured.find((candidate) => candidate.ageWindow === unmatchedAgeWindow);
  return unmatched ? unmatched.ageWindow : widest(measured).ageWindow;
}

function widest(candidates: readonly AnalyticsWindowCandidate[]): AnalyticsWindowCandidate {
  return candidates.reduce((winner, candidate) =>
    candidate.eligiblePosts > winner.eligiblePosts ||
    (candidate.eligiblePosts === winner.eligiblePosts &&
      snapshotAgeWindowMaturity(candidate.ageWindow) > snapshotAgeWindowMaturity(winner.ageWindow))
      ? candidate
      : winner,
  );
}

/**
 * Which comparison cohort a baseline was drawn from.
 *
 * These are not interchangeable and the contract requires the choice to survive
 * into storage and display: `recent` deliberately trades sample size for
 * currency, and `category` narrows to one versioned category value, so a reader
 * who cannot tell them apart cannot tell what a baseline meant.
 */
export const cohortKinds = Object.freeze(["account", "recent", "category"] as const);

export type CohortKind = (typeof cohortKinds)[number];

/** Previous eligible posts a `recent` cohort considers. */
export const recentCohortPostLimit = 20;

/** Publication window a `recent` cohort considers, in days. */
export const recentCohortDays = 90;

/**
 * Why a cohort or baseline produced no number.
 *
 * These stay distinct through to storage for the same reason the metric engine
 * keeps its own reasons apart: an empty cohort is a data-coverage fact, a
 * non-positive baseline is a real but unusable measurement, and a focal post
 * missing its own value is a different gap again.
 */
export const cohortUnavailabilityReasons = Object.freeze([
  "no_comparable_snapshot",
  "no_comparison_values",
  "baseline_not_positive",
  "focal_value_unavailable",
] as const);

export type CohortUnavailabilityReason = (typeof cohortUnavailabilityReasons)[number];

export type ComparableSnapshotCandidate = Readonly<{
  capturedAt: Date;
  postAgeSeconds: number;
  postId: string;
  snapshotId: string;
}>;

/**
 * Picks one snapshot per post for the requested window.
 *
 * A post is observed repeatedly, so without this a busy post would contribute
 * five observations to a median and a quiet one would contribute a single
 * observation, weighting the baseline by capture frequency rather than by post.
 *
 * Ordering is total and content-derived so the result cannot depend on the order
 * rows came back in: closest to target first, then the less mature observation,
 * then the earlier capture, then the snapshot ID. Preferring the less mature
 * observation on an exact tie is the conservative direction — it never credits a
 * post with time it had not yet accumulated.
 */
export function selectComparableSnapshot(
  candidates: readonly ComparableSnapshotCandidate[],
  windowKey: SnapshotAgeWindowKey,
): ComparableSnapshotCandidate | null {
  const window = windowsByKey[windowKey];
  const eligible = candidates.filter(
    (candidate) =>
      Number.isFinite(candidate.postAgeSeconds) &&
      candidate.postAgeSeconds >= window.minimumSeconds &&
      candidate.postAgeSeconds <= window.maximumSeconds,
  );

  if (eligible.length === 0) return null;

  // `mature` and `import` name no moment, so the most mature observation in the
  // window wins: it is the one with the most settled numbers.
  if (window.targetSeconds === null) {
    return [...eligible].sort(
      (left, right) =>
        right.postAgeSeconds - left.postAgeSeconds ||
        left.capturedAt.getTime() - right.capturedAt.getTime() ||
        left.snapshotId.localeCompare(right.snapshotId),
    )[0] as ComparableSnapshotCandidate;
  }

  const target = window.targetSeconds;

  return [...eligible].sort(
    (left, right) =>
      Math.abs(left.postAgeSeconds - target) - Math.abs(right.postAgeSeconds - target) ||
      left.postAgeSeconds - right.postAgeSeconds ||
      left.capturedAt.getTime() - right.capturedAt.getTime() ||
      left.snapshotId.localeCompare(right.snapshotId),
  )[0] as ComparableSnapshotCandidate;
}

/**
 * Applies {@link selectComparableSnapshot} per post.
 *
 * Posts with nothing inside the tolerance are absent from the result rather than
 * present with a null. An absent post is a coverage fact the caller must count;
 * a null would invite it to be treated as a post with no performance.
 */
export function selectComparableSnapshots(
  candidates: readonly ComparableSnapshotCandidate[],
  windowKey: SnapshotAgeWindowKey,
): ReadonlyMap<string, ComparableSnapshotCandidate> {
  const byPost = new Map<string, ComparableSnapshotCandidate[]>();
  for (const candidate of candidates) {
    const existing = byPost.get(candidate.postId);
    if (existing) existing.push(candidate);
    else byPost.set(candidate.postId, [candidate]);
  }

  const selected = new Map<string, ComparableSnapshotCandidate>();
  // Sorted so the map's iteration order is content-derived rather than the order
  // rows arrived in, which keeps a fingerprint over it stable.
  for (const postId of [...byPost.keys()].sort()) {
    const chosen = selectComparableSnapshot(byPost.get(postId) ?? [], windowKey);
    if (chosen) selected.set(postId, chosen);
  }

  return selected;
}

function ascending(values: readonly number[]): number[] {
  return values.filter((value) => Number.isFinite(value)).sort((left, right) => left - right);
}

/**
 * Reads a percentile from sorted values by linear interpolation.
 *
 * Interpolating rather than picking a nearest rank matters at v1 sample sizes:
 * with six posts a nearest-rank quartile jumps between two observations, so an
 * interquartile range would appear to change when nothing about the account did.
 */
function percentile(sorted: readonly number[], fraction: number): number | null {
  if (sorted.length === 0) return null;
  if (sorted.length === 1) return sorted[0] as number;

  const position = (sorted.length - 1) * fraction;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const lowerValue = sorted[lower] as number;
  if (lower === upper) return lowerValue;

  return lowerValue + ((sorted[upper] as number) - lowerValue) * (position - lower);
}

export function median(values: readonly number[]): number | null {
  return percentile(ascending(values), 0.5);
}

export type CohortSpread = Readonly<{
  count: number;
  firstQuartile: number | null;
  interquartileRange: number | null;
  maximum: number | null;
  median: number | null;
  minimum: number | null;
  thirdQuartile: number | null;
}>;

export function summariseSpread(values: readonly number[]): CohortSpread {
  const sorted = ascending(values);
  const firstQuartile = percentile(sorted, 0.25);
  const thirdQuartile = percentile(sorted, 0.75);

  return Object.freeze({
    count: sorted.length,
    firstQuartile,
    interquartileRange:
      firstQuartile === null || thirdQuartile === null ? null : thirdQuartile - firstQuartile,
    maximum: sorted.at(-1) ?? null,
    median: percentile(sorted, 0.5),
    minimum: sorted[0] ?? null,
    thirdQuartile,
  });
}

export type BaselineComparison = Readonly<{
  availability: "available" | "unavailable";
  baseline: number | null;
  comparisonCount: number;
  differenceFromBaseline: number | null;
  focalValue: number | null;
  percentDifference: number | null;
  reason: CohortUnavailabilityReason | null;
  /** Null when the baseline is not positive; a ratio needs a positive divisor. */
  relativeIndex: number | null;
}>;

/**
 * Compares one post against the median of a comparison cohort.
 *
 * The focal post is expected to be absent from `comparisonValues` already; see
 * {@link excludeFocalPost}. Leaving it in would let a post pull its own baseline
 * toward itself, which flatters every post in a small account.
 *
 * A zero baseline yields a difference but no relative index. Dividing by it would
 * produce an infinity that renders as a real multiple, and the contract is
 * explicit that a missing rate is unavailable rather than a number.
 */
export function compareToBaseline(
  focalValue: number | null,
  comparisonValues: readonly number[],
): BaselineComparison {
  const finite = comparisonValues.filter((value) => Number.isFinite(value));
  const baseline = median(finite);

  const unavailable = (reason: CohortUnavailabilityReason): BaselineComparison =>
    Object.freeze({
      availability: "unavailable" as const,
      baseline,
      comparisonCount: finite.length,
      differenceFromBaseline: null,
      focalValue,
      percentDifference: null,
      reason,
      relativeIndex: null,
    });

  if (focalValue === null || !Number.isFinite(focalValue))
    return unavailable("focal_value_unavailable");
  if (baseline === null) return unavailable("no_comparison_values");

  const differenceFromBaseline = focalValue - baseline;

  if (baseline <= 0) {
    return Object.freeze({
      availability: "unavailable" as const,
      baseline,
      comparisonCount: finite.length,
      differenceFromBaseline,
      focalValue,
      percentDifference: null,
      reason: "baseline_not_positive" as const,
      relativeIndex: null,
    });
  }

  return Object.freeze({
    availability: "available" as const,
    baseline,
    comparisonCount: finite.length,
    differenceFromBaseline,
    focalValue,
    percentDifference: (differenceFromBaseline / baseline) * 100,
    reason: null,
    relativeIndex: focalValue / baseline,
  });
}

/**
 * Removes the focal post from a comparison set.
 *
 * Kept separate from {@link compareToBaseline} so the exclusion is visible at the
 * call site and countable: the contract requires comparison counts to be
 * explicit, and a caller that could not exclude the focal post must say so rather
 * than silently comparing it against itself.
 */
export function excludeFocalPost<T extends Readonly<{ postId: string }>>(
  entries: readonly T[],
  focalPostId: string,
): readonly T[] {
  return Object.freeze(entries.filter((entry) => entry.postId !== focalPostId));
}

export type CohortCoverage = Readonly<{
  /** Posts that matched the cohort definition before any observation was read. */
  eligiblePosts: number;
  /** Share of eligible posts with no usable value, 0–1. */
  missingRatio: number;
  /** Eligible posts with a comparable snapshot but no value for this metric. */
  postsMissingMetric: number;
  /** Eligible posts with no snapshot inside the age tolerance. */
  postsMissingSnapshot: number;
  /** Posts contributing a value. */
  postsWithValue: number;
}>;

/**
 * Counts why eligible posts did or did not contribute.
 *
 * The two absences are reported separately because they call for different work:
 * a post missing a snapshot needs a capture at the right age, while a post
 * missing the metric has been observed and the provider returned nothing for it.
 * Collapsing them into one "missing" number would hide which of the two an
 * account is actually short of.
 */
export function summariseCoverage(
  input: Readonly<{
    eligiblePosts: number;
    postsMissingMetric: number;
    postsMissingSnapshot: number;
    postsWithValue: number;
  }>,
): CohortCoverage {
  const missing = input.postsMissingSnapshot + input.postsMissingMetric;

  return Object.freeze({
    eligiblePosts: input.eligiblePosts,
    missingRatio: input.eligiblePosts === 0 ? 0 : missing / input.eligiblePosts,
    postsMissingMetric: input.postsMissingMetric,
    postsMissingSnapshot: input.postsMissingSnapshot,
    postsWithValue: input.postsWithValue,
  });
}

export type CohortDefinition = Readonly<{
  ageWindow: SnapshotAgeWindowKey;
  /** Set for a `category` cohort, null otherwise. */
  categoryValue: string | null;
  instagramAccountId: string;
  kind: CohortKind;
  /** Inclusive publication bounds, as ISO strings. */
  publishedFrom: string;
  publishedTo: string;
  metric: DerivedMetric;
}>;

export type CohortFingerprintInput = Readonly<{
  definition: CohortDefinition;
  /** Every snapshot that contributed, in any order. */
  snapshotIds: readonly string[];
}>;

/**
 * Fingerprints exactly the inputs a cohort was computed from.
 *
 * It covers the definition and the contributing snapshot IDs, and deliberately
 * not the resulting numbers or the calculation time. That makes it answer "would
 * recalculating change anything" rather than "did the output change", which is
 * the question the debounced recalculation in #52 needs to ask before spending a
 * run. Snapshot rows are immutable, so an identical ID set is identical data.
 *
 * The version constants are included so an analytics or selection change
 * invalidates every fingerprint rather than leaving stale results looking fresh.
 */
export function createCohortFingerprint(input: CohortFingerprintInput): string {
  const canonical = JSON.stringify([
    analyticsVersion,
    cohortSelectionVersion,
    input.definition.kind,
    input.definition.instagramAccountId,
    input.definition.metric,
    input.definition.ageWindow,
    input.definition.categoryValue,
    input.definition.publishedFrom,
    input.definition.publishedTo,
    [...input.snapshotIds].sort(),
  ]);

  return createHash("sha256").update(canonical, "utf8").digest("hex");
}
