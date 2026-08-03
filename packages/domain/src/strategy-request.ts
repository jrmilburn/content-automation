import { createHash } from "node:crypto";

import { derivedMetrics, type DerivedMetric } from "./analytics-metrics.js";
import {
  strategyContractArtifacts,
  strategyModelRequested,
  strategyPromptVersion,
  strategySchemaVersion,
  type StrategyClaimDimension,
  type StrategyEvidenceClass,
  type StrategyEvidenceRole,
  type StrategyEvidenceType,
  type StrategyManifestEvidence,
  type StrategyMode,
} from "./strategy-contract.js";

/**
 * Choosing the evidence one strategy request is allowed to reason from.
 *
 * The whole point of this module is that the model never chooses its own
 * evidence. Retrieval is enumerated, capped and ordered here, and the result is
 * frozen before the request is made, so the same account and the same inputs
 * produce the same manifest and a retry argues from exactly what the first
 * attempt argued from.
 *
 * Determinism is a correctness property rather than a convenience. A manifest
 * assembled in a different order would hash differently, which would present two
 * identical requests as two different pieces of history, and a reader comparing
 * a strategy against its evidence could not tell whether the evidence had
 * changed or merely been re-sorted. Every ordering below therefore ends in a
 * content-derived tiebreak and never relies on the order rows arrived in.
 *
 * Nothing in this module performs a request or touches a database.
 */

export const strategyRetrievalVersion = "account-strategy-retrieval-v1.0.0" as const;

/**
 * What an evidence-led strategy requires, from `strategy-generation.md`.
 *
 * Falling short does not refuse the request; it makes the result exploratory,
 * which the caller has to accept explicitly. The distinction is the contract's:
 * a thin account should still be able to ask, and should never be told that a
 * proposal built from four posts is a supported finding.
 */
export const strategyEligibilityThresholds = Object.freeze({
  analyses: 10,
  comparablePosts: 8,
  publicationWeeks: 4,
});

/**
 * Why a request produced no model call.
 *
 * These stay distinct through to the caller. "Nothing analysed yet" is a normal
 * state for a new account, a stale calculation is a timing problem that fixes
 * itself, and an unconfirmed exploratory request is a decision the user has not
 * made. Collapsing them would present all three as the same dead end.
 */
export const strategyRefusalReasons = [
  "account_not_found",
  "no_analysed_posts",
  "no_active_calculation",
  "stale_calculation",
  "metric_not_comparable",
  "exploratory_not_confirmed",
] as const;

export type StrategyRefusalReason = (typeof strategyRefusalReasons)[number];

export type StrategyEligibilityInput = Readonly<{
  /** Whether the caller has agreed to an exploratory result. */
  acceptExploratory: boolean;
  activeRunId: string | null;
  analysedPostCount: number;
  /** True while a recalculation is owed, so statistics are mid-flight. */
  analyticsDirty: boolean;
  comparablePostCount: number;
  instagramAccountId: string | null;
  primaryMetric: string;
  publicationWeekCount: number;
}>;

export type StrategyEligibility =
  | Readonly<{ eligible: true; mode: StrategyMode }>
  | Readonly<{ eligible: false; mode: StrategyMode | null; reason: StrategyRefusalReason }>;

/**
 * Whether a request may be made, and as which mode.
 *
 * Returns a decision rather than throwing, because every refusal here is a
 * legitimate answer the caller has to render — not an error.
 *
 * The metric is checked against `derivedMetrics` rather than the contract's
 * `canonicalMetric`. The two disagree on purpose: a strategy the model writes
 * may name any canonical metric in an experiment, but only a derived metric has
 * statistics and post values behind it, so only a derived metric can be asked
 * for. Accepting `views` here would build a manifest with nothing in it.
 */
