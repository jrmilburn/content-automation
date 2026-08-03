import { createHash } from "node:crypto";

import { instagramApiVersion } from "./instagram-oauth.js";
import type { InstagramMediaKind } from "./instagram-media.js";

/**
 * Pure Instagram insight contract: the versioned capability map, canonical
 * metric names, availability states and normalisation.
 *
 * The map is deliberately narrow. A metric is requested only where a live proof
 * has shown the provider returns it for that API version and media kind, because
 * Meta rejects an unsupported name with error code 100 and that rejection
 * discards the whole request — one optimistic name would cost every metric
 * beside it.
 *
 * Nothing here performs a request or touches a database, so every branch of the
 * map can be asserted without a provider.
 */

/**
 * What is known about one canonical metric on one observation.
 *
 * `unavailable` and `not_requested` are deliberately distinct: the first means
 * the provider was asked and returned nothing, the second means the capability
 * map never asked. Collapsing them would make a gap in our own configuration
 * indistinguishable from a gap in the provider's data.
 */
export const instagramMetricAvailabilityStates = [
  "available",
  "unavailable",
  "not_applicable",
  "permission_missing",
  "provider_error",
  "not_requested",
] as const;

export type InstagramMetricAvailability = (typeof instagramMetricAvailabilityStates)[number];

/**
 * Canonical metric names. These never change when Meta renames or deprecates a
 * provider field; the provider's own name and unit are stored alongside each
 * observation so a definition change stays visible rather than silently
 * rewriting history.
 */
export const instagramCanonicalMetrics = [
  "views",
  "plays",
  "reach",
  "likes",
  "comments",
  "shares",
  "saves",
  "total_interactions",
  "total_watch_time_ms",
  "average_watch_time_ms",
  "skip_rate",
  "follows",
  "profile_visits",
  "profile_activity",
] as const;

export type InstagramCanonicalMetric = (typeof instagramCanonicalMetrics)[number];

/** Units a canonical metric can carry. Time is always stored in milliseconds. */
export const instagramMetricUnits = ["count", "milliseconds", "ratio"] as const;

export type InstagramMetricUnit = (typeof instagramMetricUnits)[number];

export type InstagramMetricDefinition = Readonly<{
  canonical: InstagramCanonicalMetric;
  /** The name sent to Meta and recorded verbatim with the observation. */
  provider: string;
  /** The unit Meta documents for this field, before normalisation. */
  providerUnit: InstagramMetricUnit;
  unit: InstagramMetricUnit;
}>;

export type InstagramInsightGroup = Readonly<{
  key: string;
  metrics: readonly InstagramMetricDefinition[];
}>;

function metric(
  canonical: InstagramCanonicalMetric,
  provider: string,
  unit: InstagramMetricUnit = "count",
  providerUnit: InstagramMetricUnit = unit,
): InstagramMetricDefinition {
  return Object.freeze({ canonical, provider, providerUnit, unit });
}

/**
 * Reel groups proven against Graph v25.0 on 2026-07-30.
 *
 * Split finely on purpose. `skip_rate` sits alone rather than beside watch time
 * because it is the newest field and the one most likely to be withdrawn; if it
 * starts erroring, the watch-time metrics beside it still land.
 */
const reelGroupsV25: readonly InstagramInsightGroup[] = Object.freeze([
  Object.freeze({
    key: "distribution",
    metrics: Object.freeze([metric("views", "views"), metric("reach", "reach")]),
  }),
  Object.freeze({
    key: "engagement",
    metrics: Object.freeze([
      metric("likes", "likes"),
      metric("comments", "comments"),
      metric("shares", "shares"),
      // Meta's field is `saved`; the canonical name is `saves`.
      metric("saves", "saved"),
      metric("total_interactions", "total_interactions"),
    ]),
  }),
  Object.freeze({
    key: "watch_time",
    metrics: Object.freeze([
      metric(
        "total_watch_time_ms",
        "ig_reels_video_view_total_time",
        "milliseconds",
        "milliseconds",
      ),
      metric("average_watch_time_ms", "ig_reels_avg_watch_time", "milliseconds", "milliseconds"),
    ]),
  }),
  Object.freeze({
    key: "retention",
    metrics: Object.freeze([metric("skip_rate", "reels_skip_rate", "ratio")]),
  }),
]);

