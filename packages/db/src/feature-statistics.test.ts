import { describe, expect, it } from "vitest";

import {
  calculateFeatureFamily,
  createStatisticFingerprint,
  type FeatureComparisonCandidate,
  type FeatureObservation,
  type FeatureStatisticRequest,
} from "./feature-statistics.js";

/**
 * What the pooled scope costs a comparison.
 *
 * Writing a statistic needs a database and is proved in the integration suite.
 * The reservations pooling requires are arithmetic, and they are the reason a
 * result drawn across accounts is not simply a larger version of one account's.
 */

const window = Object.freeze({
  publishedFrom: new Date("2026-01-01T00:00:00.000Z"),
  publishedTo: new Date("2026-07-31T00:00:00.000Z"),
});

/**
 * One side of a comparison, `fromFirst` of whose posts came from one account.
 *
 * Publication is spread across weeks so the supported class's distinct-week rule
 * can be met, which is what makes a demotion or a cap visible rather than the
 * sample size deciding everything.
 */
function observations(
  input: Readonly<{ count: number; fromFirst: number; side: string; value: number }>,
): readonly FeatureObservation[] {
  return Array.from({ length: input.count }, (_unused, index) =>
    Object.freeze({
      instagramAccountId: index < input.fromFirst ? "account-a" : "account-b",
      instagramPostId: `${input.side}-post-${String(index)}`,
      metricSnapshotId: `${input.side}-snapshot-${String(index)}`,
      postAnalysisId: `${input.side}-analysis-${String(index)}`,
      publishedAt: new Date(Date.UTC(2026, 0, 5 + index * 8)).toISOString(),
      value: input.value,
    }),
  );
}

/** A comparison that satisfies every supported-class requirement. */
function candidate(
  overrides: Partial<FeatureComparisonCandidate> = {},
): FeatureComparisonCandidate {
  return {
    comparison: observations({ count: 100, fromFirst: 50, side: "comparison", value: 0.1 }),
    featurePath: "content.hook.category",
    featureValue: "question",
    group: observations({ count: 100, fromFirst: 50, side: "group", value: 0.2 }),
    missingCount: 0,
    ...overrides,
  };
}

function request(overrides: Partial<FeatureStatisticRequest> = {}): FeatureStatisticRequest {
  return {
    ageWindow: "day_30",
    candidates: [candidate()],
    metric: "engagement_rate_reach",
    metricIsCount: false,
    ...window,
    ...overrides,
  };
}

function classify(input: FeatureStatisticRequest) {
  const [calculated] = calculateFeatureFamily(input);

  return calculated?.statistic;
}

describe("createStatisticFingerprint", () => {
  it("distinguishes a pooled calculation from one account's over the same posts", () => {
    // With one linked account the two draw on identical posts and classify
    // differently, so a fingerprint blind to scope would call them one answer.
    const shared = { candidate: candidate(), metric: "engagement_rate_reach" };

    expect(createStatisticFingerprint({ ...shared, request: { ageWindow: "day_30" } })).not.toBe(
      createStatisticFingerprint({
        ...shared,
        request: { ageWindow: "day_30", instagramAccountId: "account-a" },
      }),
    );
  });
});

describe("calculateFeatureFamily", () => {
  it("leaves a per-account family at the supported class it earned", () => {
    expect(classify(request({ instagramAccountId: "account-a" }))).toMatchObject({
      classification: "statistically_supported_association",
      reason: "meets_supported_thresholds",
    });
  });

  it("never lets a pooled comparison reach the supported class", () => {
    // The bootstrap resamples independently, so its interval understates the
    // variance when posts cluster by account — and that interval is what gates
    // the supported class.
    expect(classify(request())).toMatchObject({
      classification: "moderate_association",
      reason: "interval_ignores_clustering",
    });
  });

  it("demotes a pooled comparison one account supplied more than 70% of", () => {
    expect(
      classify(
        request({
          candidates: [
            candidate({
              group: observations({ count: 100, fromFirst: 71, side: "group", value: 0.2 }),
            }),
          ],
        }),
      ),
    ).toMatchObject({
      classification: "weak_directional_signal",
      reason: "one_source_dominates_sample",
    });
  });

  it("does not demote a pooled comparison at 69%", () => {
    // The threshold is a limit, not a target: just under it the comparison keeps
    // whatever class its evidence earns.
    expect(
      classify(
        request({
          candidates: [
            candidate({
              group: observations({ count: 100, fromFirst: 69, side: "group", value: 0.2 }),
            }),
          ],
        }),
      )?.classification,
    ).toBe("moderate_association");
  });

  it("applies the dominance rule to the comparison side as well as the group", () => {
    // A balanced group compared against one account's posts still measures that
    // account, from the other direction.
    expect(
      classify(
        request({
          candidates: [
            candidate({
              comparison: observations({
                count: 100,
                fromFirst: 90,
                side: "comparison",
                value: 0.1,
              }),
            }),
          ],
        }),
      )?.reason,
    ).toBe("one_source_dominates_sample");
  });

  it("leaves a per-account family alone however its accounts are counted", () => {
    // Every observation shares one source within an account, so applying the
    // dominance share there would demote every per-account result there is.
    expect(
      classify(
        request({
          candidates: [
            candidate({
              group: observations({ count: 100, fromFirst: 100, side: "group", value: 0.2 }),
            }),
          ],
          instagramAccountId: "account-a",
        }),
      )?.classification,
    ).toBe("statistically_supported_association");
  });
});
