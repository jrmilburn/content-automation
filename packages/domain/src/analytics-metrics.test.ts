import { describe, expect, it } from "vitest";

import {
  analyticsVersion,
  calculateDerivedMetric,
  calculateDerivedMetrics,
  createMetricInputs,
  derivedMetricDefinitions,
  derivedMetrics,
  metricInputKeys,
  resolveMetricDuration,
  type DerivedMetric,
  type MetricInputKey,
  type MetricInputSet,
  type MetricInputState,
} from "./analytics-metrics.js";
import { instagramCanonicalMetrics } from "./instagram-insights.js";
import type { InstagramMetricObservation } from "./instagram-insights.js";

const snapshotId = "0f9d3a2e-1b6c-4d4a-9f11-2c7e5a8b3d40";

function observation(
  canonical: InstagramMetricObservation["canonical"],
  availability: InstagramMetricObservation["availability"],
  value: number | null = null,
  overrides: Partial<InstagramMetricObservation> = {},
): InstagramMetricObservation {
  return {
    availability,
    canonical,
    description: null,
    period: "lifetime",
    providerName: canonical,
    providerUnit: "count",
    title: null,
    unit: "count",
    value,
    ...overrides,
  };
}

function watch(value: number | null, availability: "available" | "unavailable" = "available") {
  return observation("average_watch_time_ms", availability, value, {
    providerUnit: "milliseconds",
    unit: "milliseconds",
  });
}

/**
 * The reviewed reference snapshot. Every expected value in the formula table
 * below is derived from these numbers by hand, not from the implementation.
 */
const reference = Object.freeze({
  averageWatchTimeMs: 12_000,
  comments: 30,
  durationSeconds: 20,
  follows: 12,
  likes: 250,
  profileVisits: 48,
  reach: 4_000,
  saves: 90,
  shares: 60,
});

function referenceObservations(): InstagramMetricObservation[] {
  return [
    observation("reach", "available", reference.reach),
    observation("likes", "available", reference.likes),
    observation("comments", "available", reference.comments),
    observation("shares", "available", reference.shares),
    observation("saves", "available", reference.saves),
    observation("follows", "available", reference.follows),
    observation("profile_visits", "available", reference.profileVisits),
    watch(reference.averageWatchTimeMs),
    // Present but never readable by a formula.
    observation("views", "available", 9_000),
    observation("plays", "available", 8_000),
  ];
}

function inputsFrom(
  observations: readonly InstagramMetricObservation[],
  durationSeconds: number | null = reference.durationSeconds,
): MetricInputSet {
  return createMetricInputs({
    duration: resolveMetricDuration({ validatedSourceSeconds: durationSeconds }),
    observations,
    snapshotId,
  });
}

const referenceInputs = () => inputsFrom(referenceObservations());

/**
 * Assembles an input set directly, bypassing `createMetricInputs`.
 *
 * Downstream analytics build these by hand, so the guards that only fire on a
 * hand-built set still have to hold.
 */
function handBuilt(
  overrides: Readonly<Partial<Record<MetricInputKey, MetricInputState>>>,
): MetricInputSet {
  const base = referenceInputs();
  return { ...base, values: { ...base.values, ...overrides } };
}

function valueOf(metric: DerivedMetric, inputs: MetricInputSet = referenceInputs()) {
  return calculateDerivedMetric(metric, inputs).value;
}