/**
 * The capability map, keyed by API version then media kind.
 *
 * Only `REEL` is populated for v25.0. The contract proof exercised Reels alone,
 * and Meta rejects an undocumented name for a media type outright, so an
 * unproven entry for images or carousels would turn a working request into a
 * failed one. Those kinds report `not_requested` until a proof covers them —
 * which is a statement about our evidence, not about the provider.
 */
export const instagramInsightCapabilityMap: Readonly<
  Record<string, Readonly<Partial<Record<InstagramMediaKind, readonly InstagramInsightGroup[]>>>>
> = Object.freeze({
  [instagramApiVersion]: Object.freeze({ REEL: reelGroupsV25 }),
});

export function instagramInsightGroups(
  input: Readonly<{ apiVersion: string; mediaKind: InstagramMediaKind }>,
): readonly InstagramInsightGroup[] {
  return instagramInsightCapabilityMap[input.apiVersion]?.[input.mediaKind] ?? Object.freeze([]);
}

/**
 * Every media kind this version can request insights for.
 *
 * A sweep that has to narrow candidates in SQL reads this rather than naming the
 * kinds itself. The handler already refuses an unsupported kind, so a scheduler
 * filter is an optimisation — but one that writes the capability map's contents
 * into a query, where it would drift the moment a proof adds a kind here.
 */
export function instagramInsightMediaKinds(apiVersion: string): readonly InstagramMediaKind[] {
  const supported = instagramInsightCapabilityMap[apiVersion];
  if (!supported) return Object.freeze([]);

  return Object.freeze(
    Object.entries(supported)
      .filter(([, groups]) => (groups?.length ?? 0) > 0)
      .map(([kind]) => kind as InstagramMediaKind)
      .sort(),
  );
}

/** Every canonical metric the map requests for this version and media kind. */
export function instagramRequestedMetrics(
  input: Readonly<{ apiVersion: string; mediaKind: InstagramMediaKind }>,
): readonly InstagramCanonicalMetric[] {
  return Object.freeze(
    instagramInsightGroups(input).flatMap((group) => group.metrics.map((entry) => entry.canonical)),
  );
}

export type InstagramMetricObservation = Readonly<{
  availability: InstagramMetricAvailability;
  canonical: InstagramCanonicalMetric;
  /** Provider-supplied description, when the response carries one. */
  description: string | null;
  /** The period Meta reported, recorded verbatim rather than assumed. */
  period: string | null;
  providerName: string | null;
  providerUnit: InstagramMetricUnit | null;
  title: string | null;
  unit: InstagramMetricUnit | null;
  /** Null unless availability is `available`. Never a substitute zero. */
  value: number | null;
}>;

function observation(
  canonical: InstagramCanonicalMetric,
  availability: InstagramMetricAvailability,
  overrides: Partial<InstagramMetricObservation> = {},
): InstagramMetricObservation {
  return Object.freeze({
    availability,
    canonical,
    description: null,
    period: null,
    providerName: null,
    providerUnit: null,
    title: null,
    unit: null,
    value: null,
    ...overrides,
  });
}

/**
 * Builds the observation set for metrics the map never asked for.
 *
 * Every canonical metric appears on every snapshot, so a reader can always tell
 * why a value is absent instead of finding the key missing and guessing.
 */
export function instagramUnrequestedObservations(
  requested: readonly InstagramCanonicalMetric[],
  reason: Extract<
    InstagramMetricAvailability,
    "not_applicable" | "not_requested"
  > = "not_requested",
): readonly InstagramMetricObservation[] {
  const asked = new Set<string>(requested);
  return Object.freeze(
    instagramCanonicalMetrics
      .filter((canonical) => !asked.has(canonical))
      .map((canonical) => observation(canonical, reason)),
  );
}

