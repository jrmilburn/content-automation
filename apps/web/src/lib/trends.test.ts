import type { TrendListItem } from "@studio-parallel/db";
import {
  confidenceClasses,
  presentConfidence,
  type ConfidenceClass,
} from "@studio-parallel/domain";
import { describe, expect, it } from "vitest";

import {
  comparisonRows,
  groupTrends,
  hasActiveTrendFilters,
  parseTrendsFilters,
  presentInterval,
  presentMissingness,
  presentSensitivity,
  trendDetailHref,
  trendHeadline,
  type TrendsFilterValues,
} from "./trends";

const accountId = "019a0000-0000-7000-8000-000000000301";

function trend(overrides: Partial<TrendListItem> = {}): TrendListItem {
  return {
    ageWindow: "day_30",
    classificationReason: "meets_supported_thresholds",
    comparisonCount: 24,
    comparisonIqr: 0.01,
    comparisonMedian: 0.04,
    confidence: "statistically_supported_association",
    differenceOfMedians: 0.02,
    distinctPublicationDates: 12,
    distinctPublicationWeeks: 7,
    featurePath: "content.hook.category",
    featureValue: "question",
    groupCount: 12,
    groupIqr: 0.015,
    groupMedian: 0.06,
    id: "019a0000-0000-7000-8000-000000000901",
    intervalConfidence: 0.95,
    intervalLower: 0.008,
    intervalUpper: 0.031,
    metric: "engagement_rate_reach",
    missingRatio: 0.03,
    multipleTestingApplied: true,
    publishedFrom: "2026-02-03T00:00:00.000Z",
    publishedTo: "2026-08-03T00:00:00.000Z",
    relativeEffect: 0.5,
    sensitivityHoldsDirection: true,
    topContributorShare: null,
    ...overrides,
  };
}

function values(overrides: Partial<TrendsFilterValues> = {}): TrendsFilterValues {
  return { account: "", confidence: "all", feature: "", metric: "all", ...overrides };
}

describe("parseTrendsFilters", () => {
  it("keeps a valid filter set", () => {
    const parsed = parseTrendsFilters({
      account: accountId,
      confidence: "weak_directional_signal",
      feature: "content.hook.category",
      metric: "like_rate_reach",
    });

    expect(parsed.filters).toEqual({
      confidence: "weak_directional_signal",
      featurePath: "content.hook.category",
      instagramAccountId: accountId,
      metric: "like_rate_reach",
    });
    expect(parsed.values.metric).toBe("like_rate_reach");
  });

  it("treats an absent query as no filters at all", () => {
    const parsed = parseTrendsFilters({});

    expect(parsed.filters).toEqual({});
    expect(hasActiveTrendFilters(parsed.values)).toBe(false);
  });

  it("treats all as unset rather than invalid", () => {
    const parsed = parseTrendsFilters({ confidence: "all", metric: "all" });

    expect(parsed.filters).toEqual({});
    expect(parsed.values.confidence).toBe("all");
  });

  it.each([
    ["confidence", { confidence: "very_confident" }],
    ["metric", { metric: "vibes" }],
    ["account", { account: "not-a-uuid" }],
  ])("empties the result when the %s filter is unrecognised", (_name, query) => {
    // Dropping the filter would widen the result to everything and read as
    // "here is what we found", when the truth is the filter was ignored. On this
    // screen that would present another account's evidence as this one's.
    const parsed = parseTrendsFilters(query);

    expect(parsed.filters.matchesNothing).toBe(true);
  });

  it("reads only the first value of a repeated parameter", () => {
    const parsed = parseTrendsFilters({ metric: ["like_rate_reach", "save_rate_reach"] });

    expect(parsed.filters.metric).toBe("like_rate_reach");
  });

  it("bounds a feature path rather than validating it against a closed set", () => {
    // The run decides which feature paths exist, so this layer cannot enumerate
    // them. Bounding the length keeps an arbitrary string out of the query.
    const parsed = parseTrendsFilters({ feature: "x".repeat(400) });

    expect(parsed.filters.featurePath).toHaveLength(128);
    expect(parsed.filters.matchesNothing).toBeUndefined();
  });
});

describe("trendDetailHref", () => {
  it("carries the account so a shared link resolves the same comparison", () => {
    expect(
      trendDetailHref("019a0000-0000-7000-8000-000000000901", values({ account: accountId })),
    ).toBe(`/trends/019a0000-0000-7000-8000-000000000901?account=${accountId}`);
  });

  it("omits the account when none was chosen", () => {
    expect(trendDetailHref("019a0000-0000-7000-8000-000000000901", values())).toBe(
      "/trends/019a0000-0000-7000-8000-000000000901",
    );
  });
});