describe("formula dictionary", () => {
  it("defines exactly the eleven metrics the analytics contract tabulates", () => {
    expect([...derivedMetrics].sort()).toEqual(
      [
        "average_watch_percentage",
        "comment_rate_reach",
        "completion_proxy",
        "engagement_count",
        "engagement_rate_reach",
        "follow_conversion_rate",
        "follow_rate_reach",
        "like_rate_reach",
        "profile_visit_rate_reach",
        "save_rate_reach",
        "share_rate_reach",
      ].sort(),
    );
  });

  it.each(derivedMetrics)("names the denominator %s divided by", (metric) => {
    const definition = derivedMetricDefinitions[metric];
    // A count has no denominator; every rate must name one, because the contract
    // forbids a denominator that is implicit in the metric name alone.
    if (definition.unit === "count") expect(definition.denominator.kind).toBe("none");
    else expect(definition.denominator.kind).not.toBe("none");
  });

  it.each(derivedMetrics)("%s reports its denominator on the result", (metric) => {
    const result = calculateDerivedMetric(metric, referenceInputs());
    const expected = derivedMetricDefinitions[metric].denominator;
    expect(result.denominator).toBe(expected.kind === "none" ? null : expected.label);
  });

  it("never admits views or plays into the input vocabulary", () => {
    // The contract forbids combining them, and Meta defines each differently per
    // surface. Excluding both from the vocabulary makes the rule structural.
    expect(metricInputKeys).not.toContain("views");
    expect(metricInputKeys).not.toContain("plays");
    for (const metric of derivedMetrics) {
      const definition = derivedMetricDefinitions[metric];
      expect(definition.formula).not.toMatch(/\bviews\b/);
      expect(definition.formula).not.toMatch(/\bplays\b/);
    }
  });

  it("never derives average watch time from total watch time", () => {
    // Meta's user-facing average uses initial views, which need not equal the
    // API's views or plays, so the contract prohibits this derivation outright.
    for (const metric of derivedMetrics) {
      expect(derivedMetricDefinitions[metric].formula).not.toContain("total_watch_time");
    }
    expect(metricInputKeys).not.toContain("total_watch_time_ms");
  });

  it("only reads canonical Instagram metric names", () => {
    for (const key of metricInputKeys) expect(instagramCanonicalMetrics).toContain(key);
  });

  it("bounds the completion proxy and nothing else", () => {
    const bounded = derivedMetrics.filter((metric) => derivedMetricDefinitions[metric].bounded);
    expect(bounded).toEqual(["completion_proxy"]);
  });
});

describe("fixed-dataset formulas", () => {
  // Expected values computed by hand from docs/technical/analytics-and-metrics.md
  // against the reference snapshot above.
  const cases: readonly (readonly [DerivedMetric, number, string])[] = [
    ["engagement_count", 430, "250 + 30 + 60 + 90"],
    ["engagement_rate_reach", 0.1075, "430 / 4000"],
    ["like_rate_reach", 0.0625, "250 / 4000"],
    ["comment_rate_reach", 0.0075, "30 / 4000"],
    ["share_rate_reach", 0.015, "60 / 4000"],
    ["save_rate_reach", 0.0225, "90 / 4000"],
    ["profile_visit_rate_reach", 0.012, "48 / 4000"],
    ["follow_conversion_rate", 0.25, "12 / 48"],
    ["follow_rate_reach", 0.003, "12 / 4000"],
    ["average_watch_percentage", 0.6, "(12000 / 1000) / 20"],
    ["completion_proxy", 0.6, "min(1, 12000 / (20 * 1000))"],
  ];

  it.each(cases)("%s equals %d by %s", (metric, expected) => {
    expect(valueOf(metric)).toBeCloseTo(expected, 10);
  });

  it.each(cases)("%s is available and carries provenance", (metric) => {
    const result = calculateDerivedMetric(metric, referenceInputs());
    expect(result.availability).toBe("available");
    expect(result.reason).toBeNull();
    expect(result.missing).toEqual([]);
    expect(result.analyticsVersion).toBe(analyticsVersion);
    expect(result.snapshotId).toBe(snapshotId);
    expect(result.formula).toBe(derivedMetricDefinitions[metric].formula);
  });

  it("returns exactly one when a numerator equals its denominator", () => {
    const inputs = inputsFrom(
      referenceObservations().map((entry) =>
        entry.canonical === "likes" ? observation("likes", "available", reference.reach) : entry,
      ),
    );
    expect(valueOf("like_rate_reach", inputs)).toBe(1);
  });

  it("calculates every metric for one snapshot in dictionary order", () => {
    const results = calculateDerivedMetrics(referenceInputs());
    expect(results.map((entry) => entry.metric)).toEqual([...derivedMetrics]);
  });
});