/** Reasons an insight item is rejected rather than stored. */
export const instagramInsightRejectionReasons = [
  "ITEM_NOT_OBJECT",
  "METRIC_UNKNOWN",
  "VALUE_NOT_FINITE",
  "VALUE_NEGATIVE",
  "VALUE_OUT_OF_RANGE",
] as const;

export type InstagramInsightRejectionReason = (typeof instagramInsightRejectionReasons)[number];

export type InstagramInsightNormalisation =
  | Readonly<{ ok: true; observation: InstagramMetricObservation }>
  | Readonly<{ ok: false; providerName: string | null; reason: InstagramInsightRejectionReason }>;

/** A ratio above this cannot be a real skip rate and indicates a contract change. */
const maximumRatio = 1;
const maximumCount = Number.MAX_SAFE_INTEGER;
/** Ten years in milliseconds; a watch time beyond this is not a watch time. */
const maximumMilliseconds = 315_360_000_000;

function readNumber(item: Record<string, unknown>): number | null {
  const totalValue = isRecord(item.total_value) ? item.total_value.value : undefined;
  if (typeof totalValue === "number") return totalValue;

  const values = Array.isArray(item.values) ? item.values : [];
  for (const entry of values) {
    if (isRecord(entry) && typeof entry.value === "number") return entry.value;
  }
  return null;
}

