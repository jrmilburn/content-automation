import "server-only";

import { loadAuthConfig } from "@studio-parallel/config";
import {
  createWorkspaceContext,
  listInstagramAccountSummaries,
  listPublishedTrendScopes,
  listTrendFeaturePaths,
  loadAccountTrends,
  loadTrendDetail,
  type TrendDetail,
  type TrendList,
  type TrendListItem,
} from "@studio-parallel/db";

import type { TrendsFilters } from "../trends";
import { getDatabase } from "./database";
import { requireShellActor } from "./shell-session";

/**
 * Loads calculated trends plus what the filter form needs to offer.
 *
 * The scope is resolved here rather than in the page, because the screen is
 * meaningless without one: every figure belongs either to one account or to
 * every linked account pooled, and the two are separate calculations rather
 * than two views of the same numbers. When the reader names neither, the pooled
 * calculation is preferred and the first connected account is the fallback —
 * pooled first because it is the only scope that answers "what works for us"
 * rather than "what works for one of our accounts". Either way the fact that a
 * default was chosen travels back so the screen can say so.
 *
 * The three empty results mean different things and are kept apart: no account
 * connected, a scope whose calculation has never run, and a calculation whose
 * results the current filters exclude. Collapsing them would leave a reader
 * unable to tell "no patterns here" from "nothing has been measured".
 */

export type TrendsAccountOption = Readonly<{ id: string; label: string }>;

export type TrendsSnapshot = Readonly<{
  /** True when the scope was defaulted rather than named by the reader. */
  accountDefaulted: boolean;
  accounts: readonly TrendsAccountOption[];
  featurePaths: readonly string[];
  hasAccount: boolean;
  list: TrendList;
  /** True when the figures pool every linked account instead of describing one. */
  pooled: boolean;
  /** Whether a pooled calculation has published, so the scope can be offered. */
  pooledAvailable: boolean;
  /** The account actually read, or null when the scope is pooled or unresolved. */
  selectedAccountId: string | null;
}>;

export async function loadTrendsSnapshot(
  filters: TrendsFilters,
  now = new Date(),
): Promise<TrendsSnapshot> {
  const principal = await requireShellActor();
  if (loadAuthConfig().APP_ENV === "test") return testSnapshot(filters, now);

  const database = getDatabase();
  const context = createWorkspaceContext(principal.workspaceId);
  const [summaries, publishedScopes] = await Promise.all([
    listInstagramAccountSummaries(database, context, { now }),
    listPublishedTrendScopes(database, context),
  ]);

  const accounts = Object.freeze(
    summaries.map((summary) =>
      Object.freeze({
        id: summary.accountId,
        label: summary.username ? `@${summary.username}` : "Unnamed account",
      }),
    ),
  );

  const pooledAvailable = publishedScopes.includes(null);
  const requested = filters.instagramAccountId;
  const defaulted = requested === undefined;
  const scope = defaulted
    ? defaultScope(
        pooledAvailable,
        accounts.map((account) => account.id),
      )
    : requested;

  // An unrecognised filter value empties the screen rather than widening it, so
  // nothing is read even when a scope did resolve.
  if (filters.matchesNothing || scope === undefined) {
    return Object.freeze({
      accountDefaulted: false,
      accounts,
      featurePaths: Object.freeze([]),
      hasAccount: accounts.length > 0,
      list: Object.freeze({
        calculation: null,
        generatedAt: now.toISOString(),
        trends: Object.freeze([]),
      }),
      pooled: false,
      pooledAvailable,
      selectedAccountId: null,
    });
  }

  const [featurePaths, list] = await Promise.all([
    listTrendFeaturePaths(database, context, scope),
    loadAccountTrends(database, context, { ...filters, instagramAccountId: scope }),
  ]);

  return Object.freeze({
    accountDefaulted: defaulted,
    accounts,
    featurePaths,
    hasAccount: accounts.length > 0,
    list,
    pooled: scope === null,
    pooledAvailable,
    selectedAccountId: scope,
  });
}

/**
 * The scope to read when the reader named none.
 *
 * Undefined rather than a guess when there is nothing to read: a workspace with
 * no connected account and no pooled run has no scope, and inventing one would
 * turn "connect an account" into "this account has no patterns".
 */
function defaultScope(
  pooledAvailable: boolean,
  accountIds: readonly string[],
): string | null | undefined {
  if (pooledAvailable) return null;

  return accountIds[0];
}

