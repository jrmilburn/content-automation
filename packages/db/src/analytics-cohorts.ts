import {
  calculateDerivedMetric,
  compareToBaseline,
  createCohortFingerprint,
  createMetricInputs,
  excludeFocalPost,
  recentCohortDays,
  recentCohortPostLimit,
  selectComparableSnapshots,
  snapshotAgeWindowFor,
  summariseCoverage,
  summariseSpread,
  type BaselineComparison,
  type CohortCoverage,
  type CohortDefinition,
  type CohortKind,
  type CohortSpread,
  type DerivedMetric,
  type SnapshotAgeWindowKey,
} from "@studio-parallel/domain";

import type { PrismaClient } from "./generated/prisma/client.js";
import {
  instagramSnapshotValueSelect,
  readInstagramSnapshotObservations,
} from "./instagram-insights.js";
import type { WorkspaceContext } from "./workspace-context.js";

/**
 * Comparable cohort queries.
 *
 * Every query is bounded to the workspace and to a publication window before it
 * reaches the database, and optionally to one Instagram account. The workspace
 * bound is the authorisation boundary the whole data layer relies on, and the
 * publication bound is what stops a cohort growing without limit as history
 * accumulates.
 *
 * The account bound is a question about scope rather than an absolute rule. Ten
 * of the eleven derived metrics are per-post ratios, each divided by that post's
 * own reach or its own watch time, so a value does not carry the size of the
 * audience behind it and a median may honestly span accounts.
 * `engagement_count` is the exception: a raw count, whose median across two
 * accounts of different size measures which account published the post. So pool
 * for a ratio, and keep the account bound whenever the metric is a count or the
 * question is about one account's own audience — a cohort a post is compared
 * against is usually that second thing.
 *
 * Selection reads `postAgeSeconds`, never the stored `ageBucket`. See
 * `analytics-cohorts.ts` in the domain package for why those are different
 * questions.
 *
 * Values are recomputed from stored observations on every read rather than
 * cached. #52 introduces the calculation run that makes results durable; until
 * then a cohort is a derivation, and deriving it twice must give the same answer
 * rather than a stale one.
 */

/** Posts a single cohort query will read. Bounds the work at v1 volume. */
export const cohortPostLimit = 500;

export type CohortRequest = Readonly<{
  ageWindow: SnapshotAgeWindowKey;
  /** Excluded from its own comparison when present. */
  focalPostId?: string;
  /** One account, or absent to pool every linked account in the workspace. */
  instagramAccountId?: string;
  /** Restricts a `category` cohort to one versioned media category. */
  mediaCategory?: string;
  metric: DerivedMetric;
  publishedFrom: Date;
  publishedTo: Date;
}>;

export type CohortMember = Readonly<{
  postId: string;
  publishedAt: string;
  snapshotId: string;
  value: number;
}>;

export type Cohort = Readonly<{
  coverage: CohortCoverage;
  definition: CohortDefinition;
  /** Contributing posts, ordered by publication time descending. */
  members: readonly CohortMember[];
  /** Stable over the inputs, so #52 can skip a recalculation that cannot change. */
  fingerprint: string;
  spread: CohortSpread;
}>;

type PostRow = Readonly<{
  id: string;
  providerMediaId: string;
  publishedAt: Date;
}>;

/**
 * Drops the second copy of a post two linked accounts both published.
 *
 * A collaborator reel is imported once under each account, as two rows carrying
 * the same `providerMediaId`. Pooled, that is one video counted twice — in the
 * median, in the sample size a confidence class is decided from, and in the share
 * of a group one account is judged to have supplied. The query's ordering is
 * total, so which copy survives is stable between runs rather than whichever the
 * planner returned first.
 */
export function dedupeCollaboratorPosts<Row extends Readonly<{ providerMediaId: string }>>(
  posts: readonly Row[],
): readonly Row[] {
  const seen = new Set<string>();

  return posts.filter((post) => {
    if (seen.has(post.providerMediaId)) return false;
    seen.add(post.providerMediaId);

    return true;
  });
}

/**
 * Loads one comparison cohort.
 *
 * `kind` selects the cohort definition rather than a different code path, so an
 * account, recent and category baseline are computed by identical selection and
 * identical arithmetic. The contract requires them to share a canonical metric
 * definition, source and unit; deriving all three through one function is what
 * makes that true by construction instead of by review.
 */