export function evaluateStrategyEligibility(input: StrategyEligibilityInput): StrategyEligibility {
  if (input.instagramAccountId === null) {
    return Object.freeze({ eligible: false, mode: null, reason: "account_not_found" });
  }

  if (!(derivedMetrics as readonly string[]).includes(input.primaryMetric)) {
    return Object.freeze({ eligible: false, mode: null, reason: "metric_not_comparable" });
  }

  // Zero analyses returns an empty state rather than calling Gemini. Checked
  // before the run, because an account with nothing analysed has nothing to
  // calculate either and "no active calculation" would be the less useful answer.
  if (input.analysedPostCount <= 0) {
    return Object.freeze({ eligible: false, mode: null, reason: "no_analysed_posts" });
  }

  if (input.activeRunId === null) {
    return Object.freeze({ eligible: false, mode: null, reason: "no_active_calculation" });
  }

  // A recalculation is owed, so the active statistics describe inputs that have
  // already moved. Freezing them would put a strategy's evidence and the
  // dashboard's numbers permanently out of step for that generation.
  if (input.analyticsDirty) {
    return Object.freeze({ eligible: false, mode: null, reason: "stale_calculation" });
  }

  const meetsThresholds =
    input.analysedPostCount >= strategyEligibilityThresholds.analyses &&
    input.comparablePostCount >= strategyEligibilityThresholds.comparablePosts &&
    input.publicationWeekCount >= strategyEligibilityThresholds.publicationWeeks;

  if (meetsThresholds) {
    return Object.freeze({ eligible: true, mode: "evidence_led" });
  }

  if (!input.acceptExploratory) {
    return Object.freeze({
      eligible: false,
      mode: "exploratory",
      reason: "exploratory_not_confirmed",
    });
  }

  return Object.freeze({ eligible: true, mode: "exploratory" });
}

/**
 * The retrieval categories, in precedence order.
 *
 * The order is load-bearing twice over: it is the order the manifest is written
 * in, and it is which category keeps a record that two of them both selected.
 * Statistics come before posts so that a post already carried by a statistic is
 * not also listed as a top performer, which would present one observation as
 * two pieces of agreement.
 */
export const strategyEvidenceCategories = [
  "positive_statistic",
  "negative_statistic",
  "counterexample",
  "top_post",
  "weak_post",
  "recent_post",
  "comparator_post",
  "distribution",
  "recent_strategy",
  "data_quality",
] as const;

export type StrategyEvidenceCategory = (typeof strategyEvidenceCategories)[number];

/** Per-category caps from `strategy-generation.md`. */
export const strategyEvidenceCaps: Readonly<Record<StrategyEvidenceCategory, number>> =
  Object.freeze({
    comparator_post: 6,
    counterexample: 4,
    data_quality: 8,
    distribution: 1,
    negative_statistic: 6,
    positive_statistic: 8,
    recent_post: 6,
    recent_strategy: 3,
    top_post: 6,
    weak_post: 4,
  });

/** Caps that apply across categories rather than within one. */
export const strategyManifestCaps = Object.freeze({
  posts: 30,
  recommendationFingerprints: 30,
  statistics: 20,
});

/**
 * Input-token budget for the rendered manifest and instruction.
 *
 * An estimate, and named as one. There is no tokenizer in this repository and
 * the provider only reports usage after the fact, so this bounds the request by
 * a deterministic proxy rather than by a measurement. It is versioned into
 * `strategyRetrievalVersion`, so changing the proxy invalidates prior hashes
 * instead of silently producing a different manifest under the same version.
 */
export const strategyInputTokenBudget = 120_000;

/** Characters per token. Deliberately pessimistic, so the estimate over-counts. */
const charactersPerToken = 3;

export function estimateStrategyPromptTokens(text: string): number {
  return Math.ceil(text.length / charactersPerToken);
}

const categoryPrefixes: Readonly<Record<StrategyEvidenceCategory, string>> = Object.freeze({
  comparator_post: "post_cmp",
  counterexample: "counter",
  data_quality: "quality",
  distribution: "dist",
  negative_statistic: "stat_neg",
  positive_statistic: "stat_pos",
  recent_post: "post_recent",
  recent_strategy: "prior",
  top_post: "post_top",
  weak_post: "post_weak",
});

