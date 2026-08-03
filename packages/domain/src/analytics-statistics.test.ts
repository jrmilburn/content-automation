import { describe, expect, it } from "vitest";

import {
  benjaminiHochberg,
  bootstrapMedianDifference,
  calculateFeatureStatistic,
  createBootstrapSeed,
  durationBandFor,
  evaluateSensitivity,
  practicalEffectThreshold,
  statisticsVersion,
  topContributorShare,
  type FeatureComparisonInput,
} from "./analytics-statistics.js";

/**
 * The rules that decide whether a pattern is reported as evidence.
 *
 * Every threshold here comes from the contract. The tests are written as the
 * decisions a reader would dispute — "why is this only weak?" — because that is
 * what the classification has to be able to answer.
 */

function values(count: number, value: number): number[] {
  return Array.from({ length: count }, () => value);
}

/** A comparison that satisfies every supported-class requirement. */
function supported(overrides: Partial<FeatureComparisonInput> = {}): FeatureComparisonInput {
  return {
    comparison: values(24, 0.1),
    distinctPublicationDates: 12,
    distinctPublicationWeeks: 8,
    group: values(12, 0.2),
    key: "hook_category=question|engagement_rate_reach",
    metricIsCount: false,
    missingRatio: 0,
    survivesMultipleTesting: true,
    ...overrides,
  };
}

describe("determinism", () => {
  it("produces the same interval for the same data every run", () => {
    // A confidence class that changed between two runs over unchanged data
    // would be indefensible to anyone reading a trend.
    const first = calculateFeatureStatistic(supported());
    const second = calculateFeatureStatistic(supported());

    expect(first.interval).toEqual(second.interval);
    expect(first.classification).toBe(second.classification);
  });

  it("seeds from the values rather than their order", () => {
    const group = [0.2, 0.3, 0.1];
    const comparison = [0.1, 0.05];

    expect(createBootstrapSeed({ comparison, group, key: "k" })).toBe(
      createBootstrapSeed({
        comparison: [...comparison].reverse(),
        group: [...group].reverse(),
        key: "k",
      }),
    );
  });

  it("gives different comparisons different seeds", () => {
    expect(createBootstrapSeed({ comparison: [1], group: [2], key: "a" })).not.toBe(
      createBootstrapSeed({ comparison: [1], group: [2], key: "b" }),
    );
  });
});

describe("insufficient evidence", () => {
  it.each([
    ["a group below three", { group: values(2, 0.2) }],
    ["a comparison below five", { comparison: values(4, 0.1) }],
  ])("refuses %s", (_label, overrides) => {
    expect(calculateFeatureStatistic(supported(overrides)).classification).toBe(
      "insufficient_evidence",
    );
  });

  it("refuses a group published on fewer than three dates", () => {
    // Three posts from one afternoon are one event, not a pattern.
    const result = calculateFeatureStatistic(supported({ distinctPublicationDates: 2 }));

    expect(result).toMatchObject({
      classification: "insufficient_evidence",
      reason: "few_publication_dates",
    });
  });

  it("refuses a group where too much of the metric is missing", () => {
    expect(calculateFeatureStatistic(supported({ missingRatio: 0.41 }))).toMatchObject({
      classification: "insufficient_evidence",
      reason: "missingness_too_high",
    });
  });

  it("accepts missingness exactly at the boundary", () => {
    expect(calculateFeatureStatistic(supported({ missingRatio: 0.4 })).classification).not.toBe(
      "insufficient_evidence",
    );
  });
});