export async function loadCohort(
  database: PrismaClient,
  context: WorkspaceContext,
  kind: CohortKind,
  request: CohortRequest,
): Promise<Cohort> {
  const window = snapshotAgeWindowFor(request.ageWindow);
  const publishedFrom = resolvePublishedFrom(kind, request);

  const posts = await database.instagramPost.findMany({
    orderBy: [{ publishedAt: "desc" }, { id: "desc" }],
    // The category filter runs in SQL, so the category itself is never read back.
    select: { id: true, providerMediaId: true, publishedAt: true },
    // A recent cohort is defined as the previous N eligible posts, so the bound
    // is part of its meaning rather than a page size.
    take: kind === "recent" ? recentCohortPostLimit + 1 : cohortPostLimit,
    where: {
      ...(request.instagramAccountId === undefined
        ? {}
        : { instagramAccountId: request.instagramAccountId }),
      publishedAt: { gte: publishedFrom, lte: request.publishedTo },
      workspaceId: context.workspaceId,
      ...(kind === "category" && request.mediaCategory
        ? { mediaProductType: request.mediaCategory }
        : {}),
    },
  });

  // The focal post is removed before the recent limit is applied, so excluding it
  // does not silently shrink the comparison to nineteen posts. One extra row was
  // read above for exactly this reason.
  const all = asMembersOfPost(
    request.instagramAccountId === undefined ? dedupeCollaboratorPosts(posts) : posts,
  );
  const eligible = request.focalPostId ? excludeFocalPost(all, request.focalPostId) : all;
  const bounded = kind === "recent" ? eligible.slice(0, recentCohortPostLimit) : eligible;

  const definition: CohortDefinition = Object.freeze({
    ageWindow: request.ageWindow,
    categoryValue: kind === "category" ? (request.mediaCategory ?? null) : null,
    // Null is the pooled scope, and it reaches the fingerprint through the
    // definition — so a pooled cohort and an account's cohort over the same
    // snapshots are two answers rather than one.
    instagramAccountId: request.instagramAccountId ?? null,
    kind,
    metric: request.metric,
    publishedFrom: publishedFrom.toISOString(),
    publishedTo: request.publishedTo.toISOString(),
  });

  if (bounded.length === 0) return emptyCohort(definition);

  const snapshots = await database.instagramMetricSnapshot.findMany({
    select: {
      ...instagramSnapshotValueSelect,
      capturedAt: true,
      id: true,
      instagramPostId: true,
      postAgeSeconds: true,
    },
    where: {
      instagramPostId: { in: bounded.map((post) => post.postId) },
      // The tolerance is applied in SQL as well as in selection so the row set
      // stays proportional to the cohort rather than to capture frequency.
      postAgeSeconds: {
        gte: window.minimumSeconds,
        ...(Number.isFinite(window.maximumSeconds) ? { lte: window.maximumSeconds } : {}),
      },
      workspaceId: context.workspaceId,
    },
  });

  const chosen = selectComparableSnapshots(
    snapshots.map((row) => ({
      capturedAt: row.capturedAt,
      postAgeSeconds: row.postAgeSeconds,
      postId: row.instagramPostId,
      snapshotId: row.id,
    })),
    request.ageWindow,
  );

  const rowsById = new Map(snapshots.map((row) => [row.id, row]));
  const members: CohortMember[] = [];
  let postsMissingMetric = 0;

  for (const post of bounded) {
    const selected = chosen.get(post.postId);
    if (!selected) continue;

    const row = rowsById.get(selected.snapshotId);
    if (!row) continue;

    const result = calculateDerivedMetric(
      request.metric,
      createMetricInputs({
        observations: readInstagramSnapshotObservations(row),
        snapshotId: row.id,
      }),
    );

    if (result.availability !== "available" || result.value === null) {
      postsMissingMetric += 1;
      continue;
    }

    members.push(
      Object.freeze({
        postId: post.postId,
        publishedAt: post.publishedAt,
        snapshotId: row.id,
        value: result.value,
      }),
    );
  }

  return Object.freeze({
    coverage: summariseCoverage({
      eligiblePosts: bounded.length,
      postsMissingMetric,
      postsMissingSnapshot: bounded.length - chosen.size,
      postsWithValue: members.length,
    }),
    definition,
    fingerprint: createCohortFingerprint({
      definition,
      snapshotIds: members.map((member) => member.snapshotId),
    }),
    members: Object.freeze(members),
    spread: summariseSpread(members.map((member) => member.value)),
  });
}

