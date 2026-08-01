import {
  instagramCanonicalMetrics,
  type InstagramCanonicalMetric,
  type InstagramMetricObservation,
  type InstagramMetricUnit,
} from "./instagram-insights.js";

/**
 * Pure derived-metric contract: the canonical rate dictionary, the formulas and
 * the provenance every calculated value carries.
 *
 * Two rules shape everything here. A denominator is never implicit — each result
 * names the exact value it divided by, because the same numerator over reach and
 * over views are different metrics that a chart would otherwise render alike. And
 * unavailable is never zero: a missing input produces an explicit reason rather
 * than a substituted number, so a gap in the provider's data can never be read as
 * a measurement of nothing.
 *
 * Cohort selection, medians, baselines and confidence classification are not here.
 * They consume these values and are versioned alongside them.
 *
 * Nothing in this module performs a request or touches a database.
 */

export const analyticsVersion = "account-analytics-v1.0.0" as const;

/**
 * Derived metrics, each named for its denominator where it has one.
 *
 * The `_reach` suffix is load-bearing rather than decorative. `follow_rate_reach`
 * and `follow_conversion_rate` share a numerator and answer different questions,
 * and the contract requires the difference to survive into storage and display.
 */
export const derivedMetrics = [
  "engagement_count",
  "engagement_rate_reach",
  "like_rate_reach",
  "comment_rate_reach",
  "share_rate_reach",
  "save_rate_reach",
  "profile_visit_rate_reach",
  "follow_conversion_rate",
  "follow_rate_reach",
  "average_watch_percentage",
  "completion_proxy",
] as const;

export type DerivedMetric = (typeof derivedMetrics)[number];

export const derivedMetricUnits = ["count", "ratio"] as const;

export type DerivedMetricUnit = (typeof derivedMetricUnits)[number];

/**
 * Where a value came from.
 *
 * Meta returns like and comment counts both as media metadata and as insight
 * metrics, under different definitions that disagree in practice. The contract
 * forbids merging them, so the source travels with the value and a formula
 * refuses to mix them rather than silently preferring one.
 */
export const metricValueSources = ["insight", "metadata"] as const;

export type MetricValueSource = (typeof metricValueSources)[number];

/**
 * Which duration a watch calculation used.
 *
 * The validated source video is authoritative when it corroborates the provider,
 * because it was probed locally. When the two disagree the provider's duration is
 * used, since a mismatch means the uploaded asset is probably not the published
 * cut, and the disagreement is reported as a limitation rather than hidden.
 */
export const metricDurationSources = ["validated_source_video", "provider_metadata"] as const;

export type MetricDurationSource = (typeof metricDurationSources)[number];

/**
 * Why a derived metric has no value.
 *
 * These stay distinct through to storage. A missing component is the provider's
 * gap, a non-positive denominator is a real but unusable measurement, and an
 * incompatible source is a defect in the caller's input assembly. Collapsing them
 * would make a bug indistinguishable from an absence.
 */
export const derivedMetricUnavailabilityReasons = [
  "component_unavailable",
  "denominator_unavailable",
  "denominator_not_positive",
  "duration_unavailable",
  "duration_not_positive",
  "incompatible_source",
  "incompatible_unit",
  "value_rejected",
  "not_representable",
] as const;

export type DerivedMetricUnavailabilityReason = (typeof derivedMetricUnavailabilityReasons)[number];

/**
 * The canonical metrics a formula may read.
 *
 * `views` and `plays` are deliberately absent. No documented rate divides by
 * either, and Meta defines them differently per surface, so excluding them from
 * the input vocabulary makes "never combine views and plays" a property of the
 * type rather than a rule someone must remember.
 */
export const metricInputKeys = [
  "likes",
  "comments",
  "shares",
  "saves",
  "reach",
  "follows",
  "profile_visits",
  "average_watch_time_ms",
] as const satisfies readonly InstagramCanonicalMetric[];

export type MetricInputKey = (typeof metricInputKeys)[number];

export type MetricInputState =
  | Readonly<{
      available: true;
      source: MetricValueSource;
      unit: InstagramMetricUnit;
      value: number;
    }>
  | Readonly<{ available: false; reason: DerivedMetricUnavailabilityReason }>;

