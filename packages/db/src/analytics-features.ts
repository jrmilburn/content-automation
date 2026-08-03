import {
  calculateDerivedMetric,
  createMetricInputs,
  derivedMetricDefinitions,
  derivedMetrics,
  durationBandFor,
  recalculationWindowCandidates,
  sampleThresholds,
  selectAnalyticsAgeWindow,
  selectComparableSnapshots,
  snapshotAgeWindowFor,
  type AnalyticsWindowCandidate,
  type DerivedMetric,
  type SnapshotAgeWindowKey,
} from "@studio-parallel/domain";

import type { PrismaClient } from "./generated/prisma/client.js";
import type { FeatureComparisonCandidate, FeatureStatisticRequest } from "./feature-statistics.js";
import {
  instagramSnapshotValueSelect,
  readInstagramSnapshotObservations,
} from "./instagram-insights.js";
import type { WorkspaceContext } from "./workspace-context.js";

/**
 * Turning analysed posts into the comparisons a calculation run measures.
 *
 * Every question this module can ask is enumerated below rather than derived
 * from the data. The alternative — grouping by whatever fields happen to vary,
 * or choosing cut points that separate well — is how a dataset is made to say
 * anything, and the analytics contract forbids it. A feature that is not in
 * `analyticsFeatures` is not asked about at all.
 *
 * A post contributes to a comparison only if it can be placed on one side of
 * it. A post whose feature value the model could not determine is counted as
 * missing rather than dropped, because the difference between "no pattern" and
 * "we could not see most of these posts" has to survive into the result.
 *
 * The metric value comes through the same selection and the same formula as
 * every cohort read, so a feature comparison and a baseline comparison cannot
 * disagree about what a post scored.
 */

/** Posts one recalculation will read. Bounds the work at v1 volume. */
export const analyticsPostLimit = 1_000;

type AnalysisFeatureRow = Readonly<{
  contentFormat: string | null;
  contentPillar: string | null;
  ctaType: string | null;
  durationSeconds: unknown;
  hookCategory: string | null;
  presenterMode: string | null;
}>;

export type AnalyticsFeature = Readonly<{
  /** Path into the analysis contract, stored verbatim on the statistic. */
  path: string;
  read(analysis: AnalysisFeatureRow): string | null;
}>;

/**
 * The features a run compares on.
 *
 * Each is a small closed taxonomy, which is what makes a group meaningful.
 * Free-text fields — topic, hook text — are deliberately absent: grouping by
 * them would produce one post per value, and every result would be an outlier.
 */
export const analyticsFeatures: readonly AnalyticsFeature[] = Object.freeze([
  Object.freeze({ path: "content.contentPillar", read: (row) => row.contentPillar }),
  Object.freeze({ path: "content.contentFormat", read: (row) => row.contentFormat }),
  Object.freeze({ path: "content.hook.category", read: (row) => row.hookCategory }),
  Object.freeze({ path: "content.presenterMode", read: (row) => row.presenterMode }),
  Object.freeze({ path: "callToAction.type", read: (row) => row.ctaType }),
  Object.freeze({
    // Banded rather than continuous, and the bands are fixed in the domain
    // package. Searching for the duration cut point that separates best is the
    // exact practice the contract prohibits.
    path: "content.durationBand",
    read: (row) => {
      const seconds = row.durationSeconds === null ? null : Number(row.durationSeconds);

      return seconds === null || !Number.isFinite(seconds) ? null : durationBandFor(seconds);
    },
  }),
] satisfies readonly AnalyticsFeature[]);

export type AnalyticsInputPost = Readonly<{
  /** Feature path to the value the analysis reported, absent when unknown. */
  features: ReadonlyMap<string, string>;
  /** Derived metric to the post's value, absent when the metric is unavailable. */
  metricValues: ReadonlyMap<DerivedMetric, number>;
  postAnalysisId: string;
  postId: string;
  publishedAt: string;
  snapshotId: string;
}>;