/**
 * Compares one post against a cohort it is excluded from.
 *
 * The focal value is read through the same selection and the same formula as
 * every comparison value. Reading it any other way — a latest snapshot, say —
 * would compare a post at one age against a baseline drawn at another, which is
 * the error the whole module exists to prevent.
 */
export async function comparePostToCohort(
  database: PrismaClient,
  context: WorkspaceContext,
  kind: CohortKind,
  request: CohortRequest & Readonly<{ focalPostId: string }>,
): Promise<Readonly<{ cohort: Cohort; comparison: BaselineComparison }>> {
  const [focalValue, cohort] = await Promise.all([
    loadPostMetricValue(database, context, request),
    loadCohort(database, context, kind, request),
  ]);

  return Object.freeze({
    cohort,
    comparison: compareToBaseline(
      focalValue,
      cohort.members.map((member) => member.value),
    ),
  });
}

/**
 * Reads one post's value through the cohort's own selection and formula.
 *
 * Deliberately not a "latest snapshot" read. A focal value drawn at a different
 * age than its baseline is the precise error this module exists to prevent, and
 * it would be invisible in the output.
 */
export async function loadPostMetricValue(
  database: PrismaClient,
  context: WorkspaceContext,
  request: Readonly<{
    ageWindow: SnapshotAgeWindowKey;
    focalPostId: string;
    metric: DerivedMetric;
  }>,
): Promise<number | null> {
  const window = snapshotAgeWindowFor(request.ageWindow);
  const rows = await database.instagramMetricSnapshot.findMany({
    select: {
      ...instagramSnapshotValueSelect,
      capturedAt: true,
      id: true,
      instagramPostId: true,
      postAgeSeconds: true,
    },
    where: {
      instagramPostId: request.focalPostId,
      postAgeSeconds: {
        gte: window.minimumSeconds,
        ...(Number.isFinite(window.maximumSeconds) ? { lte: window.maximumSeconds } : {}),
      },
      workspaceId: context.workspaceId,
    },
  });

  const selected = selectComparableSnapshots(
    rows.map((row) => ({
      capturedAt: row.capturedAt,
      postAgeSeconds: row.postAgeSeconds,
      postId: row.instagramPostId,
      snapshotId: row.id,
    })),
    request.ageWindow,
  ).get(request.focalPostId);

  if (!selected) return null;

  const row = rows.find((candidate) => candidate.id === selected.snapshotId);
  if (!row) return null;

  const result = calculateDerivedMetric(
    request.metric,
    createMetricInputs({
      observations: readInstagramSnapshotObservations(row),
      snapshotId: row.id,
    }),
  );

  return result.availability === "available" ? result.value : null;
}

function asMembersOfPost(
  posts: readonly PostRow[],
): readonly Readonly<{ postId: string; publishedAt: string }>[] {
  return posts.map((post) =>
    Object.freeze({ postId: post.id, publishedAt: post.publishedAt.toISOString() }),
  );
}

/**
 * Narrows the publication window for a recent cohort.
 *
 * "Recent" is both a count and a period: the previous twenty eligible posts
 * within ninety days. A count alone would reach back years for a quiet account
 * and call the result recent.
 */
function resolvePublishedFrom(kind: CohortKind, request: CohortRequest): Date {
  if (kind !== "recent") return request.publishedFrom;

  const horizon = new Date(request.publishedTo.getTime() - recentCohortDays * 24 * 60 * 60 * 1_000);

  return horizon > request.publishedFrom ? horizon : request.publishedFrom;
}

function emptyCohort(definition: CohortDefinition): Cohort {
  return Object.freeze({
    coverage: summariseCoverage({
      eligiblePosts: 0,
      postsMissingMetric: 0,
      postsMissingSnapshot: 0,
      postsWithValue: 0,
    }),
    definition,
    fingerprint: createCohortFingerprint({ definition, snapshotIds: [] }),
    members: Object.freeze([]),
    spread: summariseSpread([]),
  });
}