function readString(item: Record<string, unknown>, key: string): string | null {
  const value = item[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim().slice(0, 512) : null;
}

/**
 * Normalises one returned insight item against the definition that requested it.
 *
 * An item with no numeric value is `unavailable`, never zero — Meta documents an
 * unavailable insight as an empty data set, and a substituted zero would be
 * indistinguishable from a real measurement of nothing.
 */
export function normaliseInstagramInsightItem(
  item: unknown,
  definitions: readonly InstagramMetricDefinition[],
): InstagramInsightNormalisation {
  if (!isRecord(item))
    return Object.freeze({ ok: false, providerName: null, reason: "ITEM_NOT_OBJECT" });

  const providerName = readString(item, "name");
  const definition = definitions.find((entry) => entry.provider === providerName);
  if (!definition) return Object.freeze({ ok: false, providerName, reason: "METRIC_UNKNOWN" });

  const shared = {
    description: readString(item, "description"),
    period: readString(item, "period"),
    providerName: definition.provider,
    providerUnit: definition.providerUnit,
    title: readString(item, "title"),
    unit: definition.unit,
  };

  const raw = readNumber(item);
  if (raw === null) {
    return Object.freeze({
      ok: true,
      observation: observation(definition.canonical, "unavailable", shared),
    });
  }

  if (!Number.isFinite(raw)) {
    return Object.freeze({ ok: false, providerName, reason: "VALUE_NOT_FINITE" });
  }
  // A negative count or duration is impossible and means the contract moved;
  // quarantining it is safer than storing a number analytics would divide by.
  if (raw < 0) return Object.freeze({ ok: false, providerName, reason: "VALUE_NEGATIVE" });

  const ceiling =
    definition.unit === "ratio"
      ? maximumRatio
      : definition.unit === "milliseconds"
        ? maximumMilliseconds
        : maximumCount;
  if (raw > ceiling)
    return Object.freeze({ ok: false, providerName, reason: "VALUE_OUT_OF_RANGE" });

  return Object.freeze({
    ok: true,
    observation: observation(definition.canonical, "available", { ...shared, value: raw }),
  });
}

/**
 * Reads a whole group response into observations.
 *
 * A requested metric absent from the response is `unavailable` rather than
 * missing, so the snapshot always accounts for everything it asked for.
 */
export function readInstagramInsightGroup(
  body: unknown,
  group: InstagramInsightGroup,
): Readonly<{
  observations: readonly InstagramMetricObservation[];
  rejections: readonly InstagramInsightRejectionReason[];
}> {
  const data = isRecord(body) && Array.isArray(body.data) ? body.data : [];
  const byMetric = new Map<InstagramCanonicalMetric, InstagramMetricObservation>();
  const rejections: InstagramInsightRejectionReason[] = [];

  for (const item of data) {
    const result = normaliseInstagramInsightItem(item, group.metrics);
    if (result.ok) byMetric.set(result.observation.canonical, result.observation);
    else rejections.push(result.reason);
  }

  return Object.freeze({
    observations: Object.freeze(
      group.metrics.map(
        (definition) =>
          byMetric.get(definition.canonical) ??
          observation(definition.canonical, "unavailable", {
            providerName: definition.provider,
            providerUnit: definition.providerUnit,
            unit: definition.unit,
          }),
      ),
    ),
    rejections: Object.freeze(rejections),
  });
}

/**
 * Availability to record for a group whose request failed outright.
 *
 * The distinction survives into storage: a permission gap is a human action, a
 * provider error is a retry, and an unsupported name is a capability-map defect
 * that should be corrected rather than retried.
 */
export function instagramGroupFailureAvailability(
  responseClass: "authorisation" | "invalid_request" | "rate_limit" | "transient" | "unsupported",
): InstagramMetricAvailability {
  if (responseClass === "authorisation") return "permission_missing";
  if (responseClass === "unsupported") return "not_applicable";
  return "provider_error";
}

export function instagramFailedGroupObservations(
  group: InstagramInsightGroup,
  availability: InstagramMetricAvailability,
): readonly InstagramMetricObservation[] {
  return Object.freeze(
    group.metrics.map((definition) =>
      observation(definition.canonical, availability, {
        providerName: definition.provider,
        providerUnit: definition.providerUnit,
        unit: definition.unit,
      }),
    ),
  );
}

/**
 * Post-age buckets used to compare like with like.
 *
 * Analytics may only compare snapshots from the same bucket, so the bucket is
 * recorded on the observation rather than derived later from a timestamp that
 * would drift as definitions change.
 */
export const instagramSnapshotBuckets = [
  { key: "import", maximumSeconds: 1_800 },
  { key: "hour_1", maximumSeconds: 7_200 },
  { key: "day_1", maximumSeconds: 129_600 },
  { key: "day_3", maximumSeconds: 345_600 },
  { key: "day_7", maximumSeconds: 777_600 },
  { key: "day_30", maximumSeconds: 3_456_000 },
  { key: "mature", maximumSeconds: Number.POSITIVE_INFINITY },
] as const;

export type InstagramSnapshotBucket = (typeof instagramSnapshotBuckets)[number]["key"];

export function instagramSnapshotBucketFor(postAgeSeconds: number): InstagramSnapshotBucket {
  // An unknown or negative age belongs in `import`, which the analytics contract
  // defines as the import/unknown bucket — a negative age is clock skew on a
  // post published moments ago. An implausibly large age is not unknown, so it
  // falls through to `mature`: that is the loosest bucket, and contaminating the
  // tightest one would corrupt the comparison `import` exists to make.
  if (Number.isNaN(postAgeSeconds) || postAgeSeconds < 0) return "import";
  return (
    instagramSnapshotBuckets.find((bucket) => postAgeSeconds <= bucket.maximumSeconds)?.key ??
    "mature"
  );
}

/**
 * Fingerprints an observation set for deduplication.
 *
 * It covers only the canonical metric, its availability and its value —
 * deliberately not the provider's title, description or the capture time, which
 * change without the measurement changing. Two observations of the same numbers
 * therefore hash alike and collapse, while a single changed value produces a new
 * snapshot rather than overwriting the old one.
 */
export function hashInstagramInsightObservations(
  observations: readonly InstagramMetricObservation[],
): string {
  const canonicalised = [...observations]
    .sort((left, right) => left.canonical.localeCompare(right.canonical))
    .map((entry) => [entry.canonical, entry.availability, entry.value] as const);

  return createHash("sha256").update(JSON.stringify(canonicalised), "utf8").digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