describe("single high-performing outlier", () => {
  it("never generalises from one post", () => {
    const result = calculateFeatureStatistic(supported({ group: [0.9] }));

    expect(result).toMatchObject({
      classification: "single_post_outlier",
      reason: "single_eligible_post",
    });
  });

  it("flags a count group where one post carries more than half the total", () => {
    const result = calculateFeatureStatistic(
      supported({ group: [900, 40, 30, 20], metricIsCount: true }),
    );

    expect(result).toMatchObject({
      classification: "single_post_outlier",
      reason: "top_post_dominates_total",
    });
    expect(result.topContributorShare).toBeGreaterThan(0.5);
  });

  it("does not compute a contribution share for a rate", () => {
    // A share of a total is undefined for a rate; producing one would look like
    // a share and mean nothing.
    expect(calculateFeatureStatistic(supported()).topContributorShare).toBeNull();
  });

  it("flags a group whose direction collapses when any one post is removed", () => {
    const result = calculateFeatureStatistic(
      supported({ comparison: values(6, 0.1), group: [0.9, 0.02, 0.02] }),
    );

    expect(result.classification).toBe("single_post_outlier");
    expect(result.sensitivity.preservesDirection).toBe(false);
  });

  it("is decided before any strength class", () => {
    // An outlier that also meets every sample threshold must still be an
    // outlier; promoting it is the exact mistake the class prevents.
    const result = calculateFeatureStatistic(
      supported({ group: [10_000, ...values(11, 1)], metricIsCount: true }),
    );

    expect(result.classification).toBe("single_post_outlier");
  });
});

describe("weak directional signal", () => {
  it("refuses to call a trivial difference a signal", () => {
    const result = calculateFeatureStatistic(
      supported({ comparison: values(24, 0.1), group: values(12, 0.104) }),
    );

    expect(result).toMatchObject({
      classification: "weak_directional_signal",
      reason: "effect_below_threshold",
    });
    expect(Math.abs(result.relativeEffect ?? 0)).toBeLessThan(practicalEffectThreshold);
  });

  it("stays weak when the sample is too small for a stronger class", () => {
    expect(
      calculateFeatureStatistic(
        supported({
          comparison: values(6, 0.1),
          distinctPublicationWeeks: 2,
          group: values(4, 0.2),
        }),
      ).classification,
    ).toBe("weak_directional_signal");
  });

  it("stays weak when one campaign dominates an otherwise supported group", () => {
    const result = calculateFeatureStatistic(supported({ groupDominatedByCampaign: true }));

    expect(result).toMatchObject({
      classification: "weak_directional_signal",
      reason: "campaign_dominates_group",
    });
  });
});

describe("moderate association", () => {
  it("is reached when the eighty percent interval excludes no difference", () => {
    const result = calculateFeatureStatistic(
      supported({
        comparison: values(12, 0.1),
        distinctPublicationWeeks: 3,
        group: values(8, 0.2),
      }),
    );

    expect(result).toMatchObject({
      classification: "moderate_association",
      reason: "meets_moderate_thresholds",
    });
    expect(result.interval?.excludesNoDifference).toBe(true);
  });

  it("caps a supported-sized group at moderate when multiple testing rejects it", () => {
    const result = calculateFeatureStatistic(supported({ survivesMultipleTesting: false }));

    expect(result).toMatchObject({
      classification: "moderate_association",
      reason: "multiple_testing_rejected",
    });
  });
});

describe("statistically supported association", () => {
  it("is reached only when every requirement holds", () => {
    const result = calculateFeatureStatistic(supported());

    expect(result).toMatchObject({
      classification: "statistically_supported_association",
      reason: "meets_supported_thresholds",
    });
    expect(result.interval?.excludesNoDifference).toBe(true);
    expect(result.statisticsVersion).toBe(statisticsVersion);
  });

  it.each([
    ["too few group posts", { group: values(11, 0.2) }],
    ["too few comparison posts", { comparison: values(23, 0.1) }],
    ["too few publication weeks", { distinctPublicationWeeks: 5 }],
  ])("falls short of supported with %s", (_label, overrides) => {
    expect(calculateFeatureStatistic(supported(overrides)).classification).not.toBe(
      "statistically_supported_association",
    );
  });
});