export type StrategyEvidenceCandidate = Readonly<{
  allowedNumericClaims: readonly string[];
  allowedRoles: readonly StrategyEvidenceRole[];
  category: StrategyEvidenceCategory;
  classification: StrategyEvidenceClass | null;
  dimensions: readonly StrategyClaimDimension[];
  evidenceType: StrategyEvidenceType;
  /** Posts this record already speaks for, so a post is not counted twice. */
  postIds: readonly string[];
  /** Higher is better within a category. Null where the category has no order. */
  rankScore: number | null;
  /** The immutable row this refers to, absent for synthesised evidence. */
  referenceId: string | null;
  requiredInLimitations: boolean;
  retrievalReason: string;
  sampleSize: number | null;
  summaryText: string;
}>;

export type StrategyEvidenceEntry = StrategyEvidenceCandidate &
  Readonly<{
    /** Manifest-local opaque ID the model cites. Stable for identical inputs. */
    evidenceKey: string;
    rank: number;
  }>;

export type StrategyEvidenceSelection = Readonly<{
  entries: readonly StrategyEvidenceEntry[];
  /** Categories trimmed by a cap or the budget, for the data-quality summary. */
  trimmed: readonly StrategyEvidenceCategory[];
}>;

const categoryOrder: ReadonlyMap<StrategyEvidenceCategory, number> = new Map(
  strategyEvidenceCategories.map((category, index) => [category, index]),
);

function referenceKey(candidate: StrategyEvidenceCandidate): string {
  return `${candidate.evidenceType}:${candidate.referenceId ?? candidate.summaryText}`;
}

/**
 * Orders one category's candidates totally.
 *
 * Score first, then the reference. The reference tiebreak is what makes the
 * result independent of the order rows came back in — without it two candidates
 * with equal scores would keep whatever order the query happened to produce, and
 * the manifest hash would not be reproducible.
 */
function compareCandidates(a: StrategyEvidenceCandidate, b: StrategyEvidenceCandidate): number {
  const scoreA = a.rankScore ?? Number.NEGATIVE_INFINITY;
  const scoreB = b.rankScore ?? Number.NEGATIVE_INFINITY;
  if (scoreA !== scoreB) return scoreB - scoreA;

  return referenceKey(a).localeCompare(referenceKey(b), "en");
}

function isStatistic(candidate: StrategyEvidenceCandidate): boolean {
  return candidate.evidenceType === "feature_statistic";
}

function isPost(candidate: StrategyEvidenceCandidate): boolean {
  return candidate.evidenceType === "post" || candidate.evidenceType === "post_analysis";
}

/**
 * Applies the caps, removes duplicates and assigns each entry its opaque key.
 *
 * Three separate dedup rules, because they answer different questions. The same
 * record selected by two categories is kept once under the earlier category. A
 * post already carried by a selected statistic is dropped entirely, so one
 * observation cannot appear as two pieces of agreement. And the global caps
 * bound the manifest regardless of how the per-category caps happened to fall.
 *
 * Trimming is reported rather than silent: a manifest that dropped evidence is
 * a manifest with a limitation, and the model is told so.
 */