describe("groupTrends", () => {
  it("keeps every section even when it has nothing in it", () => {
    // An absent "supported associations" heading reads as "there were none",
    // which is indistinguishable from "we did not look".
    const groups = groupTrends([trend({ confidence: "single_post_outlier" })]);

    expect(groups.map((group) => group.key)).toEqual([
      "supported",
      "directional",
      "outlier",
      "limited",
    ]);
    expect(groups[0]?.trends).toHaveLength(0);
    expect(groups[2]?.trends).toHaveLength(1);
  });

  it.each(confidenceClasses)("places a %s result in exactly one section", (confidence) => {
    const groups = groupTrends([trend({ confidence })]);
    const placed = groups.filter((group) => group.trends.length === 1);

    expect(placed).toHaveLength(1);
  });

  it("reads a moderate association alongside a supported one", () => {
    // Both are findings a reader can act on; the card's own badge is what keeps
    // them apart, not a separate heading.
    const groups = groupTrends([
      trend({ confidence: "moderate_association", id: "a" }),
      trend({ confidence: "statistically_supported_association", id: "b" }),
    ]);

    expect(groups[0]?.trends).toHaveLength(2);
  });
});

describe("evidence language", () => {
  it.each(confidenceClasses)("scopes the %s claim to this account", (confidence) => {
    const { claim } = presentConfidence(confidence);

    // A cohort is bounded to one account by construction, so a claim that does
    // not say so states a general finding the data cannot carry.
    expect(claim.toLowerCase()).toContain("account");
  });

  it.each(confidenceClasses)("never states the %s claim as a cause", (confidence) => {
    const { claim } = presentConfidence(confidence);

    for (const causal of ["because", "causes", "caused", "drives up", "will increase"]) {
      expect(claim.toLowerCase()).not.toContain(causal);
    }
  });

  it("marks only the supported class as strong", () => {
    const strong = confidenceClasses.filter(
      (confidence: ConfidenceClass) => presentConfidence(confidence).strong,
    );

    expect(strong).toEqual(["statistically_supported_association"]);
  });

  it("says an insufficient result is not a finding of no difference", () => {
    expect(presentConfidence("insufficient_evidence").claim).toContain("not a finding");
  });
});

describe("trend presentation", () => {
  it("names the feature and its value rather than advising an action", () => {
    // "Use question hooks" is a recommendation the statistics do not license.
    expect(trendHeadline(trend())).toBe("Hook type: Question");
  });

  it("labels a duration band from the calculated bands", () => {
    expect(
      trendHeadline(trend({ featurePath: "content.durationBand", featureValue: "15_29s" })),
    ).toBe("Duration: 15–29s");
  });

  it("names both sides of the comparison in the table", () => {
    const rows = comparisonRows(trend());

    expect(rows[0]?.label).toBe("Posts with Question");
    expect(rows[0]?.median).toBe("6.00%");
    expect(rows[1]?.label).toBe("Posts with another value");
    expect(rows[1]?.count).toBe(24);
  });

  it("formats a count metric as a count rather than a percentage", () => {
    const rows = comparisonRows(
      trend({ comparisonMedian: 210, groupMedian: 400, metric: "engagement_count" }),
    );

    expect(rows[0]?.median).toBe("400");
  });

  it("says an interval was not calculated rather than showing a dash", () => {
    // A comparison that never reached the sample threshold was never
    // bootstrapped; a dash would let a reader take it for a precise result.
    const absent = presentInterval(trend({ intervalLower: null, intervalUpper: null }));

    expect(absent).toContain("Not calculated");
    expect(presentInterval(trend())).toContain("95% range");
  });

  it("distinguishes an unchecked sensitivity from a failed one", () => {
    expect(presentSensitivity(trend({ sensitivityHoldsDirection: null }))).toContain("Not checked");
    expect(presentSensitivity(trend({ sensitivityHoldsDirection: false }))).toContain(
      "Direction changes",
    );
  });

  it("reports missingness as a share of the eligible posts", () => {
    expect(presentMissingness(trend({ missingRatio: 0 }))).toContain("Every eligible post");
    expect(presentMissingness(trend({ missingRatio: 0.22 }))).toContain("22%");
  });
});