describe("evaluateSensitivity", () => {
  it("reports the direction surviving every leave-one-out refit", () => {
    const result = evaluateSensitivity({ comparison: values(6, 0.1), group: values(6, 0.2) });

    expect(result.preservesDirection).toBe(true);
    expect(result.minimumRelativeEffect).toBeCloseTo(1, 6);
  });

  it("reports a direction that does not survive", () => {
    expect(
      evaluateSensitivity({ comparison: [0.1, 0.1, 0.1], group: [0.9, 0.01, 0.01] })
        .preservesDirection,
    ).toBe(false);
  });

  it("only removes best and worst when the sample allows it", () => {
    expect(
      evaluateSensitivity({ comparison: values(5, 0.1), group: [0.2, 0.3, 0.25] })
        .removeBestWorstPreservesDirection,
    ).toBeNull();
    expect(
      evaluateSensitivity({ comparison: values(5, 0.1), group: [0.2, 0.3, 0.25, 0.28] })
        .removeBestWorstPreservesDirection,
    ).toBe(true);
  });
});

describe("bootstrapMedianDifference", () => {
  it("excludes no difference for two clearly separated samples", () => {
    const interval = bootstrapMedianDifference({
      comparison: values(20, 0.1),
      confidence: 0.95,
      group: values(20, 0.5),
      seed: 42,
    });

    expect(interval?.excludesNoDifference).toBe(true);
    expect(interval?.lower).toBeGreaterThan(0);
  });

  it("includes no difference for two identical samples", () => {
    const interval = bootstrapMedianDifference({
      comparison: values(20, 0.2),
      confidence: 0.95,
      group: values(20, 0.2),
      seed: 42,
    });

    expect(interval?.excludesNoDifference).toBe(false);
  });

  it("is reproducible from its seed", () => {
    const input = {
      comparison: [0.1, 0.12, 0.09, 0.11, 0.13],
      confidence: 0.95,
      group: [0.2, 0.22, 0.18, 0.21],
      seed: 7,
    } as const;

    expect(bootstrapMedianDifference(input)).toEqual(bootstrapMedianDifference(input));
  });

  it("returns null rather than an interval over nothing", () => {
    expect(
      bootstrapMedianDifference({ comparison: [], confidence: 0.95, group: [1], seed: 1 }),
    ).toBeNull();
  });
});

describe("benjaminiHochberg", () => {
  it("keeps a clearly significant hypothesis and rejects noise", () => {
    expect(benjaminiHochberg([0.001, 0.9, 0.8, 0.7])).toEqual([true, false, false, false]);
  });

  it("rejects everything when nothing is small enough", () => {
    expect(benjaminiHochberg([0.4, 0.5, 0.6])).toEqual([false, false, false]);
  });

  it("is less strict than Bonferroni, which is the point of using it", () => {
    // Four p-values at 0.02 survive BH at q=0.1 but not a 0.1/4 Bonferroni cut.
    expect(benjaminiHochberg([0.02, 0.02, 0.02, 0.02])).toEqual([true, true, true, true]);
  });

  it("returns a verdict per input, in input order", () => {
    expect(benjaminiHochberg([0.9, 0.001])).toEqual([false, true]);
  });
});

describe("topContributorShare", () => {
  it("reports the largest share of the total", () => {
    expect(topContributorShare([90, 10])).toBeCloseTo(0.9, 6);
  });

  it("returns null for a total of zero rather than dividing by it", () => {
    expect(topContributorShare([0, 0])).toBeNull();
    expect(topContributorShare([])).toBeNull();
  });
});

describe("durationBandFor", () => {
  it.each([
    [0, "under_15s"],
    [14.9, "under_15s"],
    [15, "15_29s"],
    [29.9, "15_29s"],
    [30, "30_44s"],
    [45, "45_59s"],
    [60, "60_89s"],
    [89.9, "60_89s"],
    [90, "90s_plus"],
    [600, "90s_plus"],
  ])("puts %ds in %s", (seconds, expected) => {
    expect(durationBandFor(seconds)).toBe(expected);
  });

  it("rejects a negative or non-finite duration", () => {
    expect(durationBandFor(-1)).toBeNull();
    expect(durationBandFor(Number.NaN)).toBeNull();
  });
});
