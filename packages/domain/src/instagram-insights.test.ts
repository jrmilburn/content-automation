import { describe, expect, it } from "vitest";

import { instagramApiVersion } from "./instagram-oauth.js";
import {
  instagramCanonicalMetrics,
  instagramFailedGroupObservations,
  instagramGroupFailureAvailability,
  instagramInsightGroups,
  instagramMetricAvailabilityStates,
  instagramRequestedMetrics,
  instagramSnapshotBucketFor,
  instagramUnrequestedObservations,
  normaliseInstagramInsightItem,
  readInstagramInsightGroup,
  type InstagramInsightGroup,
} from "./instagram-insights.js";

const reelGroups = instagramInsightGroups({
  apiVersion: instagramApiVersion,
  mediaKind: "REEL",
});

function groupFor(key: string): InstagramInsightGroup {
  const group = reelGroups.find((entry) => entry.key === key);
  if (!group) throw new Error(`missing group ${key}`);
  return group;
}

describe("capability map", () => {
  it("requests exactly the ten metrics the live v25.0 proof showed Reels return", () => {
    expect(
      [...instagramRequestedMetrics({ apiVersion: instagramApiVersion, mediaKind: "REEL" })].sort(),
    ).toEqual(
      [
        "average_watch_time_ms",
        "comments",
        "likes",
        "reach",
        "saves",
        "shares",
        "skip_rate",
        "total_interactions",
        "total_watch_time_ms",
        "views",
      ].sort(),
    );
  });

  it.each(["plays", "follows", "profile_visits", "profile_activity"] as const)(
    "never requests %s, which v25.0 rejects with error code 100",
    (canonical) => {
      // The data model lists these as columns; the live proof showed Reels
      // reject them. Requesting one would discard its whole group.
      expect(
        instagramRequestedMetrics({ apiVersion: instagramApiVersion, mediaKind: "REEL" }),
      ).not.toContain(canonical);
    },
  );

  it.each(["IMAGE", "VIDEO", "CAROUSEL_ALBUM", "UNSUPPORTED"] as const)(
    "requests nothing for %s, where no proof exists yet",
    (mediaKind) => {
      expect(instagramInsightGroups({ apiVersion: instagramApiVersion, mediaKind })).toEqual([]);
    },
  );

  it("requests nothing for an API version the map does not cover", () => {
    expect(instagramInsightGroups({ apiVersion: "v24.0", mediaKind: "REEL" })).toEqual([]);
  });

  it("keeps groups small so one rejected metric cannot discard the rest", () => {
    expect(reelGroups.length).toBeGreaterThan(1);
    for (const group of reelGroups) expect(group.metrics.length).toBeLessThanOrEqual(5);
  });

  it("isolates the newest field in its own group", () => {
    // skip_rate is the most likely to be withdrawn; watch time must survive it.
    expect(groupFor("retention").metrics.map((entry) => entry.canonical)).toEqual(["skip_rate"]);
  });

  it("maps the provider name saved onto the canonical name saves", () => {
    const saves = groupFor("engagement").metrics.find((entry) => entry.canonical === "saves");
    expect(saves?.provider).toBe("saved");
  });

  it("declares watch time in milliseconds and skip rate as a ratio", () => {
    expect(groupFor("watch_time").metrics.every((entry) => entry.unit === "milliseconds")).toBe(
      true,
    );
    expect(groupFor("retention").metrics[0]?.unit).toBe("ratio");
  });

  it("keeps views and plays as separate canonical metrics", () => {
    // Merging them would silently change the denominator of every rate.
    expect(instagramCanonicalMetrics).toContain("views");
    expect(instagramCanonicalMetrics).toContain("plays");
  });
});