export type MetricDurationResolution = Readonly<{
  /** Null when neither a validated asset nor the provider supplied a duration. */
  seconds: number | null;
  source: MetricDurationSource | null;
  /** True when a validated asset and the provider disagreed beyond tolerance. */
  mismatch: boolean;
  /**
   * True when a duration was supplied but was not a usable positive number.
   *
   * Separate from a plain absence: a zero-length video is an impossible value
   * that should be corrected, whereas no duration at all is a coverage gap.
   */
  rejected: boolean;
  limitations: readonly string[];
}>;

export type MetricInputSet = Readonly<{
  duration: MetricDurationResolution;
  snapshotId: string;
  values: Readonly<Record<MetricInputKey, MetricInputState>>;
}>;

type DerivedMetricDenominator =
  | Readonly<{ kind: "none" }>
  | Readonly<{ kind: "metric"; key: MetricInputKey; label: string }>
  | Readonly<{ kind: "duration"; label: string }>;

export type DerivedMetricDefinition = Readonly<{
  /** True only where the formula itself clamps; see `completion_proxy`. */
  bounded: boolean;
  denominator: DerivedMetricDenominator;
  formula: string;
  limitations: readonly string[];
  metric: DerivedMetric;
  /** Summed to form the numerator. More than one entry means every one is required. */
  numerator: readonly MetricInputKey[];
  numeratorUnit: InstagramMetricUnit;
  unit: DerivedMetricUnit;
}>;

export type DerivedMetricResult = Readonly<{
  analyticsVersion: typeof analyticsVersion;
  availability: "available" | "unavailable";
  /** Names the exact value divided by, or null for a count. */
  denominator: string | null;
  durationSource: MetricDurationSource | null;
  formula: string;
  limitations: readonly string[];
  metric: DerivedMetric;
  /** Inputs that were required and absent. Empty when available. */
  missing: readonly MetricInputKey[];
  reason: DerivedMetricUnavailabilityReason | null;
  snapshotId: string;
  unit: DerivedMetricUnit;
  /** Null unless availability is `available`. Never a substitute zero. */
  value: number | null;
}>;

const reachDenominator = Object.freeze({
  kind: "metric",
  key: "reach",
  label: "reach",
} as const);

const durationDenominator = Object.freeze({
  kind: "duration",
  label: "duration_seconds",
} as const);

const engagementComponents: readonly MetricInputKey[] = Object.freeze([
  "likes",
  "comments",
  "shares",
  "saves",
] as const);

const watchLimitation =
  "Average watch time is a provider-defined mean; replays and provider counting rules can push it above the video duration.";

function rate(
  metric: DerivedMetric,
  numerator: readonly MetricInputKey[],
  formula: string,
  limitations: readonly string[] = [],
): DerivedMetricDefinition {
  return Object.freeze({
    bounded: false,
    denominator: reachDenominator,
    formula,
    limitations: Object.freeze(limitations),
    metric,
    numerator: Object.freeze([...numerator]),
    numeratorUnit: "count",
    unit: "ratio",
  });
}

/**
 * The formula dictionary, transcribed from the analytics contract.
 *
 * Every entry is declarative so downstream analytics can enumerate metrics and
 * read their denominators without re-deriving them, and so a formula change is a
 * visible edit to one table rather than a scattered code change.
 */