export type AnalyticsInputSet = Readonly<{
  /** Contributing analyses, for the run fingerprint. */
  analysisIds: readonly string[];
  posts: readonly AnalyticsInputPost[];
  /** Contributing snapshots, for the run fingerprint. */
  snapshotIds: readonly string[];
}>;

export type AnalyticsInputRequest = Readonly<{
  ageWindow: SnapshotAgeWindowKey;
  instagramAccountId: string;
  publishedFrom: Date;
  publishedTo: Date;
}>;

const emptyAnalyticsInputSet: AnalyticsInputSet = Object.freeze({
  analysisIds: Object.freeze([]),
  posts: Object.freeze([]),
  snapshotIds: Object.freeze([]),
});

type AnalyticsPostRow = Readonly<{
  currentAnalysis: (AnalysisFeatureRow & Readonly<{ id: string }>) | null;
  id: string;
  publishedAt: Date;
}>;

type AnalyticsSnapshotRow = Parameters<typeof readInstagramSnapshotObservations>[0] &
  Readonly<{ capturedAt: Date; id: string; instagramPostId: string; postAgeSeconds: number }>;

/**
 * Posts a run may measure.
 *
 * Only posts carrying a current analysis marked analytics-eligible are read. An
 * analysis the model was not confident enough to group by is excluded here
 * rather than filtered later, so it never reaches a comparison at all.
 */
async function readAnalyticsPosts(
  database: PrismaClient,
  context: WorkspaceContext,
  request: Omit<AnalyticsInputRequest, "ageWindow">,
): Promise<readonly AnalyticsPostRow[]> {
  return database.instagramPost.findMany({
    orderBy: [{ publishedAt: "desc" }, { id: "desc" }],
    select: {
      currentAnalysis: {
        select: {
          contentFormat: true,
          contentPillar: true,
          ctaType: true,
          durationSeconds: true,
          hookCategory: true,
          id: true,
          presenterMode: true,
        },
      },
      id: true,
      publishedAt: true,
    },
    take: analyticsPostLimit,
    where: {
      currentAnalysis: { analyticsEligible: true },
      instagramAccountId: request.instagramAccountId,
      publishedAt: { gte: request.publishedFrom, lte: request.publishedTo },
      workspaceId: context.workspaceId,
    },
  });
}

async function readAnalyticsSnapshots(
  database: PrismaClient,
  context: WorkspaceContext,
  input: Readonly<{ maximumSeconds: number; minimumSeconds: number; postIds: readonly string[] }>,
): Promise<readonly AnalyticsSnapshotRow[]> {
  return database.instagramMetricSnapshot.findMany({
    select: {
      ...instagramSnapshotValueSelect,
      capturedAt: true,
      id: true,
      instagramPostId: true,
      postAgeSeconds: true,
    },
    where: {
      instagramPostId: { in: [...input.postIds] },
      // Bounded in SQL as well as in selection, so the row set stays
      // proportional to the posts rather than to how often they were captured.
      postAgeSeconds: {
        gte: input.minimumSeconds,
        ...(Number.isFinite(input.maximumSeconds) ? { lte: input.maximumSeconds } : {}),
      },
      workspaceId: context.workspaceId,
    },
  });
}

/**
 * Places each post in one window, with the value that window observed.
 *
 * Pure over rows already read, so asking the same question of several windows
 * costs no further queries. The age filter is applied again here rather than
 * trusted from the query, because a caller comparing windows reads one span
 * covering all of them and each window still has to reject what falls outside
 * its own edges.
 */
