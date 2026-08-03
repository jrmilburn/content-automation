import { createHash } from "node:crypto";

import {
  analyticsVersion,
  analysisSchemaVersion,
  benjaminiHochberg,
  calculateFeatureStatistic,
  cohortSelectionVersion,
  statisticsVersion,
  type ConfidenceClass,
  type DerivedMetric,
  type FeatureStatistic,
  type SnapshotAgeWindowKey,
} from "@studio-parallel/domain";

import type { Prisma, PrismaClient } from "./generated/prisma/client.js";
import { createId } from "./id.js";
import type { WorkspaceContext } from "./workspace-context.js";

/**
 * Persisting what a feature comparison showed.
 *
 * The statistics themselves are calculated in the domain package; this decides
 * which comparisons exist, applies the multiple-testing correction across them,
 * and writes the result with the posts that produced it.
 *
 * The correction has to happen here rather than per comparison, because
 * Benjamini-Hochberg is a statement about a family. Testing every feature value
 * against every metric and reporting whichever came out strongest is exactly how
 * noise becomes a finding, so the family is the whole set generated in one pass
 * and every member is corrected against it.
 */

const confidenceColumns: Readonly<Record<ConfidenceClass, string>> = Object.freeze({
  insufficient_evidence: "INSUFFICIENT_EVIDENCE",
  moderate_association: "MODERATE_ASSOCIATION",
  single_post_outlier: "SINGLE_POST_OUTLIER",
  statistically_supported_association: "STATISTICALLY_SUPPORTED_ASSOCIATION",
  weak_directional_signal: "WEAK_DIRECTIONAL_SIGNAL",
});

export type FeatureObservation = Readonly<{
  instagramPostId: string;
  metricSnapshotId: string;
  postAnalysisId: string;
  /** ISO date of publication, for the distinct-date and distinct-week counts. */
  publishedAt: string;
  value: number;
}>;

export type FeatureComparisonCandidate = Readonly<{
  /** Posts carrying the feature value. */
  group: readonly FeatureObservation[];
  /** Posts with a different known value for the same feature. */
  comparison: readonly FeatureObservation[];
  featurePath: string;
  featureValue: string;
  /** Eligible posts with no usable value, for the missingness rule. */
  missingCount: number;
}>;

export type FeatureStatisticRequest = Readonly<{
  ageWindow: SnapshotAgeWindowKey;
  candidates: readonly FeatureComparisonCandidate[];
  instagramAccountId: string;
  metric: DerivedMetric;
  /** Counts support a contribution share; rates do not. */
  metricIsCount: boolean;
  publishedFrom: Date;
  publishedTo: Date;
}>;

