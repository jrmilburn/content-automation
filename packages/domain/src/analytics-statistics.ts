import { createHash } from "node:crypto";

import { median, summariseSpread, type CohortSpread } from "./analytics-cohorts.js";

/**
 * Feature statistics: effect, uncertainty, sensitivity and confidence.
 *
 * Everything here is deterministic. The bootstrap is seeded from the inputs, so
 * the same posts always produce the same interval — a confidence class that
 * changed between two runs over unchanged data would be indefensible to anyone
 * reading a trend, and impossible to test.
 *
 * The rules encoded here are conservative by design. v1 samples are small, post
 * performance is skewed, and the cost of overstating a pattern is that someone
 * changes how they make videos for no reason. Every threshold comes from
 * `docs/technical/analytics-and-metrics.md`; none is invented here.
 *
 * Nothing in this module performs a request or touches a database.
 */

export const statisticsVersion = "account-statistics-v1.0.0" as const;

/**
 * How much evidence a comparison carries.
 *
 * Ordered weakest to strongest. `single_post_outlier` is not a weaker version of
 * a signal — it is a specific finding that one post is carrying the group, and
 * converting it into a general pattern is the mistake this class exists to
 * prevent.
 */
export const confidenceClasses = [
  "insufficient_evidence",
  "single_post_outlier",
  "weak_directional_signal",
  "moderate_association",
  "statistically_supported_association",
] as const;

export type ConfidenceClass = (typeof confidenceClasses)[number];

/** Why a comparison landed in its class. Stored so a reader can see the reason. */
export const classificationReasons = [
  "below_minimum_samples",
  "effect_below_threshold",
  "few_publication_dates",
  "interval_ignores_clustering",
  "interval_includes_no_difference",
  "meets_moderate_thresholds",
  "meets_supported_thresholds",
  "missingness_too_high",
  "multiple_testing_rejected",
  "one_source_dominates_sample",
  "sensitivity_changes_materiality",
  "single_eligible_post",
  "top_post_dominates_total",
] as const;

export type ClassificationReason = (typeof classificationReasons)[number];

/** Minimum samples per class, from the contract. */
export const sampleThresholds = Object.freeze({
  moderate: Object.freeze({ comparison: 12, group: 8, total: 20 }),
  supported: Object.freeze({
    comparison: 24,
    group: 12,
    publicationWeeks: 6,
  }),
  weak: Object.freeze({ comparison: 5, group: 3 }),
});

/** A median difference smaller than this is not worth acting on. */
export const practicalEffectThreshold = 0.1;

/** Distinct publication dates below which a group is not evidence. */
export const minimumPublicationDates = 3;

/** Share of eligible posts that may lack the metric before the group is unusable. */
export const maximumMissingRatio = 0.4;

/** Benjamini-Hochberg false-discovery rate for the supported class. */
export const falseDiscoveryRate = 0.1;

/** Bootstrap resamples. Fixed so an interval is reproducible, not tunable. */
export const bootstrapResamples = 2_000;

/**
 * Duration bands, in seconds.
 *
 * Predefined and versioned rather than derived. Searching for the cut point that
 * produces the strongest effect and presenting that is how a dataset is made to
 * say anything; the contract forbids it, and fixed bands are the enforcement.
 */
export const durationBands = Object.freeze([
  { key: "under_15s", label: "<15s", maximumSeconds: 15, minimumSeconds: 0 },
  { key: "15_29s", label: "15–29s", maximumSeconds: 30, minimumSeconds: 15 },
  { key: "30_44s", label: "30–44s", maximumSeconds: 45, minimumSeconds: 30 },
  { key: "45_59s", label: "45–59s", maximumSeconds: 60, minimumSeconds: 45 },
  { key: "60_89s", label: "60–89s", maximumSeconds: 90, minimumSeconds: 60 },
  {
    key: "90s_plus",
    label: "90s+",
    maximumSeconds: Number.POSITIVE_INFINITY,
    minimumSeconds: 90,
  },
] as const);

export type DurationBandKey = (typeof durationBands)[number]["key"];

export function durationBandFor(seconds: number): DurationBandKey | null {
  if (!Number.isFinite(seconds) || seconds < 0) return null;

  return (
    durationBands.find((band) => seconds >= band.minimumSeconds && seconds < band.maximumSeconds)
      ?.key ?? null
  );
}

/**
 * A deterministic uniform generator.
 *
 * A bootstrap needs randomness that is identical every run, so this is seeded
 * from the data rather than from a clock. `mulberry32` is used because it is
 * short enough to read and verify: an unreviewable PRNG inside a statistic
 * nobody can reproduce would defeat the purpose.
 */