export function selectStrategyEvidence(
  candidates: readonly StrategyEvidenceCandidate[],
  options: Readonly<{ tokenBudget?: number }> = {},
): StrategyEvidenceSelection {
  const ordered = [...candidates].sort((a, b) => {
    const categoryDelta =
      (categoryOrder.get(a.category) ?? 0) - (categoryOrder.get(b.category) ?? 0);
    return categoryDelta === 0 ? compareCandidates(a, b) : categoryDelta;
  });

  const trimmed = new Set<StrategyEvidenceCategory>();
  const seenReferences = new Set<string>();
  const claimedPosts = new Set<string>();
  const perCategory = new Map<StrategyEvidenceCategory, number>();
  const selected: StrategyEvidenceCandidate[] = [];
  let posts = 0;
  let statistics = 0;

  for (const candidate of ordered) {
    const reference = referenceKey(candidate);
    if (seenReferences.has(reference)) {
      trimmed.add(candidate.category);
      continue;
    }

    const taken = perCategory.get(candidate.category) ?? 0;
    if (taken >= strategyEvidenceCaps[candidate.category]) {
      trimmed.add(candidate.category);
      continue;
    }

    if (isStatistic(candidate) && statistics >= strategyManifestCaps.statistics) {
      trimmed.add(candidate.category);
      continue;
    }

    if (isPost(candidate)) {
      // Already spoken for by a statistic, or already selected as another kind
      // of post. Either way it is one observation, not two.
      if (candidate.postIds.some((postId) => claimedPosts.has(postId))) {
        trimmed.add(candidate.category);
        continue;
      }
      if (posts >= strategyManifestCaps.posts) {
        trimmed.add(candidate.category);
        continue;
      }
      posts += 1;
    }

    if (isStatistic(candidate)) statistics += 1;
    for (const postId of candidate.postIds) claimedPosts.add(postId);
    seenReferences.add(reference);
    perCategory.set(candidate.category, taken + 1);
    selected.push(candidate);
  }

  const budget = options.tokenBudget ?? strategyInputTokenBudget;
  const withinBudget = applyTokenBudget(selected, budget, trimmed);

  const ranks = new Map<StrategyEvidenceCategory, number>();
  const entries = withinBudget.map((candidate) => {
    const rank = ranks.get(candidate.category) ?? 0;
    ranks.set(candidate.category, rank + 1);

    return Object.freeze({
      ...candidate,
      evidenceKey: `${categoryPrefixes[candidate.category]}_${String(rank)}`,
      rank,
    });
  });

  return Object.freeze({
    entries: Object.freeze(entries),
    trimmed: Object.freeze(
      [...trimmed].sort((a, b) => (categoryOrder.get(a) ?? 0) - (categoryOrder.get(b) ?? 0)),
    ),
  });
}

/**
 * Drops the lowest-precedence evidence until the estimate fits.
 *
 * Whole categories from the back rather than individual rows from wherever,
 * because "the budget removed the comparator posts" is an explanation and "the
 * budget removed seven things" is not.
 */
function applyTokenBudget(
  selected: readonly StrategyEvidenceCandidate[],
  budget: number,
  trimmed: Set<StrategyEvidenceCategory>,
): readonly StrategyEvidenceCandidate[] {
  let kept = [...selected];

  while (kept.length > 0 && estimateStrategyPromptTokens(renderCandidates(kept)) > budget) {
    const last = kept[kept.length - 1];
    if (!last) break;

    const category = last.category;
    kept = kept.filter((candidate) => candidate.category !== category);
    trimmed.add(category);
  }

  return kept;
}

function renderCandidates(candidates: readonly StrategyEvidenceCandidate[]): string {
  return candidates.map((candidate) => candidate.summaryText).join("\n");
}

/** Projects a frozen entry onto the shape `validateStrategyV1` checks against. */
export function toStrategyManifestEvidence(entry: StrategyEvidenceEntry): StrategyManifestEvidence {
  return Object.freeze({
    allowedNumericClaims: Object.freeze([...entry.allowedNumericClaims]),
    allowedRoles: Object.freeze([...entry.allowedRoles]),
    classification: entry.classification,
    dimensions: Object.freeze([...entry.dimensions]),
    evidenceId: entry.evidenceKey,
    requiredInLimitations: entry.requiredInLimitations,
    sampleSize: entry.sampleSize,
    type: entry.evidenceType,
  });
}

export type StrategyManifestIdentity = Readonly<{
  ageWindow: string;
  analysisSchemaVersion: string;
  analyticsRunId: string;
  analyticsVersion: string;
  cohortVersion: string;
  editorialConstraint: string | null;
  formatEmphasis: readonly string[];
  instagramAccountId: string;
  mode: StrategyMode;
  pillarEmphasis: readonly string[];
  primaryMetric: DerivedMetric;
  publishedFrom: string;
  publishedTo: string;
  statisticsVersion: string;
}>;

/**
 * The canonical hash of one frozen manifest.
 *
 * Covers what the evidence is, which versions produced it and which request
 * asked for it — so a change in any of them is a different manifest, and two
 * requests that agree on all of them are provably the same. Every array is
 * sorted before hashing rather than trusted, because map iteration order is not
 * part of the contract and a caller assembling emphasis values in a different
 * order must not produce a different hash.
 */