describe("unavailable is never zero", () => {
  const rateMetrics = derivedMetrics.filter(
    (metric) => derivedMetricDefinitions[metric].denominator.kind !== "none",
  );

  it.each(rateMetrics)("%s is unavailable when its denominator is zero", (metric) => {
    const { denominator } = derivedMetricDefinitions[metric];
    const inputs =
      denominator.kind === "metric"
        ? inputsFrom(
            referenceObservations().map((entry) =>
              entry.canonical === denominator.key
                ? observation(entry.canonical, "available", 0)
                : entry,
            ),
          )
        : inputsFrom(referenceObservations(), 0);

    const result = calculateDerivedMetric(metric, inputs);
    expect(result.availability).toBe("unavailable");
    expect(result.value).toBeNull();
    expect(result.reason).toBe(
      denominator.kind === "metric" ? "denominator_not_positive" : "duration_not_positive",
    );
  });

  it.each(rateMetrics)("%s is unavailable when its denominator is missing", (metric) => {
    const { denominator } = derivedMetricDefinitions[metric];
    const inputs =
      denominator.kind === "metric"
        ? inputsFrom(referenceObservations().filter((entry) => entry.canonical !== denominator.key))
        : inputsFrom(referenceObservations(), null);

    const result = calculateDerivedMetric(metric, inputs);
    expect(result.availability).toBe("unavailable");
    expect(result.value).toBeNull();
    expect(result.reason).toBe(
      denominator.kind === "metric" ? "denominator_unavailable" : "duration_unavailable",
    );
  });

  it.each(derivedMetrics)("%s never yields a non-finite value", (metric) => {
    for (const seconds of [0, null]) {
      for (const reachValue of [0, null]) {
        const observations = referenceObservations()
          .filter((entry) => !(reachValue === null && entry.canonical === "reach"))
          .map((entry) =>
            entry.canonical === "reach" && reachValue !== null
              ? observation("reach", "available", reachValue)
              : entry,
          );
        const result = calculateDerivedMetric(metric, inputsFrom(observations, seconds));
        if (result.value !== null) expect(Number.isFinite(result.value)).toBe(true);
      }
    }
  });

  it("distinguishes a measured zero from an unavailable metric", () => {
    const zeroed = referenceObservations().map((entry) =>
      entry.canonical === "likes" ? observation("likes", "available", 0) : entry,
    );
    const measured = calculateDerivedMetric("like_rate_reach", inputsFrom(zeroed));
    expect(measured.availability).toBe("available");
    expect(measured.value).toBe(0);
    // Object.is separates 0 from -0, which compares equal but serialises apart.
    expect(Object.is(measured.value, 0)).toBe(true);

    const absent = calculateDerivedMetric(
      "like_rate_reach",
      inputsFrom(referenceObservations().filter((entry) => entry.canonical !== "likes")),
    );
    expect(absent.availability).toBe("unavailable");
    expect(absent.value).toBeNull();
  });
});

describe("engagement requires every component", () => {
  it.each(["likes", "comments", "shares", "saves"] as const)(
    "engagement_count is unavailable when %s is missing",
    (component) => {
      const inputs = inputsFrom(
        referenceObservations().filter((entry) => entry.canonical !== component),
      );
      const result = calculateDerivedMetric("engagement_count", inputs);

      expect(result.availability).toBe("unavailable");
      expect(result.value).toBeNull();
      expect(result.missing).toEqual([component]);
      // A partial sum must never be labelled engagement.
      expect(result.value).not.toBe(reference.likes + reference.comments + reference.shares);
    },
  );

  it.each(["likes", "comments", "shares", "saves"] as const)(
    "engagement_rate_reach is unavailable when %s is unavailable",
    (component) => {
      const inputs = inputsFrom(
        referenceObservations().map((entry) =>
          entry.canonical === component ? observation(component, "unavailable") : entry,
        ),
      );
      const result = calculateDerivedMetric("engagement_rate_reach", inputs);
      expect(result.availability).toBe("unavailable");
      expect(result.reason).toBe("component_unavailable");
      expect(result.missing).toEqual([component]);
    },
  );

  it("reports every missing component, not only the first", () => {
    const inputs = inputsFrom(
      referenceObservations().filter(
        (entry) => entry.canonical !== "shares" && entry.canonical !== "saves",
      ),
    );
    expect(calculateDerivedMetric("engagement_count", inputs).missing).toEqual(["shares", "saves"]);
  });
});

