import {
  confidenceClasses,
  derivedMetrics,
  type ClassificationReason,
  type ConfidenceClass,
  type DerivedMetric,
} from "@studio-parallel/domain";

import type { Prisma, PrismaClient } from "./generated/prisma/client.js";
import { isUuidV7 } from "./id.js";
import type { WorkspaceContext } from "./workspace-context.js";

/**
 * The read path for calculated trends.
 *
 * One rule governs every query here: a reader sees the statistics of the one
 * ACTIVE calculation run and nothing else. Reading `account_feature_statistics`
 * directly would be simpler and wrong — the table holds every row every run ever
 * wrote, including rows a later run did not republish because their inputs
 * changed, and a screen built on it would mix a current statistic with a
 * superseded one and present the pair as a set. Membership of the active run is
 * what makes the set complete and self-consistent, so it is the join, not a
 * filter that could be forgotten.
 *
 * Nothing is recomputed on the way out. The medians, intervals and sensitivity
 * verdicts were calculated once under a seeded bootstrap and stored; deriving
 * any of them again in a request would produce a number the stored evidence
 * cannot account for.
 *
 * Decimals cross the boundary as numbers and dates as ISO strings, matching the
 * post list, so a caller cannot depend on a `Prisma.Decimal` or a `Date`
 * surviving serialisation into a client component.
 */

/** Trends read in one request. Bounded server-side; a caller cannot ask for more. */
export const trendPageSize = 200;

export type TrendListFilters = Readonly<{
  confidence?: ConfidenceClass;
  featurePath?: string;
  instagramAccountId?: string;
  /** Set when a supplied filter value was invalid, so the result is empty. */
  matchesNothing?: boolean;
  metric?: DerivedMetric;
}>;

export type TrendCalculation = Readonly<{
  activatedAt: string;
  ageWindow: string;
  analyticsVersion: string;
  durationMs: number | null;
  id: string;
  publishedFrom: string;
  publishedTo: string;
  /** Posts the run read. Not the number of trends it produced. */
  analysisCount: number;
  statisticCount: number;
  statisticsVersion: string;
}>;

export type TrendListItem = Readonly<{
  ageWindow: string;
  classificationReason: ClassificationReason;
  comparisonCount: number;
  comparisonIqr: number | null;
  comparisonMedian: number | null;
  confidence: ConfidenceClass;
  differenceOfMedians: number | null;
  distinctPublicationDates: number;
  distinctPublicationWeeks: number;
  featurePath: string;
  featureValue: string;
  groupCount: number;
  groupIqr: number | null;
  groupMedian: number | null;
  id: string;
  intervalConfidence: number | null;
  intervalLower: number | null;
  intervalUpper: number | null;
  metric: DerivedMetric;
  missingRatio: number;
  multipleTestingApplied: boolean;
  publishedFrom: string;
  publishedTo: string;
  relativeEffect: number | null;
  sensitivityHoldsDirection: boolean | null;
  topContributorShare: number | null;
}>;

export type TrendList = Readonly<{
  /** The published run these came from, or null when nothing has been published. */
  calculation: TrendCalculation | null;
  generatedAt: string;
  trends: readonly TrendListItem[];
}>;

/** One post that contributed to a trend, and which side of the comparison it sat on. */
export type TrendContributor = Readonly<{
  caption: string | null;
  instagramPostId: string;
  membership: "comparison" | "group";
  permalink: string | null;
  postAnalysisId: string;
  publishedAt: string;
  value: number;
}>;

export type TrendDetail = Readonly<{
  calculation: TrendCalculation;
  contributors: readonly TrendContributor[];
  trend: TrendListItem;
}>;

const statisticSelect = {
  ageWindow: true,
  classificationReason: true,
  comparisonCount: true,
  comparisonIqr: true,
  comparisonMedian: true,
  confidence: true,
  differenceOfMedians: true,
  distinctPublicationDates: true,
  distinctPublicationWeeks: true,
  featurePath: true,
  featureValue: true,
  groupCount: true,
  groupIqr: true,
  groupMedian: true,
  id: true,
  intervalConfidence: true,
  intervalLower: true,
  intervalUpper: true,
  metric: true,
  missingRatio: true,
  multipleTestingApplied: true,
  publishedFrom: true,
  publishedTo: true,
  relativeEffect: true,
  sensitivityHoldsDirection: true,
  topContributorShare: true,
} as const;