describe("normaliseInstagramInsightItem", () => {
  const distribution = groupFor("distribution").metrics;

  it("reads a total_value and records the provider's own name, unit and period", () => {
    const result = normaliseInstagramInsightItem(
      {
        description: "Times the reel was played",
        name: "views",
        period: "lifetime",
        title: "Views",
        total_value: { value: 1234 },
      },
      distribution,
    );

    expect(result).toMatchObject({
      ok: true,
      observation: {
        availability: "available",
        canonical: "views",
        description: "Times the reel was played",
        period: "lifetime",
        providerName: "views",
        title: "Views",
        unit: "count",
        value: 1234,
      },
    });
  });

  it("falls back to the values array when total_value is absent", () => {
    const result = normaliseInstagramInsightItem(
      { name: "reach", values: [{ value: 99 }] },
      distribution,
    );
    expect(result).toMatchObject({ ok: true, observation: { value: 99 } });
  });

  it("records a genuine zero as an available zero, not as unavailable", () => {
    const result = normaliseInstagramInsightItem(
      { name: "views", total_value: { value: 0 } },
      distribution,
    );
    expect(result).toMatchObject({
      ok: true,
      observation: { availability: "available", value: 0 },
    });
  });

  it("records an empty data item as unavailable with a null value, never zero", () => {
    const result = normaliseInstagramInsightItem({ name: "views", values: [] }, distribution);
    expect(result).toMatchObject({
      ok: true,
      observation: { availability: "unavailable", value: null },
    });
  });

  it.each([
    ["a negative count", { name: "views", total_value: { value: -1 } }, "VALUE_NEGATIVE"],
    [
      "a non-finite value",
      { name: "views", total_value: { value: Number.POSITIVE_INFINITY } },
      "VALUE_NOT_FINITE",
    ],
  ] as const)("quarantines %s rather than storing it", (_label, item, reason) => {
    expect(normaliseInstagramInsightItem(item, distribution)).toMatchObject({ ok: false, reason });
  });

  it("quarantines a ratio above one as an impossible unit", () => {
    expect(
      normaliseInstagramInsightItem(
        { name: "reels_skip_rate", total_value: { value: 1.5 } },
        groupFor("retention").metrics,
      ),
    ).toMatchObject({ ok: false, reason: "VALUE_OUT_OF_RANGE" });
  });

  it("accepts a ratio at exactly one", () => {
    expect(
      normaliseInstagramInsightItem(
        { name: "reels_skip_rate", total_value: { value: 1 } },
        groupFor("retention").metrics,
      ),
    ).toMatchObject({ ok: true, observation: { value: 1 } });
  });

  it("rejects an unknown metric name rather than guessing which column it is", () => {
    expect(
      normaliseInstagramInsightItem(
        { name: "impressions", total_value: { value: 5 } },
        distribution,
      ),
    ).toMatchObject({ ok: false, reason: "METRIC_UNKNOWN" });
  });

  it.each([null, "views", 42, []])("rejects the non-object item %p", (item) => {
    expect(normaliseInstagramInsightItem(item, distribution)).toMatchObject({
      ok: false,
      reason: "ITEM_NOT_OBJECT",
    });
  });
});

describe("readInstagramInsightGroup", () => {
  it("accounts for every requested metric even when the response omits one", () => {
    const group = groupFor("distribution");
    const result = readInstagramInsightGroup(
      { data: [{ name: "views", total_value: { value: 10 } }] },
      group,
    );

    expect(result.observations.map((entry) => entry.canonical)).toEqual(["views", "reach"]);
    // A requested metric the provider did not return is unavailable, not absent.
    expect(result.observations[1]).toMatchObject({
      availability: "unavailable",
      canonical: "reach",
      value: null,
    });
  });

  it("treats an entirely empty data set as every metric unavailable", () => {
    const result = readInstagramInsightGroup({ data: [] }, groupFor("distribution"));
    expect(result.observations.every((entry) => entry.availability === "unavailable")).toBe(true);
    expect(result.observations.every((entry) => entry.value === null)).toBe(true);
  });

  it("keeps good metrics from a response that also contains a bad one", () => {
    const result = readInstagramInsightGroup(
      {
        data: [
          { name: "views", total_value: { value: 10 } },
          { name: "reach", total_value: { value: -5 } },
        ],
      },
      groupFor("distribution"),
    );

    expect(result.observations[0]).toMatchObject({ availability: "available", value: 10 });
    expect(result.observations[1]).toMatchObject({ availability: "unavailable" });
    expect(result.rejections).toEqual(["VALUE_NEGATIVE"]);
  });

  it.each([null, undefined, "not json", { data: "nope" }])(
    "treats the malformed body %p as unavailable rather than throwing",
    (body) => {
      const result = readInstagramInsightGroup(body, groupFor("distribution"));
      expect(result.observations.every((entry) => entry.availability === "unavailable")).toBe(true);
    },
  );
});