describe("incompatible definitions never combine", () => {
  it("refuses a numerator whose unit is not the one the formula expects", () => {
    const inputs = inputsFrom(
      referenceObservations().map((entry) =>
        entry.canonical === "likes"
          ? observation("likes", "available", reference.likes, { unit: "ratio" })
          : entry,
      ),
    );
    const result = calculateDerivedMetric("like_rate_reach", inputs);
    expect(result.availability).toBe("unavailable");
    expect(result.reason).toBe("incompatible_unit");
  });

  it("refuses a reach denominator reported in a non-count unit", () => {
    const inputs = inputsFrom(
      referenceObservations().map((entry) =>
        entry.canonical === "reach"
          ? observation("reach", "available", reference.reach, { unit: "milliseconds" })
          : entry,
      ),
    );
    const result = calculateDerivedMetric("like_rate_reach", inputs);
    expect(result.availability).toBe("unavailable");
    expect(result.reason).toBe("incompatible_unit");
  });

  it("requires watch time in milliseconds", () => {
    const inputs = inputsFrom(
      referenceObservations().map((entry) =>
        entry.canonical === "average_watch_time_ms"
          ? observation("average_watch_time_ms", "available", 12_000, { unit: "count" })
          : entry,
      ),
    );
    expect(calculateDerivedMetric("average_watch_percentage", inputs).reason).toBe(
      "incompatible_unit",
    );
  });

  it("quarantines an impossible negative rather than dividing by it", () => {
    const inputs = inputsFrom(
      referenceObservations().map((entry) =>
        entry.canonical === "reach" ? observation("reach", "available", -1) : entry,
      ),
    );
    const result = calculateDerivedMetric("like_rate_reach", inputs);
    expect(result.availability).toBe("unavailable");
    expect(result.reason).toBe("value_rejected");
  });

  it.each([
    [10.5, "value_rejected"],
    [Number.MAX_SAFE_INTEGER + 2, "not_representable"],
  ] as const)("refuses a count of %s, which cannot be an exact measurement", (value, reason) => {
    // A fractional count means a unit was converted upstream; an unsafe integer
    // means precision is already gone. Neither may enter arithmetic.
    const inputs = inputsFrom(
      referenceObservations().map((entry) =>
        entry.canonical === "likes" ? observation("likes", "available", value) : entry,
      ),
    );
    const result = calculateDerivedMetric("like_rate_reach", inputs);
    expect(result.availability).toBe("unavailable");
    expect(result.reason).toBe(reason);
  });

  it("refuses a numerator that did not come from insights", () => {
    // Reachable only by assembling a MetricInputSet directly, which is exactly
    // what the analytics consumers of this module will do.
    const inputs = handBuilt({
      likes: { available: true, source: "metadata", unit: "count", value: reference.likes },
    });
    const result = calculateDerivedMetric("like_rate_reach", inputs);
    expect(result.availability).toBe("unavailable");
    expect(result.reason).toBe("incompatible_source");
  });

  it("refuses a denominator that did not come from insights", () => {
    const inputs = handBuilt({
      reach: { available: true, source: "metadata", unit: "count", value: reference.reach },
    });
    const result = calculateDerivedMetric("like_rate_reach", inputs);
    expect(result.availability).toBe("unavailable");
    expect(result.reason).toBe("incompatible_source");
  });

  it("refuses a numerator sum that exceeds exact integer range", () => {
    const huge = Number.MAX_SAFE_INTEGER;
    const inputs = inputsFrom([
      observation("reach", "available", 10),
      observation("likes", "available", huge),
      observation("comments", "available", huge),
      observation("shares", "available", 1),
      observation("saves", "available", 1),
    ]);
    const result = calculateDerivedMetric("engagement_count", inputs);
    expect(result.availability).toBe("unavailable");
    expect(result.reason).toBe("not_representable");
  });
});