export async function loadTrendDetailSnapshot(
  statisticId: string,
  instagramAccountId: string | null | undefined,
  now = new Date(),
): Promise<TrendDetail | null> {
  const principal = await requireShellActor();
  if (loadAuthConfig().APP_ENV === "test") return testDetail(statisticId, now);

  const database = getDatabase();
  const context = createWorkspaceContext(principal.workspaceId);

  if (instagramAccountId !== undefined) {
    return loadTrendDetail(database, context, { instagramAccountId, statisticId });
  }

  // A link that carried no scope is resolved exactly as the list resolves one,
  // so following a bookmark from a pooled screen does not land on an account's
  // calculation — where the statistic would read as missing rather than pooled.
  const [summaries, publishedScopes] = await Promise.all([
    listInstagramAccountSummaries(database, context, { now }),
    listPublishedTrendScopes(database, context),
  ]);

  const scope = defaultScope(
    publishedScopes.includes(null),
    summaries.map((summary) => summary.accountId),
  );

  if (scope === undefined) return null;

  return loadTrendDetail(database, context, { instagramAccountId: scope, statisticId });
}

const testAccountId = "019a0000-0000-7000-8000-000000000301";
const testRunId = "019a0000-0000-7000-8000-000000000801";

/**
 * One trend per confidence class, so the browser run exercises every section,
 * every badge and every explanation without a calculation having happened.
 */
const testTrends: readonly TrendListItem[] = Object.freeze([
  Object.freeze({
    ageWindow: "day_30",
    classificationReason: "meets_supported_thresholds" as const,
    comparisonCount: 31,
    comparisonIqr: 0.012,
    comparisonMedian: 0.041,
    confidence: "statistically_supported_association" as const,
    differenceOfMedians: 0.017,
    distinctPublicationDates: 14,
    distinctPublicationWeeks: 9,
    featurePath: "content.hook.category",
    featureValue: "question",
    groupCount: 14,
    groupIqr: 0.016,
    groupMedian: 0.058,
    id: "019a0000-0000-7000-8000-000000000901",
    intervalConfidence: 0.95,
    intervalLower: 0.006,
    intervalUpper: 0.028,
    metric: "engagement_rate_reach" as const,
    missingRatio: 0.04,
    multipleTestingApplied: true,
    publishedFrom: "2026-02-03T00:00:00.000Z",
    publishedTo: "2026-08-03T00:00:00.000Z",
    relativeEffect: 0.414,
    sensitivityHoldsDirection: true,
    topContributorShare: null,
  }),
  Object.freeze({
    ageWindow: "day_30",
    classificationReason: "meets_moderate_thresholds" as const,
    comparisonCount: 22,
    comparisonIqr: 0.009,
    comparisonMedian: 0.028,
    confidence: "moderate_association" as const,
    differenceOfMedians: -0.005,
    distinctPublicationDates: 11,
    distinctPublicationWeeks: 7,
    featurePath: "content.durationBand",
    featureValue: "90s_plus",
    groupCount: 9,
    groupIqr: 0.007,
    groupMedian: 0.023,
    id: "019a0000-0000-7000-8000-000000000902",
    intervalConfidence: 0.8,
    intervalLower: -0.009,
    intervalUpper: -0.001,
    metric: "save_rate_reach" as const,
    missingRatio: 0.0,
    multipleTestingApplied: false,
    publishedFrom: "2026-02-03T00:00:00.000Z",
    publishedTo: "2026-08-03T00:00:00.000Z",
    relativeEffect: -0.178,
    sensitivityHoldsDirection: true,
    topContributorShare: null,
  }),
  Object.freeze({
    ageWindow: "day_30",
    classificationReason: "interval_includes_no_difference" as const,
    comparisonCount: 18,
    comparisonIqr: 0.021,
    comparisonMedian: 0.062,
    confidence: "weak_directional_signal" as const,
    differenceOfMedians: 0.008,
    distinctPublicationDates: 8,
    distinctPublicationWeeks: 5,
    featurePath: "content.presenterMode",
    featureValue: "on_camera",
    groupCount: 7,
    groupIqr: 0.024,
    groupMedian: 0.07,
    id: "019a0000-0000-7000-8000-000000000903",
    intervalConfidence: 0.8,
    intervalLower: -0.003,
    intervalUpper: 0.019,
    metric: "like_rate_reach" as const,
    missingRatio: 0.11,
    multipleTestingApplied: false,
    publishedFrom: "2026-02-03T00:00:00.000Z",
    publishedTo: "2026-08-03T00:00:00.000Z",
    relativeEffect: 0.129,
    sensitivityHoldsDirection: true,
    topContributorShare: null,
  }),
  Object.freeze({
    ageWindow: "day_30",
    classificationReason: "top_post_dominates_total" as const,
    comparisonCount: 26,
    comparisonIqr: 84,
    comparisonMedian: 210,
    confidence: "single_post_outlier" as const,
    differenceOfMedians: 190,
    distinctPublicationDates: 6,
    distinctPublicationWeeks: 4,
    featurePath: "callToAction.type",
    featureValue: "follow",
    groupCount: 5,
    groupIqr: 320,
    groupMedian: 400,
    id: "019a0000-0000-7000-8000-000000000904",
    intervalConfidence: null,
    intervalLower: null,
    intervalUpper: null,
    metric: "engagement_count" as const,
    missingRatio: 0.02,
    multipleTestingApplied: false,
    publishedFrom: "2026-02-03T00:00:00.000Z",
    publishedTo: "2026-08-03T00:00:00.000Z",
    relativeEffect: 0.905,
    sensitivityHoldsDirection: false,
    topContributorShare: 0.72,
  }),
  Object.freeze({
    ageWindow: "day_30",
    classificationReason: "below_minimum_samples" as const,
    comparisonCount: 3,
    comparisonIqr: null,
    comparisonMedian: 0.033,
    confidence: "insufficient_evidence" as const,
    differenceOfMedians: null,
    distinctPublicationDates: 2,
    distinctPublicationWeeks: 2,
    featurePath: "content.contentPillar",
    featureValue: "education_and_insight",
    groupCount: 2,
    groupIqr: null,
    groupMedian: 0.037,
    id: "019a0000-0000-7000-8000-000000000905",
    intervalConfidence: null,
    intervalLower: null,
    intervalUpper: null,
    metric: "share_rate_reach" as const,
    missingRatio: 0.08,
    multipleTestingApplied: false,
    publishedFrom: "2026-02-03T00:00:00.000Z",
    publishedTo: "2026-08-03T00:00:00.000Z",
    relativeEffect: null,
    sensitivityHoldsDirection: null,
    topContributorShare: null,
  }),
]);