export const derivedMetricDefinitions: Readonly<Record<DerivedMetric, DerivedMetricDefinition>> =
  Object.freeze({
    engagement_count: Object.freeze({
      bounded: false,
      denominator: Object.freeze({ kind: "none" } as const),
      formula: "likes + comments + shares + saves",
      limitations: Object.freeze([]),
      metric: "engagement_count",
      numerator: engagementComponents,
      numeratorUnit: "count",
      unit: "count",
    }),
    engagement_rate_reach: rate(
      "engagement_rate_reach",
      engagementComponents,
      "(likes + comments + shares + saves) / reach",
    ),
    like_rate_reach: rate("like_rate_reach", ["likes"], "likes / reach"),
    comment_rate_reach: rate("comment_rate_reach", ["comments"], "comments / reach"),
    share_rate_reach: rate("share_rate_reach", ["shares"], "shares / reach"),
    save_rate_reach: rate("save_rate_reach", ["saves"], "saves / reach"),
    profile_visit_rate_reach: rate(
      "profile_visit_rate_reach",
      ["profile_visits"],
      "profile_visits / reach",
      [
        "Valid only where the provider attributes profile visits to this media under a definition compatible with reach.",
      ],
    ),
    follow_conversion_rate: Object.freeze({
      bounded: false,
      denominator: Object.freeze({
        kind: "metric",
        key: "profile_visits",
        label: "profile_visits",
      } as const),
      formula: "follows / profile_visits",
      limitations: Object.freeze([
        "Conversion after a profile visit, not follows per account reached.",
      ]),
      metric: "follow_conversion_rate",
      numerator: Object.freeze(["follows"] as const),
      numeratorUnit: "count",
      unit: "ratio",
    }),
    follow_rate_reach: rate("follow_rate_reach", ["follows"], "follows / reach"),
    average_watch_percentage: Object.freeze({
      bounded: false,
      denominator: durationDenominator,
      formula: "(average_watch_time_ms / 1000) / duration_seconds",
      limitations: Object.freeze([watchLimitation, "Stored unclamped; may exceed 1."]),
      metric: "average_watch_percentage",
      numerator: Object.freeze(["average_watch_time_ms"] as const),
      numeratorUnit: "milliseconds",
      unit: "ratio",
    }),
    completion_proxy: Object.freeze({
      bounded: true,
      denominator: durationDenominator,
      formula: "min(1, average_watch_time_ms / (duration_seconds * 1000))",
      limitations: Object.freeze([
        watchLimitation,
        "A coarse bounded proxy, not a measured completion rate; always present it beside the unclamped average watch percentage.",
      ]),
      metric: "completion_proxy",
      numerator: Object.freeze(["average_watch_time_ms"] as const),
      numeratorUnit: "milliseconds",
      unit: "ratio",
    }),
  });

/**
 * A validated asset and the provider may disagree about how long the video is.
 *
 * One second absorbs the rounding a provider applies when it reports whole
 * seconds against a locally probed millisecond duration. Anything wider is a real
 * disagreement about which cut was published.
 */
export const metricDurationToleranceSeconds = 1;

function isUsableDuration(seconds: number | null | undefined): seconds is number {
  return typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0;
}

/**
 * Chooses the duration a watch calculation divides by, and says which it chose.
 *
 * The validated asset wins only when it corroborates the provider or the provider
 * offered nothing. When they disagree the provider's value is used and the
 * mismatch becomes a limitation, because the contract requires a source-duration
 * mismatch to be flagged rather than resolved silently in either direction.
 */
export function resolveMetricDuration(
  input: Readonly<{
    providerSeconds?: number | null;
    toleranceSeconds?: number;
    validatedSourceSeconds?: number | null;
  }>,
): MetricDurationResolution {
  const tolerance = input.toleranceSeconds ?? metricDurationToleranceSeconds;
  const validated = isUsableDuration(input.validatedSourceSeconds)
    ? input.validatedSourceSeconds
    : null;
  const provider = isUsableDuration(input.providerSeconds) ? input.providerSeconds : null;

  // A supplied duration that is zero, negative or non-finite is an impossible
  // measurement rather than an absence, and the contract requires impossible
  // values to be flagged instead of quietly discarded.
  const discarded: string[] = [];
  if (input.validatedSourceSeconds != null && validated === null) {
    discarded.push(
      `Validated source video duration (${input.validatedSourceSeconds}) is not a usable positive duration and was discarded.`,
    );
  }
  if (input.providerSeconds != null && provider === null) {
    discarded.push(
      `Provider duration (${input.providerSeconds}) is not a usable positive duration and was discarded.`,
    );
  }

  const resolve = (
    seconds: number | null,
    source: MetricDurationSource | null,
    mismatch: boolean,
    limitations: readonly string[] = [],
  ): MetricDurationResolution =>
    Object.freeze({
      limitations: Object.freeze([...discarded, ...limitations]),
      mismatch,
      rejected: seconds === null && discarded.length > 0,
      seconds,
      source,
    });

  if (validated !== null && provider !== null) {
    const mismatch = Math.abs(validated - provider) > tolerance;
    return resolve(
      mismatch ? provider : validated,
      mismatch ? "provider_metadata" : "validated_source_video",
      mismatch,
      mismatch
        ? [
            `Validated source video duration (${validated}s) disagrees with the provider duration (${provider}s) by more than ${tolerance}s; the provider duration was used.`,
          ]
        : [],
    );
  }

  if (validated !== null) return resolve(validated, "validated_source_video", false);
  if (provider !== null) return resolve(provider, "provider_metadata", false);

  return resolve(null, null, false);
}

