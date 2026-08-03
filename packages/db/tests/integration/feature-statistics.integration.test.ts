import { loadDatabaseConfig } from "@studio-parallel/config";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createDatabaseClient, type DatabaseClient } from "../../src/client.js";
import {
  calculateFeatureFamily,
  createStatisticFingerprint,
  storeFeatureStatistics,
  type FeatureComparisonCandidate,
  type FeatureObservation,
  type FeatureStatisticRequest,
} from "../../src/feature-statistics.js";
import { createId } from "../../src/id.js";
import { developmentWorkspace } from "../../src/seed-data.js";
import { createWorkspaceContext } from "../../src/workspace-context.js";

/**
 * What gets written, and what a repeat calculation does.
 *
 * The immutability guarantee is the one that needs a database: a statistic a
 * strategy cited must keep meaning what it meant, so a recalculation over
 * unchanged data must collapse rather than rewrite.
 */

const databaseConfig = loadDatabaseConfig();
let database: DatabaseClient;

const context = createWorkspaceContext(developmentWorkspace.id);
const calculatedAt = new Date("2026-08-03T04:00:00.000Z");
let accountId: string;

function observations(count: number, value: number, dayOffset = 0): FeatureObservation[] {
  return Array.from({ length: count }, (_unused, index) => ({
    instagramPostId: createId(),
    metricSnapshotId: createId(),
    postAnalysisId: createId(),
    // Spread across weeks so the supported class's distinct-week rule can pass.
    publishedAt: new Date(Date.UTC(2026, 0, 5 + dayOffset + index * 8)).toISOString(),
    value,
  }));
}

function candidate(
  overrides: Partial<FeatureComparisonCandidate> = {},
): FeatureComparisonCandidate {
  return {
    comparison: observations(24, 0.1, 1),
    featurePath: "content.hook.category",
    featureValue: "question",
    group: observations(12, 0.2),
    missingCount: 0,
    ...overrides,
  };
}

function request(overrides: Partial<FeatureStatisticRequest> = {}): FeatureStatisticRequest {
  return {
    ageWindow: "day_30",
    candidates: [candidate()],
    instagramAccountId: accountId,
    metric: "engagement_rate_reach",
    metricIsCount: false,
    publishedFrom: new Date("2026-01-01T00:00:00.000Z"),
    publishedTo: new Date("2026-07-31T00:00:00.000Z"),
    ...overrides,
  };
}

async function clear(): Promise<void> {
  await database.accountFeatureStatisticPost.deleteMany();
  await database.accountFeatureStatistic.deleteMany();
  await database.instagramAccount.deleteMany();
}

beforeAll(async () => {
  database = createDatabaseClient(databaseConfig.DATABASE_URL);
});

beforeEach(async () => {
  await clear();

  accountId = createId();
  await database.instagramAccount.create({
    data: {
      accountType: "BUSINESS",
      apiVersion: "v25.0",
      grantedScopes: ["instagram_business_basic"],
      id: accountId,
      providerAccountId: `1784140000000${Math.floor(Math.random() * 9000) + 1000}`,
      workspaceId: developmentWorkspace.id,
    },
  });
});

afterAll(async () => {
  await clear();
  await database.$disconnect();
});

