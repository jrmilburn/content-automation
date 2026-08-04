import "server-only";

import { loadAuthConfig } from "@studio-parallel/config";
import {
  createWorkspaceContext,
  listInstagramAccountSummaries,
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
 * The account choice is resolved here rather than in the page, because the
 * screen is meaningless without one: a statistic belongs to one account, and
 * showing the union across two would put two audiences in one median. When no
 * account is named, the first connected one is used, and the fact that a default
 * was chosen travels back so the screen can say so.
 *
 * The three empty results mean different things and are kept apart: no account
 * connected, an account whose calculation has never run, and a calculation whose
 * results the current filters exclude. Collapsing them would leave a reader
 * unable to tell "no patterns here" from "nothing has been measured".
 */

export type TrendsAccountOption = Readonly<{ id: string; label: string }>;

export type TrendsSnapshot = Readonly<{
  /** True when the account was defaulted rather than named by the reader. */
  accountDefaulted: boolean;
  accounts: readonly TrendsAccountOption[];
  featurePaths: readonly string[];
  hasAccount: boolean;
  list: TrendList;
  /** The account actually read, which may be a default rather than a choice. */
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
  const summaries = await listInstagramAccountSummaries(database, context, { now });

  const accounts = Object.freeze(
    summaries.map((summary) =>
      Object.freeze({
        id: summary.accountId,
        label: summary.username ? `@${summary.username}` : "Unnamed account",
      }),
    ),
  );

  const selectedAccountId = filters.matchesNothing
    ? null
    : (filters.instagramAccountId ?? accounts[0]?.id ?? null);
  const accountDefaulted = selectedAccountId !== null && !filters.instagramAccountId;

  if (selectedAccountId === null) {
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
      selectedAccountId: null,
    });
  }

  const [featurePaths, list] = await Promise.all([
    listTrendFeaturePaths(database, context, selectedAccountId),
    loadAccountTrends(database, context, { ...filters, instagramAccountId: selectedAccountId }),
  ]);

  return Object.freeze({
    accountDefaulted,
    accounts,
    featurePaths,
    hasAccount: accounts.length > 0,
    list,
    selectedAccountId,
  });
}

export async function loadTrendDetailSnapshot(
  statisticId: string,
  instagramAccountId: string | null,
  now = new Date(),
): Promise<TrendDetail | null> {
  const principal = await requireShellActor();
  if (loadAuthConfig().APP_ENV === "test") return testDetail(statisticId, now);

  const database = getDatabase();
  const context = createWorkspaceContext(principal.workspaceId);

  const accountId =
    instagramAccountId ??
    (await listInstagramAccountSummaries(database, context, { now }))[0]?.accountId ??
    null;

  if (accountId === null) return null;

  return loadTrendDetail(database, context, { instagramAccountId: accountId, statisticId });
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
    accountDefaulted: !filters.matchesNothing && !filters.instagramAccountId,
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