const unavailableInput = (reason: DerivedMetricUnavailabilityReason): MetricInputState =>
  Object.freeze({ available: false, reason });

/**
 * Rejects a value that cannot be a real measurement.
 *
 * A negative or non-finite count means the provider contract moved. Quarantining
 * it as `value_rejected` keeps it out of arithmetic while still distinguishing it
 * from an absence, which is what a reader needs to tell a provider outage from a
 * provider change.
 */
function readInputValue(observation: InstagramMetricObservation): MetricInputState {
  if (observation.availability !== "available" || observation.value === null) {
    return unavailableInput("component_unavailable");
  }
  const { value } = observation;
  if (!Number.isFinite(value) || value < 0) return unavailableInput("value_rejected");
  if (!Number.isSafeInteger(value) && observation.unit !== "ratio") {
    // Counts and millisecond durations arrive as integers. A non-integer means a
    // unit was converted upstream and precision is already lost.
    if (!Number.isInteger(value)) return unavailableInput("value_rejected");
    return unavailableInput("not_representable");
  }
  return Object.freeze({
    available: true,
    source: "insight",
    unit: observation.unit ?? "count",
    value,
  });
}

const emptyDuration: MetricDurationResolution = Object.freeze({
  limitations: Object.freeze([]),
  mismatch: false,
  rejected: false,
  seconds: null,
  source: null,
});

/**
 * Builds the input set one snapshot offers to the formulas.
 *
 * Every readable key is present in the result whether or not it has a value, so a
 * formula reports precisely which input it lacked instead of failing with a
 * missing property.
 */
export function createMetricInputs(
  input: Readonly<{
    duration?: MetricDurationResolution;
    observations: readonly InstagramMetricObservation[];
    snapshotId: string;
  }>,
): MetricInputSet {
  const byMetric = new Map<InstagramCanonicalMetric, InstagramMetricObservation>();
  for (const observation of input.observations) {
    if (instagramCanonicalMetrics.includes(observation.canonical)) {
      byMetric.set(observation.canonical, observation);
    }
  }

  const values = {} as Record<MetricInputKey, MetricInputState>;
  for (const key of metricInputKeys) {
    const observation = byMetric.get(key);
    values[key] = observation
      ? readInputValue(observation)
      : unavailableInput("component_unavailable");
  }

  return Object.freeze({
    duration: input.duration ?? emptyDuration,
    snapshotId: input.snapshotId,
    values: Object.freeze(values),
  });
}

function unavailable(
  definition: DerivedMetricDefinition,
  inputs: MetricInputSet,
  reason: DerivedMetricUnavailabilityReason,
  missing: readonly MetricInputKey[],
  extraLimitations: readonly string[] = [],
): DerivedMetricResult {
  return Object.freeze({
    analyticsVersion,
    availability: "unavailable",
    denominator: definition.denominator.kind === "none" ? null : definition.denominator.label,
    durationSource: definition.denominator.kind === "duration" ? inputs.duration.source : null,
    formula: definition.formula,
    limitations: Object.freeze([...definition.limitations, ...extraLimitations]),
    metric: definition.metric,
    missing: Object.freeze([...missing]),
    reason,
    snapshotId: inputs.snapshotId,
    unit: definition.unit,
    value: null,
  });
}

/**
 * Calculates one derived metric.
 *
 * Availability is resolved before any arithmetic, so the only division this
 * function reaches has already been proven to have a positive denominator. That
 * ordering is what makes an Infinity or a NaN unreachable rather than merely
 * unlikely.
 */