function isoWeek(date: Date): string {
  const utc = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = utc.getUTCDay() || 7;
  utc.setUTCDate(utc.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(utc.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((utc.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);

  return `${utc.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

function distinct(values: readonly string[]): number {
  return new Set(values).size;
}

/**
 * Fingerprints exactly what produced a statistic.
 *
 * Covers the contributing posts, snapshots and analyses plus every version that
 * could change the number. It answers "would recalculating change anything"
 * without recalculating, which is what lets #52 skip a run that cannot differ.
 */
export function createStatisticFingerprint(
  input: Readonly<{
    candidate: FeatureComparisonCandidate;
    metric: string;
    request: Pick<FeatureStatisticRequest, "ageWindow" | "instagramAccountId">;
  }>,
): string {
  const identify = (observations: readonly FeatureObservation[]): string[] =>
    observations
      .map(
        (observation) =>
          `${observation.instagramPostId}:${observation.metricSnapshotId}:${observation.postAnalysisId}`,
      )
      .sort();

  const canonical = JSON.stringify([
    analyticsVersion,
    statisticsVersion,
    cohortSelectionVersion,
    analysisSchemaVersion,
    input.request.instagramAccountId,
    input.request.ageWindow,
    input.metric,
    input.candidate.featurePath,
    input.candidate.featureValue,
    identify(input.candidate.group),
    identify(input.candidate.comparison),
  ]);

  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

export type CalculatedComparison = Readonly<{
  candidate: FeatureComparisonCandidate;
  fingerprint: string;
  statistic: FeatureStatistic;
}>;

/**
 * Calculates every comparison in one family, corrected together.
 *
 * Two passes are deliberate. The first produces effects without correction; the
 * second re-runs only those that reached the supported threshold, telling each
 * whether it survived the family-wide control. A single pass could not, because
 * the correction depends on the whole set.
 */
export function calculateFeatureFamily(
  request: FeatureStatisticRequest,
): readonly CalculatedComparison[] {
  const build = (
    candidate: FeatureComparisonCandidate,
    survivesMultipleTesting: boolean | null,
  ): FeatureStatistic => {
    const groupValues = candidate.group.map((observation) => observation.value);
    const eligible = candidate.group.length + candidate.missingCount;

    return calculateFeatureStatistic({
      comparison: candidate.comparison.map((observation) => observation.value),
      distinctPublicationDates: distinct(
        candidate.group.map((observation) => observation.publishedAt.slice(0, 10)),
      ),
      distinctPublicationWeeks: distinct(
        candidate.group.map((observation) => isoWeek(new Date(observation.publishedAt))),
      ),
      group: groupValues,
      key: `${candidate.featurePath}=${candidate.featureValue}|${request.metric}|${request.ageWindow}`,
      metricIsCount: request.metricIsCount,
      missingRatio: eligible === 0 ? 0 : candidate.missingCount / eligible,
      survivesMultipleTesting,
    });
  };

  const firstPass = request.candidates.map((candidate) => build(candidate, null));

  // Only comparisons that could reach the supported class are in the family: a
  // correction over comparisons that were never candidates would make the
  // threshold depend on how many weak results happened to exist.
  const familyIndexes = firstPass
    .map((statistic, index) => ({ index, statistic }))
    .filter((entry) => entry.statistic.classification === "statistically_supported_association")
    .map((entry) => entry.index);

  // Benjamini-Hochberg ranks by p-value, and a bootstrap interval does not
  // produce one. A 95% interval that excludes zero already establishes at most
  // 0.05 two-sided, so that is the ceiling; the interval's distance from zero
  // relative to its own width refines the ordering beneath it.
  //
  // This is a ranking statistic, not a probability, and is never reported as
  // one. It only has to be monotonic in evidence strength — a degenerate
  // zero-width interval away from zero is maximal separation, not minimal,
  // which an earlier version of this got backwards.
  const pseudoPValues = familyIndexes.map((index) => {
    const interval = firstPass[index]?.interval;
    if (!interval || !interval.excludesNoDifference) return 1;

    const distance = Math.min(Math.abs(interval.lower), Math.abs(interval.upper));
    const width = Math.abs(interval.upper - interval.lower);

    if (width === 0) return distance > 0 ? 0 : 1;

    return 0.05 / (1 + distance / width);
  });

  const survives = benjaminiHochberg(pseudoPValues);
  const verdicts = new Map<number, boolean>();
  familyIndexes.forEach((index, position) => verdicts.set(index, survives[position] ?? false));

  return Object.freeze(
    request.candidates.map((candidate, index) => {
      const verdict = verdicts.get(index);
      const statistic = verdict === undefined ? firstPass[index] : build(candidate, verdict);

      return Object.freeze({
        candidate,
        fingerprint: createStatisticFingerprint({
          candidate,
          metric: request.metric,
          request,
        }),
        statistic: statistic as FeatureStatistic,
      });
    }),
  );
}

function decimal(value: number | null | undefined): Prisma.Decimal | null {
  return value === null || value === undefined || !Number.isFinite(value)
    ? null
    : (value as unknown as Prisma.Decimal);
}

/**
 * Writes one calculated family, skipping anything already stored.
 *
 * The unique key is the question plus the input fingerprint, so recalculating
 * over unchanged data collapses onto the existing row. A row is never updated:
 * a statistic a strategy cited must keep meaning what it meant.
 */
export async function storeFeatureStatistics(
  database: PrismaClient,
  context: WorkspaceContext,
  request: FeatureStatisticRequest,
  calculated: readonly CalculatedComparison[],
  calculatedAt: Date,
  // The run these belong to. Rows written under a BUILDING run are invisible to
  // readers until it activates, which is what makes publication atomic.
  calculationRunId: string,
): Promise<Readonly<{ stored: number; skipped: number }>> {
  let stored = 0;
  let skipped = 0;

  for (const entry of calculated) {
    const existing = await database.accountFeatureStatistic.findFirst({
      select: { id: true },
      where: {
        ageWindow: request.ageWindow,
        featurePath: entry.candidate.featurePath,
        featureValue: entry.candidate.featureValue,
        inputFingerprint: entry.fingerprint,
        instagramAccountId: request.instagramAccountId,
        metric: request.metric,
        workspaceId: context.workspaceId,
      },
    });

    if (existing) {
      skipped += 1;
      continue;
    }

    const { statistic } = entry;
    const eligible = entry.candidate.group.length + entry.candidate.missingCount;
    const id = createId();

    await database.$transaction(async (transaction) => {
      await transaction.accountFeatureStatistic.create({
        data: {
          // Three relations share `workspaceId`, so Prisma requires the checked
          // input: each composite key is connected rather than set as a scalar.
          account: {
            connect: {
              workspaceId_id: {
                id: request.instagramAccountId,
                workspaceId: context.workspaceId,
              },
            },
          },
          ageWindow: request.ageWindow,
          analysisSchemaVersion,
          analyticsVersion,
          bootstrapResamples: statistic.interval?.resamples ?? null,
          bootstrapSeed: statistic.interval === null ? null : BigInt(statistic.interval.seed),
          calculatedAt,
          calculationRun: {
            connect: {
              workspaceId_id: { id: calculationRunId, workspaceId: context.workspaceId },
            },
          },
          classificationReason: statistic.reason,
          cohortVersion: cohortSelectionVersion,
          comparisonCount: statistic.comparisonCount,
          comparisonIqr: decimal(statistic.comparisonSpread.interquartileRange),
          comparisonMedian: decimal(statistic.comparisonSpread.median),
          confidence: confidenceColumns[statistic.classification] as never,
          differenceOfMedians: decimal(statistic.differenceOfMedians),
          distinctPublicationDates: distinct(
            entry.candidate.group.map((observation) => observation.publishedAt.slice(0, 10)),
          ),
          distinctPublicationWeeks: distinct(
            entry.candidate.group.map((observation) => isoWeek(new Date(observation.publishedAt))),
          ),
          featurePath: entry.candidate.featurePath,
          featureValue: entry.candidate.featureValue,
          groupCount: statistic.groupCount,
          groupIqr: decimal(statistic.groupSpread.interquartileRange),
          groupMedian: decimal(statistic.groupSpread.median),
          id,
          inputFingerprint: entry.fingerprint,
          intervalConfidence: decimal(
            statistic.classification === "statistically_supported_association" ? 0.95 : 0.8,
          ),
          intervalLower: decimal(statistic.interval?.lower),
          intervalUpper: decimal(statistic.interval?.upper),
          metric: request.metric,
          missingRatio: decimal(
            eligible === 0 ? 0 : entry.candidate.missingCount / eligible,
          ) as Prisma.Decimal,
          multipleTestingApplied:
            statistic.classification === "statistically_supported_association" ||
            statistic.reason === "multiple_testing_rejected",
          publishedFrom: request.publishedFrom,
          publishedTo: request.publishedTo,
          relativeEffect: decimal(statistic.relativeEffect),
          sensitivityHoldsDirection: statistic.sensitivity.preservesDirection,
          statisticsVersion,
          topContributorShare: decimal(statistic.topContributorShare),
          workspace: { connect: { id: context.workspaceId } },
        },
      });

      const members = [
        ...entry.candidate.group.map((observation) => ({ membership: "group", observation })),
        ...entry.candidate.comparison.map((observation) => ({
          membership: "comparison",
          observation,
        })),
      ];

      await transaction.accountFeatureStatisticPost.createMany({
        data: members.map(({ membership, observation }) => ({
          id: createId(),
          instagramPostId: observation.instagramPostId,
          membership,
          metricSnapshotId: observation.metricSnapshotId,
          postAnalysisId: observation.postAnalysisId,
          statisticId: id,
          value: decimal(observation.value) as Prisma.Decimal,
          workspaceId: context.workspaceId,
        })),
        skipDuplicates: true,
      });
    });

    stored += 1;
  }

  return Object.freeze({ skipped, stored });
}
