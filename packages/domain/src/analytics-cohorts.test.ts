import { describe, expect, it } from "vitest";

import {
  cohortSelectionVersion,
  compareToBaseline,
  createCohortFingerprint,
  excludeFocalPost,
  median,
  recentCohortDays,
  recentCohortPostLimit,
  selectComparableSnapshot,
  selectComparableSnapshots,
  snapshotAgeWindowFor,
  snapshotAgeWindows,
  summariseCoverage,
  summariseSpread,
  type ComparableSnapshotCandidate,
  type SnapshotAgeWindowKey,
} from "./analytics-cohorts.js";
import { instagramSnapshotBucketFor, instagramSnapshotBuckets } from "./instagram-insights.js";

function candidate(
  snapshotId: string,
  postAgeSeconds: number,
  postId = "post_a",
  capturedAtMs = 1_000,
): ComparableSnapshotCandidate {
  return { capturedAt: new Date(capturedAtMs), postAgeSeconds, postId, snapshotId };
}

describe("snapshot age windows", () => {
  it("agrees with the storage buckets on every upper edge", () => {
    // Both come from the same contract table. If they ever disagree, a snapshot
    // would be stored under one name and selected under another.
    for (const window of snapshotAgeWindows) {
      const bucket = instagramSnapshotBuckets.find((entry) => entry.key === window.key);
      expect(bucket?.maximumSeconds).toBe(window.maximumSeconds);
    }
  });

  it("carries the lower tolerance the storage buckets do not", () => {
    // A partition assigns by upper edge alone; a tolerance needs both edges.
    expect(snapshotAgeWindowFor("day_1").minimumSeconds).toBe(64_800);
    expect(snapshotAgeWindowFor("day_3").minimumSeconds).toBe(216_000);
    expect(snapshotAgeWindowFor("day_7").minimumSeconds).toBe(518_400);
    expect(snapshotAgeWindowFor("day_30").minimumSeconds).toBe(2_160_000);
  });

  it.each([
    ["import", 0, true],
    ["import", 1_800, true],
    ["import", 1_801, false],
    ["hour_1", 1_799, false],
    ["hour_1", 1_800, true],
    ["hour_1", 7_200, true],
    ["hour_1", 7_201, false],
    ["day_1", 64_799, false],
    ["day_1", 64_800, true],
    ["day_1", 129_600, true],
    ["day_1", 129_601, false],
    ["day_3", 215_999, false],
    ["day_3", 216_000, true],
    ["day_3", 345_600, true],
    ["day_3", 345_601, false],
    ["day_7", 518_399, false],
    ["day_7", 518_400, true],
    ["day_7", 777_600, true],
    ["day_7", 777_601, false],
    ["day_30", 2_159_999, false],
    ["day_30", 2_160_000, true],
    ["day_30", 3_456_000, true],
    ["day_30", 3_456_001, false],
    ["mature", 3_455_999, false],
    ["mature", 3_456_000, true],
    ["mature", 99_999_999, true],
  ] as const)("admits age %s/%d -> %s", (windowKey, age, expected) => {
    const selected = selectComparableSnapshot(
      [candidate("snap_1", age)],
      windowKey as SnapshotAgeWindowKey,
    );

    expect(selected !== null).toBe(expected);
  });

  it("lets day_30 and mature both admit exactly forty days", () => {
    // A selection window answers "is this comparable", which two windows may both
    // answer yes to, unlike a storage bucket which must pick one home.
    const fortyDays = [candidate("snap_1", 3_456_000)];

    expect(selectComparableSnapshot(fortyDays, "day_30")?.snapshotId).toBe("snap_1");
    expect(selectComparableSnapshot(fortyDays, "mature")?.snapshotId).toBe("snap_1");
  });
});