function measureAnalyticsInputs(
  posts: readonly AnalyticsPostRow[],
  snapshots: readonly AnalyticsSnapshotRow[],
  ageWindow: SnapshotAgeWindowKey,
): AnalyticsInputSet {
  const window = snapshotAgeWindowFor(ageWindow);
  const inWindow = snapshots.filter(
    (row) =>
      row.postAgeSeconds >= window.minimumSeconds &&
      (!Number.isFinite(window.maximumSeconds) || row.postAgeSeconds <= window.maximumSeconds),
  );

  const chosen = selectComparableSnapshots(
    inWindow.map((row) => ({
      capturedAt: row.capturedAt,
      postAgeSeconds: row.postAgeSeconds,
      postId: row.instagramPostId,
      snapshotId: row.id,
    })),
    ageWindow,
  );

  const rowsById = new Map(inWindow.map((row) => [row.id, row]));
  const measured: AnalyticsInputPost[] = [];

  for (const post of posts) {
    const analysis = post.currentAnalysis;
    if (!analysis) continue;

    const selected = chosen.get(post.id);
    if (!selected) continue;

    const row = rowsById.get(selected.snapshotId);
    if (!row) continue;

    const inputs = createMetricInputs({
      observations: readInstagramSnapshotObservations(row),
      snapshotId: row.id,
    });

    const metricValues = new Map<DerivedMetric, number>();
    for (const metric of derivedMetrics) {
      const result = calculateDerivedMetric(metric, inputs);
      if (result.availability !== "available" || result.value === null) continue;
      metricValues.set(metric, result.value);
    }

    // A post with no readable metric cannot appear on either side of any
    // comparison, so it is not an eligible post for the missingness rule either.
    if (metricValues.size === 0) continue;

    const features = new Map<string, string>();
    for (const feature of analyticsFeatures) {
      const value = feature.read(analysis);
      if (value !== null) features.set(feature.path, value);
    }

    measured.push(
      Object.freeze({
        features,
        metricValues,
        postAnalysisId: analysis.id,
        postId: post.id,
        publishedAt: post.publishedAt.toISOString(),
        snapshotId: row.id,
      }),
    );
  }

  return Object.freeze({
    analysisIds: Object.freeze(measured.map((post) => post.postAnalysisId)),
    posts: Object.freeze(measured),
    snapshotIds: Object.freeze(measured.map((post) => post.snapshotId)),
  });
}

/** Reads every post a run will measure in one named window. */
export async function loadAnalyticsInputs(
  database: PrismaClient,
  context: WorkspaceContext,
  request: AnalyticsInputRequest,
): Promise<AnalyticsInputSet> {
  const posts = await readAnalyticsPosts(database, context, request);
  if (posts.length === 0) return emptyAnalyticsInputSet;

  const window = snapshotAgeWindowFor(request.ageWindow);
  const snapshots = await readAnalyticsSnapshots(database, context, {
    maximumSeconds: window.maximumSeconds,
    minimumSeconds: window.minimumSeconds,
    postIds: posts.map((post) => post.id),
  });

  return measureAnalyticsInputs(posts, snapshots, request.ageWindow);
}

export type AnalyticsWindowSelection = Readonly<{
  ageWindow: SnapshotAgeWindowKey;
  /** Every window offered and what it would have measured, for the run's log. */
  considered: readonly AnalyticsWindowCandidate[];
  inputs: AnalyticsInputSet;
}>;

/**
 * Reads the inputs for whichever candidate window measures the most posts.
 *
 * One post read and one snapshot read regardless of how many windows are
 * offered: the span between the least and most mature candidate is read once
 * and each window filters it in memory. Pinning a single window instead is what
 * left an account's existing posts unmeasurable — they can only ever appear in
 * `mature`, and nothing was asking for it.
 *
 * Null when no candidate window measures anything, which is the same "nothing
 * to publish" a caller already handles for an account with no analyses.
 */