export function createStrategyManifestHash(
  identity: StrategyManifestIdentity,
  entries: readonly StrategyEvidenceEntry[],
): string {
  const canonical = [
    strategyRetrievalVersion,
    strategySchemaVersion,
    strategyContractArtifacts.schema.sha256,
    strategyPromptVersion,
    strategyContractArtifacts.prompt.sha256,
    strategyModelRequested,
    identity.analyticsVersion,
    identity.statisticsVersion,
    identity.cohortVersion,
    identity.analysisSchemaVersion,
    identity.instagramAccountId,
    identity.analyticsRunId,
    identity.mode,
    identity.primaryMetric,
    identity.ageWindow,
    identity.publishedFrom,
    identity.publishedTo,
    identity.editorialConstraint,
    [...identity.pillarEmphasis].sort(),
    [...identity.formatEmphasis].sort(),
    strategyManifestCaps.posts,
    strategyManifestCaps.statistics,
    entries.map((entry) => [
      entry.category,
      entry.rank,
      entry.evidenceType,
      entry.evidenceKey,
      entry.referenceId,
      entry.retrievalReason,
      entry.classification,
      entry.sampleSize,
      [...entry.allowedRoles].sort(),
      [...entry.dimensions].sort(),
      [...entry.allowedNumericClaims].sort(),
      createHash("sha256").update(entry.summaryText, "utf8").digest("hex"),
    ]),
  ];

  return createHash("sha256").update(JSON.stringify(canonical), "utf8").digest("hex");
}

/**
 * The signature a duplicate submit collapses onto.
 *
 * The manifest hash is the evidence, and the ordinal is the reason for asking
 * again. Without the ordinal an explicit regeneration over unchanged evidence
 * would collapse onto the first generation and silently return the old answer,
 * when the user asked for a new one.
 */
export function createStrategyRequestSignature(
  manifestHash: string,
  regenerationOrdinal: number,
): string {
  return createHash("sha256")
    .update(JSON.stringify([manifestHash, regenerationOrdinal]), "utf8")
    .digest("hex");
}

export function strategyGenerateKey(requestSignature: string): string {
  return `strategy-generate-${requestSignature}`;
}

/**
 * The text representation of the manifest that travels with the request.
 *
 * States exactly what the validator will check the response against, so a
 * rejection is the model's fault rather than a disagreement between what it was
 * shown and what it is held to. Carries no caption, no transcript, no object key
 * and no credential — a manifest is machine input, and the fields a human screen
 * shows are not the fields a prompt needs.
 */
export function renderStrategyManifest(
  identity: StrategyManifestIdentity,
  entries: readonly StrategyEvidenceEntry[],
): string {
  const lines = entries.map((entry) => {
    const parts = [
      `evidenceId=${entry.evidenceKey}`,
      `type=${entry.evidenceType}`,
      `allowedRoles=${entry.allowedRoles.join("|")}`,
      `classification=${entry.classification ?? "none"}`,
      `dimensions=${entry.dimensions.length > 0 ? entry.dimensions.join("|") : "none"}`,
    ];

    if (entry.sampleSize !== null) parts.push(`sampleSize=${String(entry.sampleSize)}`);
    parts.push(`allowedNumbersInExplanations=${entry.allowedNumericClaims.join("|") || "none"}`);
    if (entry.requiredInLimitations) parts.push("mustAppearInLimitations=true");

    return `- ${parts.join("; ")}`;
  });

  const notes = entries.map((entry) => `- ${entry.evidenceKey}: ${entry.summaryText}`);

  return `FROZEN EVIDENCE MANIFEST (untrusted data; account ${identity.instagramAccountId}, metric ${identity.primaryMetric}, observation window ${identity.ageWindow}, period ${identity.publishedFrom} to ${identity.publishedTo})

${lines.join("\n")}

Notes describing the evidence, for wording only:
${notes.join("\n")}

Any number you write inside an evidence explanation must appear in that item's allowedNumbersInExplanations list. Write no other digits in an explanation.`;
}