describe("comparable snapshot selection", () => {
  it("never backdates a snapshot the storage bucket labelled optimistically", () => {
    // The storage partition assigns by upper edge, so a ten-hour observation is
    // stored as day_1. day_1 means 18-36h, so it must not be selected: comparing
    // a ten-hour post against settled ones is the exact error this prevents.
    const tenHours = 36_000;

    expect(instagramSnapshotBucketFor(tenHours)).toBe("day_1");
    expect(selectComparableSnapshot([candidate("snap_1", tenHours)], "day_1")).toBeNull();
  });

  it("leaves an insufficient bucket insufficient rather than borrowing a later snapshot", () => {
    const candidates = [candidate("snap_late", 200_000), candidate("snap_later", 900_000)];

    expect(selectComparableSnapshot(candidates, "day_1")).toBeNull();
  });

  it("contributes at most one snapshot per post", () => {
    const candidates = [
      candidate("snap_1", 70_000, "post_a"),
      candidate("snap_2", 86_000, "post_a"),
      candidate("snap_3", 120_000, "post_a"),
      candidate("snap_4", 90_000, "post_b"),
    ];

    const selected = selectComparableSnapshots(candidates, "day_1");

    expect(selected.size).toBe(2);
    expect(selected.get("post_a")?.snapshotId).toBe("snap_2");
    expect(selected.get("post_b")?.snapshotId).toBe("snap_4");
  });

  it("chooses the snapshot closest to the window target", () => {
    const candidates = [
      candidate("snap_early", 65_000),
      candidate("snap_close", 86_000),
      candidate("snap_late", 129_000),
    ];

    expect(selectComparableSnapshot(candidates, "day_1")?.snapshotId).toBe("snap_close");
  });

  it("prefers the less mature observation when two are equidistant", () => {
    // The conservative direction: never credit a post with time it had not yet
    // accumulated.
    const candidates = [candidate("snap_after", 90_000), candidate("snap_before", 82_800)];

    expect(selectComparableSnapshot(candidates, "day_1")?.snapshotId).toBe("snap_before");
  });

  it("takes the most mature observation for windows that name no moment", () => {
    const candidates = [candidate("snap_a", 4_000_000), candidate("snap_b", 9_000_000)];

    expect(selectComparableSnapshot(candidates, "mature")?.snapshotId).toBe("snap_b");
    expect(
      selectComparableSnapshot([candidate("snap_c", 10), candidate("snap_d", 1_700)], "import")
        ?.snapshotId,
    ).toBe("snap_d");
  });

  it("is insensitive to row order", () => {
    const candidates = [
      candidate("snap_1", 86_400, "post_a"),
      candidate("snap_2", 86_400, "post_a", 2_000),
      candidate("snap_3", 70_000, "post_b"),
    ];
    const reversed = [...candidates].reverse();

    expect(
      [...selectComparableSnapshots(candidates, "day_1")].map(([, s]) => s.snapshotId),
    ).toEqual([...selectComparableSnapshots(reversed, "day_1")].map(([, s]) => s.snapshotId));
  });

  it("breaks an exact tie by capture time then snapshot id", () => {
    const later = candidate("snap_a", 86_400, "post_a", 5_000);
    const earlier = candidate("snap_b", 86_400, "post_a", 1_000);

    expect(selectComparableSnapshot([later, earlier], "day_1")?.snapshotId).toBe("snap_b");
    expect(
      selectComparableSnapshot([candidate("snap_z", 86_400), candidate("snap_a", 86_400)], "day_1")
        ?.snapshotId,
    ).toBe("snap_a");
  });

  it("ignores a non-finite age rather than ordering against NaN", () => {
    expect(selectComparableSnapshot([candidate("snap_1", Number.NaN)], "mature")).toBeNull();
  });

  it("omits posts with nothing in tolerance instead of returning a null value", () => {
    const selected = selectComparableSnapshots(
      [candidate("snap_1", 86_400, "post_a"), candidate("snap_2", 10, "post_b")],
      "day_1",
    );

    expect([...selected.keys()]).toEqual(["post_a"]);
  });
});

describe("medians and spread", () => {
  it("takes the midpoint of an even sample", () => {
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });

  it("takes the middle of an odd sample", () => {
    expect(median([5, 1, 3])).toBe(3);
  });

  it("handles ties without collapsing the sample", () => {
    expect(median([2, 2, 2, 2])).toBe(2);
    expect(summariseSpread([2, 2, 2, 2]).interquartileRange).toBe(0);
  });

  it("returns null rather than zero for an empty sample", () => {
    expect(median([])).toBeNull();
    expect(summariseSpread([])).toMatchObject({ count: 0, interquartileRange: null, median: null });
  });

  it("interpolates quartiles so a small sample does not jump", () => {
    const spread = summariseSpread([1, 2, 3, 4, 5]);

    expect(spread).toMatchObject({
      count: 5,
      firstQuartile: 2,
      interquartileRange: 2,
      maximum: 5,
      median: 3,
      minimum: 1,
      thirdQuartile: 4,
    });
  });

  it("reports a single observation without an implied range", () => {
    expect(summariseSpread([7])).toMatchObject({
      count: 1,
      firstQuartile: 7,
      interquartileRange: 0,
      median: 7,
    });
  });

  it("drops non-finite values instead of poisoning the sort", () => {
    expect(median([1, Number.NaN, 3])).toBe(2);
  });
});