describe("watch metrics", () => {
  it("preserves an average watch above 100 per cent unclamped", () => {
    // 41s mean watch on a 30s video: replays and provider counting make this real.
    const inputs = inputsFrom(
      [
        ...referenceObservations().filter((e) => e.canonical !== "average_watch_time_ms"),
        watch(41_000),
      ],
      30,
    );
    const unbounded = calculateDerivedMetric("average_watch_percentage", inputs);
    expect(unbounded.value).toBeCloseTo(41 / 30, 10);
    expect(unbounded.value).toBeGreaterThan(1);
    expect(derivedMetricDefinitions.average_watch_percentage.bounded).toBe(false);
  });

  it("bounds the completion proxy at one for the same input", () => {
    const inputs = inputsFrom(
      [
        ...referenceObservations().filter((e) => e.canonical !== "average_watch_time_ms"),
        watch(41_000),
      ],
      30,
    );
    const proxy = calculateDerivedMetric("completion_proxy", inputs);
    expect(proxy.value).toBe(1);
    expect(proxy.limitations.join(" ")).toContain("not a measured completion rate");
  });

  it("keeps the proxy exactly equal to min(1, average watch percentage)", () => {
    // Both divide milliseconds by milliseconds through one scaling, so the pair
    // can never disagree in the last bits and straddle the bound.
    for (const ms of [1, 999, 12_000, 19_999, 20_000, 20_001, 41_000]) {
      const inputs = inputsFrom(
        [
          ...referenceObservations().filter((e) => e.canonical !== "average_watch_time_ms"),
          watch(ms),
        ],
        20,
      );
      const unbounded = calculateDerivedMetric("average_watch_percentage", inputs).value;
      const proxy = calculateDerivedMetric("completion_proxy", inputs).value;
      expect(proxy).toBe(Math.min(1, unbounded!));
    }
  });

  it("records which duration a watch metric used", () => {
    const result = calculateDerivedMetric("average_watch_percentage", referenceInputs());
    expect(result.durationSource).toBe("validated_source_video");
  });

  it("leaves duration provenance null for metrics that do not use it", () => {
    expect(calculateDerivedMetric("like_rate_reach", referenceInputs()).durationSource).toBeNull();
  });
});

describe("duration resolution", () => {
  it("prefers the validated source video when it corroborates the provider", () => {
    const resolved = resolveMetricDuration({
      providerSeconds: 30.4,
      validatedSourceSeconds: 30,
    });
    expect(resolved.source).toBe("validated_source_video");
    expect(resolved.seconds).toBe(30);
    expect(resolved.mismatch).toBe(false);
  });

  it("falls back to the provider and flags a mismatch beyond tolerance", () => {
    const resolved = resolveMetricDuration({
      providerSeconds: 30,
      validatedSourceSeconds: 45,
    });
    expect(resolved.source).toBe("provider_metadata");
    expect(resolved.seconds).toBe(30);
    expect(resolved.mismatch).toBe(true);
    expect(resolved.limitations.join(" ")).toContain("disagrees with the provider duration");
  });

  it("carries a mismatch limitation onto the derived value", () => {
    const inputs = createMetricInputs({
      duration: resolveMetricDuration({ providerSeconds: 30, validatedSourceSeconds: 45 }),
      observations: referenceObservations(),
      snapshotId,
    });
    const result = calculateDerivedMetric("average_watch_percentage", inputs);
    expect(result.availability).toBe("available");
    expect(result.limitations.join(" ")).toContain("disagrees with the provider duration");
  });

  it.each([
    [null, 30, "provider_metadata"],
    [30, null, "validated_source_video"],
  ] as const)("resolves to %s when only one source is present", (validated, provider, source) => {
    const resolved = resolveMetricDuration({
      providerSeconds: provider,
      validatedSourceSeconds: validated,
    });
    expect(resolved.source).toBe(source);
  });

  it.each([0, -5, Number.NaN, Number.POSITIVE_INFINITY])(
    "refuses %s as a duration and records it as rejected, not absent",
    (seconds) => {
      const resolved = resolveMetricDuration({ validatedSourceSeconds: seconds });
      expect(resolved.seconds).toBeNull();
      expect(resolved.source).toBeNull();
      expect(resolved.rejected).toBe(true);
      expect(resolved.limitations.join(" ")).toContain("not a usable positive duration");
    },
  );

  it("separates a supplied impossible duration from no duration at all", () => {
    // Both leave the watch metrics unavailable, but only the first is a data
    // defect someone can act on, so the reasons must not collapse.
    const rejected = resolveMetricDuration({ validatedSourceSeconds: 0 });
    const absent = resolveMetricDuration({});
    expect(rejected.rejected).toBe(true);
    expect(absent.rejected).toBe(false);
    expect(absent.limitations).toEqual([]);
  });

  it("still resolves a usable duration when the other source is impossible", () => {
    const resolved = resolveMetricDuration({ providerSeconds: 30, validatedSourceSeconds: 0 });
    expect(resolved.seconds).toBe(30);
    expect(resolved.source).toBe("provider_metadata");
    expect(resolved.rejected).toBe(false);
    expect(resolved.limitations.join(" ")).toContain("not a usable positive duration");
  });
});