function createGenerator(seed: number): () => number {
  let state = seed >>> 0;

  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), state | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);

    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/** Derives the bootstrap seed from the values themselves. */
export function createBootstrapSeed(input: {
  comparison: readonly number[];
  group: readonly number[];
  key: string;
}): number {
  const canonical = JSON.stringify([
    input.key,
    [...input.group].sort(),
    [...input.comparison].sort(),
  ]);
  const digest = createHash("sha256").update(canonical, "utf8").digest();

  return digest.readUInt32BE(0);
}

export type BootstrapInterval = Readonly<{
  /** Whether the interval excludes a difference of zero. */
  excludesNoDifference: boolean;
  lower: number;
  resamples: number;
  seed: number;
  upper: number;
}>;

function percentileOf(sorted: readonly number[], fraction: number): number {
  const position = (sorted.length - 1) * fraction;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const value = sorted[lower] as number;

  return lower === upper ? value : value + ((sorted[upper] as number) - value) * (position - lower);
}

/**
 * Bootstraps the difference between two medians.
 *
 * The difference of medians is resampled rather than the medians themselves,
 * because the question is whether the gap is distinguishable from zero, and a
 * pair of separate intervals cannot answer that.
 */
export function bootstrapMedianDifference(
  input: Readonly<{
    comparison: readonly number[];
    confidence: number;
    group: readonly number[];
    seed: number;
  }>,
): BootstrapInterval | null {
  const group = input.group.filter(Number.isFinite);
  const comparison = input.comparison.filter(Number.isFinite);

  if (group.length === 0 || comparison.length === 0) return null;

  const next = createGenerator(input.seed);
  const differences: number[] = [];

  for (let resample = 0; resample < bootstrapResamples; resample += 1) {
    const groupSample: number[] = [];
    const comparisonSample: number[] = [];

    for (let index = 0; index < group.length; index += 1) {
      groupSample.push(group[Math.floor(next() * group.length)] as number);
    }
    for (let index = 0; index < comparison.length; index += 1) {
      comparisonSample.push(comparison[Math.floor(next() * comparison.length)] as number);
    }

    differences.push((median(groupSample) ?? 0) - (median(comparisonSample) ?? 0));
  }

  differences.sort((left, right) => left - right);

  const tail = (1 - input.confidence) / 2;
  const lower = percentileOf(differences, tail);
  const upper = percentileOf(differences, 1 - tail);

  return Object.freeze({
    excludesNoDifference: (lower > 0 && upper > 0) || (lower < 0 && upper < 0),
    lower,
    resamples: bootstrapResamples,
    seed: input.seed,
    upper,
  });
}

export type SensitivityResult = Readonly<{
  /** Smallest relative effect seen across the leave-one-out refits. */
  minimumRelativeEffect: number | null;
  /** True when every refit kept the sign of the original difference. */
  preservesDirection: boolean;
  /** True when removing the best and worst group values keeps the direction. */
  removeBestWorstPreservesDirection: boolean | null;
}>;

function relativeEffect(groupMedian: number, comparisonMedian: number): number | null {
  if (comparisonMedian === 0) return null;

  return (groupMedian - comparisonMedian) / Math.abs(comparisonMedian);
}

/**
 * Refits the effect without each group value in turn.
 *
 * The contract asks for this because one post can carry a small group entirely.
 * A pattern that disappears when any single video is removed is a fact about
 * that video, not about the account.
 */
export function evaluateSensitivity(
  input: Readonly<{ comparison: readonly number[]; group: readonly number[] }>,
): SensitivityResult {
  const group = input.group.filter(Number.isFinite);
  const comparison = input.comparison.filter(Number.isFinite);
  const comparisonMedian = median(comparison);
  const groupMedian = median(group);

  if (comparisonMedian === null || groupMedian === null || group.length < 2) {
    return Object.freeze({
      minimumRelativeEffect: null,
      preservesDirection: false,
      removeBestWorstPreservesDirection: null,
    });
  }

  const originalSign = Math.sign(groupMedian - comparisonMedian);
  let preservesDirection = true;
  let minimumRelativeEffect: number | null = null;

  for (let index = 0; index < group.length; index += 1) {
    const withoutOne = group.filter((_, position) => position !== index);
    const refitMedian = median(withoutOne);
    if (refitMedian === null) continue;

    if (Math.sign(refitMedian - comparisonMedian) !== originalSign) preservesDirection = false;

    const effect = relativeEffect(refitMedian, comparisonMedian);
    if (effect === null) continue;

    const magnitude = Math.abs(effect);
    minimumRelativeEffect =
      minimumRelativeEffect === null ? magnitude : Math.min(minimumRelativeEffect, magnitude);
  }

  let removeBestWorstPreservesDirection: boolean | null = null;

  if (group.length >= 4) {
    const sorted = [...group].sort((left, right) => left - right);
    const trimmed = sorted.slice(1, -1);
    const trimmedMedian = median(trimmed);

    removeBestWorstPreservesDirection =
      trimmedMedian !== null && Math.sign(trimmedMedian - comparisonMedian) === originalSign;
  }

  return Object.freeze({
    minimumRelativeEffect,
    preservesDirection,
    removeBestWorstPreservesDirection,
  });
}