export function calculateDerivedMetric(
  metric: DerivedMetric,
  inputs: MetricInputSet,
): DerivedMetricResult {
  const definition = derivedMetricDefinitions[metric];

  const missing: MetricInputKey[] = [];
  const components: number[] = [];
  for (const key of definition.numerator) {
    const state = inputs.values[key];
    if (!state.available) {
      missing.push(key);
      continue;
    }
    if (state.source !== "insight") {
      return unavailable(definition, inputs, "incompatible_source", [key]);
    }
    if (state.unit !== definition.numeratorUnit) {
      return unavailable(definition, inputs, "incompatible_unit", [key]);
    }
    components.push(state.value);
  }

  // The contract forbids calling a partial sum engagement, so a single absent
  // component makes the whole numerator unavailable rather than smaller.
  if (missing.length > 0) {
    // A quarantined impossible value is a different signal from a provider gap,
    // so its own reason survives rather than being flattened to absence.
    const rejected = missing
      .map((key) => inputs.values[key])
      .find((state) => !state.available && state.reason !== "component_unavailable");
    const reason =
      rejected && !rejected.available ? rejected.reason : ("component_unavailable" as const);
    return unavailable(definition, inputs, reason, missing);
  }

  const numerator = components.reduce((total, value) => total + value, 0);
  if (!Number.isFinite(numerator)) {
    return unavailable(definition, inputs, "not_representable", []);
  }
  if (definition.numeratorUnit !== "ratio" && !Number.isSafeInteger(numerator)) {
    // Beyond 2^53 an integer sum silently stops being exact; refusing is the only
    // honest option because the error is invisible in the result.
    return unavailable(definition, inputs, "not_representable", []);
  }

  let denominator: number;
  if (definition.denominator.kind === "none") {
    return available(definition, inputs, numerator);
  }

  if (definition.denominator.kind === "duration") {
    const seconds = inputs.duration.seconds;
    if (seconds === null) {
      // A rejected duration was measured and impossible; an absent one was never
      // measured. Only the first is a defect somebody can act on.
      return unavailable(
        definition,
        inputs,
        inputs.duration.rejected ? "duration_not_positive" : "duration_unavailable",
        [],
      );
    }
    // Defensive: a caller may assemble a MetricInputSet without the resolver.
    if (!(seconds > 0)) return unavailable(definition, inputs, "duration_not_positive", []);
    // Both watch metrics divide milliseconds by milliseconds. Scaling the
    // denominator once, rather than scaling the numerator for one metric and the
    // denominator for the other, keeps `completion_proxy` exactly equal to
    // `min(1, average_watch_percentage)` instead of differing in the last bits.
    denominator = seconds * 1000;
  } else {
    const state = inputs.values[definition.denominator.key];
    if (!state.available) {
      const reason =
        state.reason === "component_unavailable" ? "denominator_unavailable" : state.reason;
      return unavailable(definition, inputs, reason, [definition.denominator.key]);
    }
    if (state.source !== "insight") {
      return unavailable(definition, inputs, "incompatible_source", [definition.denominator.key]);
    }
    if (state.unit !== "count") {
      return unavailable(definition, inputs, "incompatible_unit", [definition.denominator.key]);
    }
    denominator = state.value;
  }

  // Zero reach with real interactions is possible in provider data and is exactly
  // the case a substituted zero or an Infinity would misreport.
  if (!(denominator > 0)) {
    return unavailable(
      definition,
      inputs,
      definition.denominator.kind === "duration"
        ? "duration_not_positive"
        : "denominator_not_positive",
      [],
    );
  }

  const ratio = numerator / denominator;
  if (!Number.isFinite(ratio)) return unavailable(definition, inputs, "not_representable", []);

  return available(definition, inputs, definition.bounded ? Math.min(1, ratio) : ratio);
}

function available(
  definition: DerivedMetricDefinition,
  inputs: MetricInputSet,
  value: number,
): DerivedMetricResult {
  return Object.freeze({
    analyticsVersion,
    availability: "available",
    denominator: definition.denominator.kind === "none" ? null : definition.denominator.label,
    durationSource: definition.denominator.kind === "duration" ? inputs.duration.source : null,
    formula: definition.formula,
    limitations: Object.freeze([
      ...definition.limitations,
      ...(definition.denominator.kind === "duration" ? inputs.duration.limitations : []),
    ]),
    metric: definition.metric,
    missing: Object.freeze([]),
    reason: null,
    snapshotId: inputs.snapshotId,
    unit: definition.unit,
    // Normalises a negative zero, which compares equal to zero but serialises as
    // "-0" and would surface in stored evidence.
    value: value === 0 ? 0 : value,
  });
}

/** Calculates every derived metric for one snapshot, in dictionary order. */
export function calculateDerivedMetrics(inputs: MetricInputSet): readonly DerivedMetricResult[] {
  return Object.freeze(derivedMetrics.map((metric) => calculateDerivedMetric(metric, inputs)));
}