describe("group failure availability", () => {
  it.each([
    ["authorisation", "permission_missing"],
    ["unsupported", "not_applicable"],
    ["rate_limit", "provider_error"],
    ["transient", "provider_error"],
    ["invalid_request", "provider_error"],
  ] as const)("maps a %s failure to %s", (responseClass, expected) => {
    expect(instagramGroupFailureAvailability(responseClass)).toBe(expected);
  });

  it("marks every metric in a failed group without inventing values", () => {
    const observations = instagramFailedGroupObservations(
      groupFor("engagement"),
      "permission_missing",
    );

    expect(observations).toHaveLength(5);
    expect(observations.every((entry) => entry.availability === "permission_missing")).toBe(true);
    expect(observations.every((entry) => entry.value === null)).toBe(true);
  });
});

describe("unrequested observations", () => {
  it("accounts for every canonical metric the map did not ask for", () => {
    const requested = instagramRequestedMetrics({
      apiVersion: instagramApiVersion,
      mediaKind: "REEL",
    });
    const unrequested = instagramUnrequestedObservations(requested);

    expect(unrequested.map((entry) => entry.canonical).sort()).toEqual(
      ["follows", "plays", "profile_activity", "profile_visits"].sort(),
    );
    expect(unrequested.every((entry) => entry.availability === "not_requested")).toBe(true);
  });

  it("covers the whole canonical set once combined with the requested metrics", () => {
    const requested = instagramRequestedMetrics({
      apiVersion: instagramApiVersion,
      mediaKind: "REEL",
    });
    const total = requested.length + instagramUnrequestedObservations(requested).length;
    expect(total).toBe(instagramCanonicalMetrics.length);
  });

  it("can report not_applicable for a media kind the map cannot serve", () => {
    const unrequested = instagramUnrequestedObservations([], "not_applicable");
    expect(unrequested).toHaveLength(instagramCanonicalMetrics.length);
    expect(unrequested.every((entry) => entry.availability === "not_applicable")).toBe(true);
  });

  it("keeps every availability state distinct", () => {
    expect(new Set(instagramMetricAvailabilityStates).size).toBe(
      instagramMetricAvailabilityStates.length,
    );
  });
});

describe("instagramSnapshotBucketFor", () => {
  it.each([
    [0, "import"],
    [1_800, "import"],
    [3_600, "hour_1"],
    [86_400, "day_1"],
    [259_200, "day_3"],
    [604_800, "day_7"],
    [2_592_000, "day_30"],
    [31_536_000, "mature"],
  ] as const)("puts an age of %i seconds in the %s bucket", (age, expected) => {
    expect(instagramSnapshotBucketFor(age)).toBe(expected);
  });

  it.each([-1, Number.NaN])("treats the unknown age %p as the import bucket", (age) => {
    // The analytics contract names this bucket "import/unknown"; clock skew on a
    // just-published post is the realistic source of a negative age.
    expect(instagramSnapshotBucketFor(age)).toBe("import");
  });

  it("sends an implausibly large age to mature rather than contaminating import", () => {
    expect(instagramSnapshotBucketFor(Number.POSITIVE_INFINITY)).toBe("mature");
  });
});