/**
 * Whether one post carries the group.
 *
 * Only meaningful for count metrics: a share of a total is undefined for a rate,
 * where every post contributes a value rather than a quantity. Passing a rate
 * here would produce a number that looks like a share and is not one.
 */
export function topContributorShare(values: readonly number[]): number | null {
  const finite = values.filter((value) => Number.isFinite(value) && value >= 0);
  const total = finite.reduce((sum, value) => sum + value, 0);

  if (finite.length === 0 || total <= 0) return null;

  return Math.max(...finite) / total;
}

/**
 * Benjamini-Hochberg step-up, returning which hypotheses survive.
 *
 * Applied across the family of comparisons generated in one run, because
 * testing every feature against every metric and reporting the strongest is how
 * noise becomes a finding.
 */
export function benjaminiHochberg(
  pValues: readonly number[],
  rate: number = falseDiscoveryRate,
): readonly boolean[] {
  const indexed = pValues
    .map((value, index) => ({ index, value }))
    .sort((left, right) => left.value - right.value);

  let largestSurviving = -1;

  indexed.forEach((entry, rank) => {
    if (entry.value <= ((rank + 1) / indexed.length) * rate) largestSurviving = rank;
  });

  const survives = new Array<boolean>(pValues.length).fill(false);

  for (let rank = 0; rank <= largestSurviving; rank += 1) {
    const entry = indexed[rank];
    if (entry) survives[entry.index] = true;
  }

  return Object.freeze(survives);
}

export type FeatureComparisonInput = Readonly<{
  /** Values for posts carrying the feature value. */
  comparison: readonly number[];
  /** Distinct ISO publication dates across the group. */
  distinctPublicationDates: number;
  /** Distinct ISO publication weeks across the group. */
  distinctPublicationWeeks: number;
  /** True when one source — a campaign, an account — supplied most of a side. */
  dominatedByOneSource?: boolean;
  group: readonly number[];
  /** Stable key for this comparison; seeds the bootstrap. */
  key: string;
  /** Share of otherwise eligible posts with no usable value, 0–1. */
  missingRatio: number;
  /** Count metrics support a contribution share; rates do not. */
  metricIsCount: boolean;
  /** True when the observations arrive in clusters rather than independently. */
  observationsClusterBySource?: boolean;
  /** Set when the family has been corrected; null when correction did not apply. */
  survivesMultipleTesting?: boolean | null;
}>;

export type FeatureStatistic = Readonly<{
  classification: ConfidenceClass;
  comparisonCount: number;
  comparisonSpread: CohortSpread;
  differenceOfMedians: number | null;
  groupCount: number;
  groupSpread: CohortSpread;
  interval: BootstrapInterval | null;
  reason: ClassificationReason;
  relativeEffect: number | null;
  sensitivity: SensitivityResult;
  statisticsVersion: typeof statisticsVersion;
  topContributorShare: number | null;
}>;

/**
 * Classifies one feature value against one metric.
 *
 * The order of these checks is the contract's order and is load-bearing. An
 * outlier is identified before any strength is assessed, so a group carried by
 * one post can never be promoted; and every strength class is checked from
 * strongest down, so a comparison only earns the class it fully satisfies.
 */