const runSelect = {
  activatedAt: true,
  ageWindow: true,
  analysisCount: true,
  analyticsVersion: true,
  durationMs: true,
  id: true,
  publishedFrom: true,
  publishedTo: true,
  statisticCount: true,
  statisticsVersion: true,
} as const;

/**
 * Loads the trends of an account's published calculation.
 *
 * Returns a null calculation rather than throwing when nothing has been
 * published. A newly connected account genuinely has no statistics, and that is
 * a state the screen has to explain rather than an error it should report.
 */
export async function loadAccountTrends(
  database: PrismaClient,
  context: WorkspaceContext,
  filters: TrendListFilters,
): Promise<TrendList> {
  const generatedAt = new Date().toISOString();

  if (filters.matchesNothing || !filters.instagramAccountId) {
    return Object.freeze({ calculation: null, generatedAt, trends: Object.freeze([]) });
  }

  const run = await database.accountAnalyticsRun.findFirst({
    select: runSelect,
    where: {
      instagramAccountId: filters.instagramAccountId,
      state: "ACTIVE",
      workspaceId: context.workspaceId,
    },
  });

  if (run === null || run.activatedAt === null) {
    return Object.freeze({ calculation: null, generatedAt, trends: Object.freeze([]) });
  }

  const published = await database.accountAnalyticsRunStatistic.findMany({
    orderBy: [{ statistic: { relativeEffect: "desc" } }, { statisticId: "asc" }],
    select: { statistic: { select: statisticSelect } },
    take: trendPageSize,
    where: {
      runId: run.id,
      statistic: {
        ...(filters.confidence
          ? { confidence: toConfidenceColumn(filters.confidence) as never }
          : {}),
        ...(filters.featurePath ? { featurePath: filters.featurePath } : {}),
        ...(filters.metric ? { metric: filters.metric } : {}),
      },
      workspaceId: context.workspaceId,
    },
  });

  return Object.freeze({
    calculation: toCalculation(run, run.activatedAt),
    generatedAt,
    trends: Object.freeze(published.map((row) => toListItem(row.statistic))),
  });
}

/**
 * Loads one trend with the posts behind it.
 *
 * Resolved through the active run's membership like the list, so a link to a
 * statistic that a later run stopped publishing reads as absent rather than
 * silently showing a reader a superseded result at a current-looking URL.
 */
export async function loadTrendDetail(
  database: PrismaClient,
  context: WorkspaceContext,
  input: Readonly<{ instagramAccountId: string; statisticId: string }>,
): Promise<TrendDetail | null> {
  if (!isUuidV7(input.statisticId) || !isUuidV7(input.instagramAccountId)) return null;

  const run = await database.accountAnalyticsRun.findFirst({
    select: runSelect,
    where: {
      instagramAccountId: input.instagramAccountId,
      state: "ACTIVE",
      workspaceId: context.workspaceId,
    },
  });

  if (run === null || run.activatedAt === null) return null;

  const published = await database.accountAnalyticsRunStatistic.findFirst({
    select: { statistic: { select: statisticSelect } },
    where: { runId: run.id, statisticId: input.statisticId, workspaceId: context.workspaceId },
  });

  if (!published) return null;

  const members = await database.accountFeatureStatisticPost.findMany({
    orderBy: { value: "desc" },
    select: { instagramPostId: true, membership: true, postAnalysisId: true, value: true },
    where: { statisticId: input.statisticId, workspaceId: context.workspaceId },
  });

  // One query for the page rather than one per contributor, and scoped to the
  // account as well as the workspace: a membership row names a post id, and a
  // detail screen must not become a way to read a post from elsewhere.
  //
  // Captions are provider text. This screen's stated purpose is to let an
  // authorised same-workspace user inspect the posts behind a claim, so it opts
  // in by name as the triage list does; `rawPayload` stays absent from both.
  const posts = await database.instagramPost.findMany({
    select: { caption: true, id: true, permalink: true, publishedAt: true },
    where: {
      id: { in: members.map((member) => member.instagramPostId) },
      instagramAccountId: input.instagramAccountId,
      workspaceId: context.workspaceId,
    },
  });

  const postsById = new Map(posts.map((post) => [post.id, post]));

  return Object.freeze({
    calculation: toCalculation(run, run.activatedAt),
    contributors: Object.freeze(
      members.flatMap((member) => {
        const post = postsById.get(member.instagramPostId);
        if (!post) return [];

        return [
          Object.freeze({
            caption: post.caption,
            instagramPostId: member.instagramPostId,
            membership:
              member.membership === "group" ? ("group" as const) : ("comparison" as const),
            permalink: post.permalink,
            postAnalysisId: member.postAnalysisId,
            publishedAt: post.publishedAt.toISOString(),
            value: Number(member.value),
          }),
        ];
      }),
    ),
    trend: toListItem(published.statistic),
  });
}