function testCalculation(now: Date) {
  return Object.freeze({
    ageWindow: "day_30",
    analysisCount: 45,
    analyticsVersion: "account-analytics-v1.0.0",
    activatedAt: new Date(now.getTime() - 90 * 60 * 1_000).toISOString(),
    durationMs: 8_400,
    id: testRunId,
    instagramAccountId: testAccountId,
    publishedFrom: "2026-02-03T00:00:00.000Z",
    publishedTo: "2026-08-03T00:00:00.000Z",
    statisticCount: testTrends.length,
    statisticsVersion: "account-statistics-v1.0.0",
  });
}

function testSnapshot(filters: TrendsFilters, now: Date): TrendsSnapshot {
  const matching = filters.matchesNothing
    ? []
    : testTrends.filter(
        (trend) =>
          (!filters.confidence || trend.confidence === filters.confidence) &&
          (!filters.featurePath || trend.featurePath === filters.featurePath) &&
          (!filters.metric || trend.metric === filters.metric) &&
          (!filters.instagramAccountId || filters.instagramAccountId === testAccountId),
      );

  return Object.freeze({
    accountDefaulted: !filters.matchesNothing && filters.instagramAccountId === undefined,
    accounts: Object.freeze([Object.freeze({ id: testAccountId, label: "@studioparallel" })]),
    featurePaths: Object.freeze([
      "callToAction.type",
      "content.contentPillar",
      "content.durationBand",
      "content.hook.category",
      "content.presenterMode",
    ]),
    hasAccount: true,
    list: Object.freeze({
      calculation: testCalculation(now),
      generatedAt: now.toISOString(),
      trends: Object.freeze(matching),
    }),
    pooled: false,
    // The fixture workspace has one account and no pooled calculation, even
    // though production prefers pooled wherever one exists. A pooled fixture
    // would stop covering the outlier card and the strong badge — the pooled
    // calculation excludes `engagement_count` and is capped below the supported
    // class — and those are two of the things the browser and accessibility runs
    // exist to check. A pooled browser run needs its own fixture workspace.
    pooledAvailable: false,
    selectedAccountId: filters.matchesNothing ? null : testAccountId,
  });
}

function testDetail(statisticId: string, now: Date): TrendDetail | null {
  const trend = testTrends.find((candidate) => candidate.id === statisticId);
  if (!trend) return null;

  const contributors = Array.from({ length: 6 }, (_unused, index) =>
    Object.freeze({
      caption:
        index === 1
          ? null
          : `Reference post ${index + 1} for ${trend.featurePath} = ${trend.featureValue}.`,
      instagramPostId: `019a0000-0000-7000-8000-00000000041${index}`,
      membership: index < 3 ? ("group" as const) : ("comparison" as const),
      permalink: `https://www.instagram.com/reel/trend${index}/`,
      postAnalysisId: `019a0000-0000-7000-8000-00000000042${index}`,
      publishedAt: new Date(Date.UTC(2026, 5, 2 + index * 5)).toISOString(),
      value: index < 3 ? 0.06 - index * 0.004 : 0.042 - index * 0.002,
    }),
  );

  return Object.freeze({
    calculation: testCalculation(now),
    contributors: Object.freeze(contributors),
    trend,
  });
}