export function calculateFeatureStatistic(input: FeatureComparisonInput): FeatureStatistic {
  const group = input.group.filter(Number.isFinite);
  const comparison = input.comparison.filter(Number.isFinite);
  const groupSpread = summariseSpread(group);
  const comparisonSpread = summariseSpread(comparison);
  const groupMedian = groupSpread.median;
  const comparisonMedian = comparisonSpread.median;
  const differenceOfMedians =
    groupMedian === null || comparisonMedian === null ? null : groupMedian - comparisonMedian;
  const effect =
    groupMedian === null || comparisonMedian === null
      ? null
      : relativeEffect(groupMedian, comparisonMedian);
  const share = input.metricIsCount ? topContributorShare(group) : null;
  const sensitivity = evaluateSensitivity({ comparison, group });

  const base = {
    comparisonCount: comparison.length,
    comparisonSpread,
    differenceOfMedians,
    groupCount: group.length,
    groupSpread,
    relativeEffect: effect,
    sensitivity,
    statisticsVersion,
    topContributorShare: share,
  };

  const settle = (
    classification: ConfidenceClass,
    reason: ClassificationReason,
    interval: BootstrapInterval | null = null,
  ): FeatureStatistic => Object.freeze({ ...base, classification, interval, reason });

  // A single post is an outlier before it is anything else: there is no sample
  // to generalise from, whatever the numbers say.
  if (group.length === 1) return settle("single_post_outlier", "single_eligible_post");

  if (
    group.length < sampleThresholds.weak.group ||
    comparison.length < sampleThresholds.weak.comparison
  ) {
    return settle("insufficient_evidence", "below_minimum_samples");
  }
  if (input.distinctPublicationDates < minimumPublicationDates) {
    return settle("insufficient_evidence", "few_publication_dates");
  }
  if (input.missingRatio > maximumMissingRatio) {
    return settle("insufficient_evidence", "missingness_too_high");
  }

  if (share !== null && share > 0.5) {
    return settle("single_post_outlier", "top_post_dominates_total");
  }
  if (!sensitivity.preservesDirection) {
    return settle("single_post_outlier", "sensitivity_changes_materiality");
  }

  if (effect === null || Math.abs(effect) < practicalEffectThreshold) {
    return settle("weak_directional_signal", "effect_below_threshold");
  }

  // Decided before any strength class, like the outlier checks above it: a side
  // most of whose posts came from one source measures that source, and no sample
  // size turns that into a fact about the feature.
  if (input.dominatedByOneSource === true) {
    return settle("weak_directional_signal", "one_source_dominates_sample");
  }

  const seed = createBootstrapSeed({ comparison, group, key: input.key });
  const supportedInterval = bootstrapMedianDifference({
    comparison,
    confidence: 0.95,
    group,
    seed,
  });

  const meetsSupportedSamples =
    group.length >= sampleThresholds.supported.group &&
    comparison.length >= sampleThresholds.supported.comparison &&
    input.distinctPublicationWeeks >= sampleThresholds.supported.publicationWeeks;

  if (meetsSupportedSamples && supportedInterval?.excludesNoDifference === true) {
    // The bootstrap resamples observations independently, so an interval drawn
    // over clustered ones is narrower than the data earns — and this class is
    // gated on that interval excluding zero. Capped rather than discarded: what
    // the moderate class claims is still true of it.
    if (input.observationsClusterBySource === true) {
      return settle("moderate_association", "interval_ignores_clustering", supportedInterval);
    }
    if (input.survivesMultipleTesting === false) {
      return settle("moderate_association", "multiple_testing_rejected", supportedInterval);
    }
    // Both sensitivity checks must keep the direction and at least half the
    // effect threshold, so a supported claim cannot rest on the sample's edges.
    const keepsHalfEffect =
      sensitivity.minimumRelativeEffect !== null &&
      sensitivity.minimumRelativeEffect >= practicalEffectThreshold / 2;

    if (keepsHalfEffect && sensitivity.removeBestWorstPreservesDirection !== false) {
      return settle(
        "statistically_supported_association",
        "meets_supported_thresholds",
        supportedInterval,
      );
    }

    return settle("moderate_association", "sensitivity_changes_materiality", supportedInterval);
  }

  const moderateInterval = bootstrapMedianDifference({
    comparison,
    confidence: 0.8,
    group,
    seed,
  });

  const meetsModerateSamples =
    group.length >= sampleThresholds.moderate.group &&
    comparison.length >= sampleThresholds.moderate.comparison &&
    group.length + comparison.length >= sampleThresholds.moderate.total;

  if (meetsModerateSamples && moderateInterval?.excludesNoDifference === true) {
    return settle("moderate_association", "meets_moderate_thresholds", moderateInterval);
  }

  return settle(
    "weak_directional_signal",
    moderateInterval?.excludesNoDifference === false
      ? "interval_includes_no_difference"
      : "below_minimum_samples",
    moderateInterval,
  );
}