/** The feature paths the published run actually produced, for the filter form. */
export async function listTrendFeaturePaths(
  database: PrismaClient,
  context: WorkspaceContext,
  instagramAccountId: string,
): Promise<readonly string[]> {
  if (!isUuidV7(instagramAccountId)) return Object.freeze([]);

  const run = await database.accountAnalyticsRun.findFirst({
    select: { id: true },
    where: { instagramAccountId, state: "ACTIVE", workspaceId: context.workspaceId },
  });

  if (run === null) return Object.freeze([]);

  // Offering a filter the run produced nothing for would let a reader pick their
  // way to an empty screen and read it as "no patterns here".
  const rows = await database.accountFeatureStatistic.findMany({
    distinct: ["featurePath"],
    orderBy: { featurePath: "asc" },
    select: { featurePath: true },
    where: { publications: { some: { runId: run.id } }, workspaceId: context.workspaceId },
  });

  return Object.freeze(rows.map((row) => row.featurePath));
}

export function isConfidenceClass(value: string): value is ConfidenceClass {
  return (confidenceClasses as readonly string[]).includes(value);
}

export function isDerivedMetric(value: string): value is DerivedMetric {
  return (derivedMetrics as readonly string[]).includes(value);
}

function toConfidenceColumn(classification: ConfidenceClass): string {
  return classification.toUpperCase();
}

function decimal(value: Prisma.Decimal | null): number | null {
  return value === null ? null : Number(value);
}

function toCalculation(
  run: Prisma.AccountAnalyticsRunGetPayload<{ select: typeof runSelect }>,
  activatedAt: Date,
): TrendCalculation {
  return Object.freeze({
    activatedAt: activatedAt.toISOString(),
    ageWindow: run.ageWindow,
    analysisCount: run.analysisCount,
    analyticsVersion: run.analyticsVersion,
    durationMs: run.durationMs,
    id: run.id,
    publishedFrom: run.publishedFrom.toISOString(),
    publishedTo: run.publishedTo.toISOString(),
    statisticCount: run.statisticCount,
    statisticsVersion: run.statisticsVersion,
  });
}

function toListItem(
  statistic: Prisma.AccountFeatureStatisticGetPayload<{ select: typeof statisticSelect }>,
): TrendListItem {
  return Object.freeze({
    ageWindow: statistic.ageWindow,
    classificationReason: statistic.classificationReason as ClassificationReason,
    comparisonCount: statistic.comparisonCount,
    comparisonIqr: decimal(statistic.comparisonIqr),
    comparisonMedian: decimal(statistic.comparisonMedian),
    confidence: statistic.confidence.toLowerCase() as ConfidenceClass,
    differenceOfMedians: decimal(statistic.differenceOfMedians),
    distinctPublicationDates: statistic.distinctPublicationDates,
    distinctPublicationWeeks: statistic.distinctPublicationWeeks,
    featurePath: statistic.featurePath,
    featureValue: statistic.featureValue,
    groupCount: statistic.groupCount,
    groupIqr: decimal(statistic.groupIqr),
    groupMedian: decimal(statistic.groupMedian),
    id: statistic.id,
    intervalConfidence: decimal(statistic.intervalConfidence),
    intervalLower: decimal(statistic.intervalLower),
    intervalUpper: decimal(statistic.intervalUpper),
    metric: statistic.metric as DerivedMetric,
    missingRatio: Number(statistic.missingRatio),
    multipleTestingApplied: statistic.multipleTestingApplied,
    publishedFrom: statistic.publishedFrom.toISOString(),
    publishedTo: statistic.publishedTo.toISOString(),
    relativeEffect: decimal(statistic.relativeEffect),
    sensitivityHoldsDirection: statistic.sensitivityHoldsDirection,
    topContributorShare: decimal(statistic.topContributorShare),
  });
}