/**
 * A deterministic generator, because the repository has no property-testing
 * dependency and the analytics contract requires seeded routines anyway. Sequence
 * is fixed by the seed so a failure reproduces exactly.
 */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let drawn = Math.imul(state ^ (state >>> 15), 1 | state);
    drawn = (drawn + Math.imul(drawn ^ (drawn >>> 7), 61 | drawn)) ^ drawn;
    return ((drawn ^ (drawn >>> 14)) >>> 0) / 4_294_967_296;
  };
}

describe("property: no formula can leak a bad number", () => {
  it("never returns a non-finite value and never divides by a missing or zero denominator", () => {
    const next = seededRandom(20_260_802);
    const draw = () => {
      const roll = next();
      // Deliberately over-samples zero and absence, which are the cases that
      // produce Infinity and NaN if a guard is missing.
      if (roll < 0.25) return null;
      if (roll < 0.5) return 0;
      return Math.floor(next() * 5_000);
    };

    for (let iteration = 0; iteration < 2_000; iteration += 1) {
      const drawn = new Map(metricInputKeys.map((key) => [key, draw()] as const));
      const observations = metricInputKeys.flatMap((key) => {
        const value = drawn.get(key) ?? null;
        if (value === null) return [];
        return [
          key === "average_watch_time_ms" ? watch(value) : observation(key, "available", value),
        ];
      });

      const durationRoll = next();
      const seconds = durationRoll < 0.2 ? null : durationRoll < 0.35 ? 0 : next() * 120;
      const inputs = inputsFrom(observations, seconds);

      for (const result of calculateDerivedMetrics(inputs)) {
        const definition = derivedMetricDefinitions[result.metric];

        if (result.value === null) {
          expect(result.availability).toBe("unavailable");
          expect(result.reason).not.toBeNull();
          continue;
        }

        expect(result.availability).toBe("available");
        expect(Number.isFinite(result.value)).toBe(true);
        expect(Number.isNaN(result.value)).toBe(false);
        expect(Object.is(result.value, -0)).toBe(false);
        expect(result.value).toBeGreaterThanOrEqual(0);
        if (definition.bounded) expect(result.value).toBeLessThanOrEqual(1);

        // A value exists only if the denominator was strictly positive.
        if (definition.denominator.kind === "duration") {
          expect(inputs.duration.seconds).toBeGreaterThan(0);
        } else if (definition.denominator.kind === "metric") {
          const state = inputs.values[definition.denominator.key];
          expect(state.available).toBe(true);
          if (state.available) expect(state.value).toBeGreaterThan(0);
        }
      }
    }
  });
});

describe("provenance", () => {
  it.each(derivedMetrics)(
    "%s carries the analytics version and snapshot id when absent",
    (metric) => {
      // Provenance must survive unavailability; a stored gap still needs to say
      // which formula version produced it.
      const result = calculateDerivedMetric(metric, inputsFrom([], null));
      expect(result.availability).toBe("unavailable");
      expect(result.analyticsVersion).toBe(analyticsVersion);
      expect(result.snapshotId).toBe(snapshotId);
      expect(result.formula).toBe(derivedMetricDefinitions[metric].formula);
    },
  );

  it("versions the formula logic", () => {
    expect(analyticsVersion).toBe("account-analytics-v1.0.0");
  });

  it("returns frozen results so a caller cannot mutate stored evidence", () => {
    const result = calculateDerivedMetric("like_rate_reach", referenceInputs());
    expect(Object.isFrozen(result)).toBe(true);
  });
});