export async function loadBestAnalyticsInputs(
  database: PrismaClient,
  context: WorkspaceContext,
  request: Omit<AnalyticsInputRequest, "ageWindow">,
  candidates: readonly SnapshotAgeWindowKey[] = recalculationWindowCandidates,
): Promise<AnalyticsWindowSelection | null> {
  const posts = await readAnalyticsPosts(database, context, request);
  if (posts.length === 0) return null;

  const windows = candidates.map((key) => snapshotAgeWindowFor(key));
  const snapshots = await readAnalyticsSnapshots(database, context, {
    maximumSeconds: Math.max(...windows.map((window) => window.maximumSeconds)),
    minimumSeconds: Math.min(...windows.map((window) => window.minimumSeconds)),
    postIds: posts.map((post) => post.id),
  });

  const measuredByWindow = new Map<SnapshotAgeWindowKey, AnalyticsInputSet>();
  const considered: AnalyticsWindowCandidate[] = [];

  for (const ageWindow of candidates) {
    const inputs = measureAnalyticsInputs(posts, snapshots, ageWindow);
    measuredByWindow.set(ageWindow, inputs);
    considered.push(Object.freeze({ ageWindow, eligiblePosts: inputs.posts.length }));
  }

  // The floor a window has to clear to be preferred for being settled rather
  // than large. The moderate class is the point at which a comparison is worth
  // presenting at all, so a window that reaches it is covered enough to choose
  // on maturity.
  const ageWindow = selectAnalyticsAgeWindow(considered, sampleThresholds.moderate.total);
  const inputs = ageWindow === null ? undefined : measuredByWindow.get(ageWindow);
  if (ageWindow === null || !inputs) return null;

  return Object.freeze({ ageWindow, considered: Object.freeze(considered), inputs });
}

/**
 * Every comparison a run will calculate, grouped into one family per metric.
 *
 * The family boundary is the metric, because that is what the multiple-testing
 * correction is applied across. A feature value is compared against the posts
 * carrying a *different known value* for the same feature, never against
 * everything else: comparing against posts whose value is unknown would let
 * missingness masquerade as a difference.
 */
export function buildFeatureRequests(
  request: AnalyticsInputRequest,
  inputs: AnalyticsInputSet,
): readonly FeatureStatisticRequest[] {
  const requests: FeatureStatisticRequest[] = [];

  for (const metric of derivedMetrics) {
    const measured = inputs.posts.filter((post) => post.metricValues.has(metric));
    if (measured.length === 0) continue;

    const candidates: FeatureComparisonCandidate[] = [];

    for (const feature of analyticsFeatures) {
      const known = measured.filter((post) => post.features.has(feature.path));
      const missingCount = measured.length - known.length;
      const values = new Set(known.map((post) => post.features.get(feature.path) as string));

      // One value is not a comparison, it is a description of the account. The
      // comparison side would be empty and the result would be meaningless
      // rather than merely weak.
      if (values.size < 2) continue;

      for (const value of values) {
        candidates.push(
          Object.freeze({
            comparison: Object.freeze(
              known
                .filter((post) => post.features.get(feature.path) !== value)
                .map((post) => observe(post, metric)),
            ),
            featurePath: feature.path,
            featureValue: value,
            group: Object.freeze(
              known
                .filter((post) => post.features.get(feature.path) === value)
                .map((post) => observe(post, metric)),
            ),
            missingCount,
          }),
        );
      }
    }

    if (candidates.length === 0) continue;

    requests.push(
      Object.freeze({
        ageWindow: request.ageWindow,
        candidates: Object.freeze(candidates),
        instagramAccountId: request.instagramAccountId,
        metric,
        metricIsCount: derivedMetricDefinitions[metric].unit === "count",
        publishedFrom: request.publishedFrom,
        publishedTo: request.publishedTo,
      }),
    );
  }

  return Object.freeze(requests);
}

function observe(post: AnalyticsInputPost, metric: DerivedMetric) {
  return Object.freeze({
    instagramPostId: post.postId,
    metricSnapshotId: post.snapshotId,
    postAnalysisId: post.postAnalysisId,
    publishedAt: post.publishedAt,
    value: post.metricValues.get(metric) as number,
  });
}