describe("storeFeatureStatistics", () => {
  it("writes the statistic and every contributing post", async () => {
    const input = request();
    const calculated = calculateFeatureFamily(input);

    const result = await storeFeatureStatistics(database, context, input, calculated, calculatedAt);

    expect(result).toEqual({ skipped: 0, stored: 1 });

    const stored = await database.accountFeatureStatistic.findFirstOrThrow();
    expect(stored).toMatchObject({
      ageWindow: "day_30",
      comparisonCount: 24,
      confidence: "STATISTICALLY_SUPPORTED_ASSOCIATION",
      featurePath: "content.hook.category",
      featureValue: "question",
      groupCount: 12,
      metric: "engagement_rate_reach",
    });
    expect(Number(stored.relativeEffect)).toBeCloseTo(1, 6);

    // Both sides are recorded, so a claim can link to the exact posts behind it.
    expect(await database.accountFeatureStatisticPost.count()).toBe(36);
    expect(
      await database.accountFeatureStatisticPost.count({ where: { membership: "group" } }),
    ).toBe(12);
  });

  it("collapses a recalculation over unchanged data", async () => {
    // A statistic a strategy cited must keep meaning what it meant, so an
    // identical question over identical inputs must not write a second row.
    const input = request();
    const calculated = calculateFeatureFamily(input);

    await storeFeatureStatistics(database, context, input, calculated, calculatedAt);
    const second = await storeFeatureStatistics(
      database,
      context,
      input,
      calculated,
      new Date("2026-08-04T00:00:00.000Z"),
    );

    expect(second).toEqual({ skipped: 1, stored: 0 });
    expect(await database.accountFeatureStatistic.count()).toBe(1);
  });

  it("writes a new row when the contributing posts change", async () => {
    const first = request();
    await storeFeatureStatistics(
      database,
      context,
      first,
      calculateFeatureFamily(first),
      calculatedAt,
    );

    const second = request({ candidates: [candidate({ group: observations(12, 0.25) })] });
    await storeFeatureStatistics(
      database,
      context,
      second,
      calculateFeatureFamily(second),
      calculatedAt,
    );

    expect(await database.accountFeatureStatistic.count()).toBe(2);
  });

  it("records the seed and resamples so an interval can be reproduced", async () => {
    const input = request();
    await storeFeatureStatistics(
      database,
      context,
      input,
      calculateFeatureFamily(input),
      calculatedAt,
    );

    const stored = await database.accountFeatureStatistic.findFirstOrThrow();

    expect(stored.bootstrapResamples).toBe(2_000);
    expect(stored.bootstrapSeed).not.toBeNull();
    expect(stored.statisticsVersion).toBe("account-statistics-v1.0.0");
  });

  it("stores a weak result with its reason rather than discarding it", async () => {
    // An insufficient or weak comparison is a finding. Dropping it would leave
    // a reader unable to tell "no pattern" from "never calculated".
    const input = request({
      candidates: [candidate({ group: observations(12, 0.101) })],
    });

    await storeFeatureStatistics(
      database,
      context,
      input,
      calculateFeatureFamily(input),
      calculatedAt,
    );

    expect(await database.accountFeatureStatistic.findFirstOrThrow()).toMatchObject({
      classificationReason: "effect_below_threshold",
      confidence: "WEAK_DIRECTIONAL_SIGNAL",
    });
  });

  it("is invisible to another workspace", async () => {
    const input = request();
    await storeFeatureStatistics(
      database,
      context,
      input,
      calculateFeatureFamily(input),
      calculatedAt,
    );

    expect(
      await database.accountFeatureStatistic.count({ where: { workspaceId: createId() } }),
    ).toBe(0);
  });
});

describe("calculateFeatureFamily", () => {
  it("corrects across the family rather than per comparison", () => {
    // Testing every feature against every metric and reporting the strongest is
    // how noise becomes a finding, so the family is corrected as a whole.
    const many = Array.from({ length: 12 }, (_unused, index) =>
      candidate({ featureValue: `value_${index}`, group: observations(12, 0.2) }),
    );
    const calculated = calculateFeatureFamily(request({ candidates: many }));

    expect(calculated).toHaveLength(12);
    for (const entry of calculated) {
      expect(entry.statistic.classification).not.toBe("insufficient_evidence");
    }
  });

  it("fingerprints the contributing rows, not the calculation time", () => {
    const one = candidate();
    const fingerprint = createStatisticFingerprint({
      candidate: one,
      metric: "engagement_rate_reach",
      request: { ageWindow: "day_30", instagramAccountId: accountId },
    });

    expect(
      createStatisticFingerprint({
        candidate: one,
        metric: "engagement_rate_reach",
        request: { ageWindow: "day_30", instagramAccountId: accountId },
      }),
    ).toBe(fingerprint);

    expect(
      createStatisticFingerprint({
        candidate: one,
        metric: "like_rate_reach",
        request: { ageWindow: "day_30", instagramAccountId: accountId },
      }),
    ).not.toBe(fingerprint);
  });

  it("counts missing posts into the missingness rule", () => {
    const calculated = calculateFeatureFamily(
      request({ candidates: [candidate({ group: observations(4, 0.2), missingCount: 20 })] }),
    );

    expect(calculated[0]?.statistic).toMatchObject({
      classification: "insufficient_evidence",
      reason: "missingness_too_high",
    });
  });
});

describe("multiple-testing ranking", () => {
  it("treats a degenerate interval away from zero as maximal separation", async () => {
    // Every bootstrap resample of two constant samples gives the same
    // difference, so the interval has zero width. That is the strongest
    // possible separation; an earlier version ranked it as the weakest and
    // downgraded a clean result to moderate.
    const input = request();
    const calculated = calculateFeatureFamily(input);
    const interval = calculated[0]?.statistic.interval;

    expect(interval?.lower).toBe(interval?.upper);
    expect(interval?.excludesNoDifference).toBe(true);
    expect(calculated[0]?.statistic.classification).toBe("statistically_supported_association");
  });

  it("becomes stricter as the family grows", async () => {
    // The same comparison that survives alone must face a higher bar when it is
    // one of many, which is the entire point of correcting across a family.
    const alone = calculateFeatureFamily(request());
    expect(alone[0]?.statistic.classification).toBe("statistically_supported_association");

    const crowd = calculateFeatureFamily(
      request({
        candidates: Array.from({ length: 30 }, (_unused, index) =>
          candidate({
            featureValue: `value_${index}`,
            // Barely separated, so the ranking statistic sits near its ceiling.
            group: observations(12, index === 0 ? 0.2 : 0.115),
          }),
        ),
      }),
    );

    expect(crowd).toHaveLength(30);
    expect(crowd[0]?.statistic.classification).toBe("statistically_supported_association");
  });
});