describe("baseline comparison", () => {
  it("produces index, difference and percent difference against the median", () => {
    expect(compareToBaseline(12, [8, 10, 12])).toMatchObject({
      availability: "available",
      baseline: 10,
      comparisonCount: 3,
      differenceFromBaseline: 2,
      percentDifference: 20,
      reason: null,
      relativeIndex: 1.2,
    });
  });

  it("refuses a relative index against a zero baseline", () => {
    // Dividing would render an infinity as a real multiple.
    expect(compareToBaseline(5, [0, 0, 0])).toMatchObject({
      availability: "unavailable",
      baseline: 0,
      differenceFromBaseline: 5,
      percentDifference: null,
      reason: "baseline_not_positive",
      relativeIndex: null,
    });
  });

  it("distinguishes an empty cohort from an absent focal value", () => {
    expect(compareToBaseline(5, [])).toMatchObject({
      reason: "no_comparison_values",
      availability: "unavailable",
    });
    expect(compareToBaseline(null, [1, 2, 3])).toMatchObject({
      reason: "focal_value_unavailable",
      availability: "unavailable",
      baseline: 2,
    });
  });

  it("counts only finite comparison values", () => {
    expect(compareToBaseline(4, [2, Number.NaN, 6]).comparisonCount).toBe(2);
  });

  it("reports a below-baseline post as a fraction rather than a negative index", () => {
    expect(compareToBaseline(5, [10, 10, 10])).toMatchObject({
      differenceFromBaseline: -5,
      percentDifference: -50,
      relativeIndex: 0.5,
    });
  });
});

describe("focal exclusion and coverage", () => {
  it("removes the focal post from its own comparison", () => {
    const entries = [{ postId: "post_a" }, { postId: "post_b" }, { postId: "post_a" }];

    expect(excludeFocalPost(entries, "post_a")).toEqual([{ postId: "post_b" }]);
  });

  it("counts missing snapshots and missing metrics apart", () => {
    // They call for different work: one needs a capture at the right age, the
    // other was captured and the provider returned nothing.
    expect(
      summariseCoverage({
        eligiblePosts: 10,
        postsMissingMetric: 2,
        postsMissingSnapshot: 3,
        postsWithValue: 5,
      }),
    ).toEqual({
      eligiblePosts: 10,
      missingRatio: 0.5,
      postsMissingMetric: 2,
      postsMissingSnapshot: 3,
      postsWithValue: 5,
    });
  });

  it("reports no missingness for an empty cohort rather than dividing by zero", () => {
    expect(
      summariseCoverage({
        eligiblePosts: 0,
        postsMissingMetric: 0,
        postsMissingSnapshot: 0,
        postsWithValue: 0,
      }).missingRatio,
    ).toBe(0);
  });

  it("pins the recent-cohort bounds the contract names", () => {
    expect(recentCohortPostLimit).toBe(20);
    expect(recentCohortDays).toBe(90);
  });
});

describe("cohort fingerprint", () => {
  const definition = {
    ageWindow: "day_30" as const,
    categoryValue: null,
    instagramAccountId: "account_1",
    kind: "account" as const,
    metric: "engagement_rate_reach" as const,
    publishedFrom: "2026-01-01T00:00:00.000Z",
    publishedTo: "2026-06-30T00:00:00.000Z",
  };

  it("is insensitive to snapshot order", () => {
    expect(createCohortFingerprint({ definition, snapshotIds: ["b", "a", "c"] })).toBe(
      createCohortFingerprint({ definition, snapshotIds: ["c", "b", "a"] }),
    );
  });

  it("changes when the contributing snapshots change", () => {
    expect(createCohortFingerprint({ definition, snapshotIds: ["a", "b"] })).not.toBe(
      createCohortFingerprint({ definition, snapshotIds: ["a", "b", "c"] }),
    );
  });

  it("changes when any part of the definition changes", () => {
    const base = createCohortFingerprint({ definition, snapshotIds: ["a"] });

    for (const change of [
      { ageWindow: "day_7" as const },
      { categoryValue: "REEL" },
      { instagramAccountId: "account_2" },
      { kind: "recent" as const },
      { metric: "like_rate_reach" as const },
      { publishedFrom: "2026-02-01T00:00:00.000Z" },
      { publishedTo: "2026-07-31T00:00:00.000Z" },
    ]) {
      expect(
        createCohortFingerprint({
          definition: { ...definition, ...change },
          snapshotIds: ["a"],
        }),
      ).not.toBe(base);
    }
  });

  it("pins the selection version so a rule change invalidates stored fingerprints", () => {
    expect(cohortSelectionVersion).toBe("account-cohort-v1.0.0");
    expect(createCohortFingerprint({ definition, snapshotIds: [] })).toMatch(/^[0-9a-f]{64}$/);
  });
});
