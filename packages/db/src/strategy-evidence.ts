import { createHash } from "node:crypto";

import {
  analysisSchemaVersion,
  analyticsVersion,
  businessProfileVersion,
  cohortSelectionVersion,
  createStrategyManifestHash,
  estimateStrategyPromptTokens,
  renderStrategyManifest,
  selectStrategyEvidence,
  strategyContractArtifacts,
  strategyManifestCaps,
  strategyModelRequested,
  strategyPromptVersion,
  strategyRetrievalVersion,
  strategySchemaVersion,
  statisticsVersion,
  type DerivedMetric,
  type StrategyClaimDimension,
  type StrategyEvidenceCandidate,
  type StrategyEvidenceEntry,
  type StrategyEvidenceRole,
  type StrategyManifestIdentity,
  type StrategyMode,
} from "@studio-parallel/domain";

import type { PrismaClient } from "./generated/prisma/client.js";
import { createId } from "./id.js";
import type { WorkspaceContext } from "./workspace-context.js";

/**
 * Reading the evidence one strategy request is allowed to argue from, and
 * freezing it.
 *
 * Every read is scoped to the account and the workspace, and every row selected
 * belongs to the one ACTIVE calculation run. That is what makes "which numbers
 * did this strategy see" answerable later: the run pins the statistics, the
 * statistics pin their posts, and none of it moves once frozen.
 *
 * The ranking itself is not here. This module reads rows and hands them to the
 * pure selector, so the caps, the deduplication and the ordering can be proven
 * without a database — and so a change in what the model is shown is a change in
 * one place rather than in whichever query happened to sort differently.
 */

/** Feature paths to the claim dimension the contract names them by. */
const featureDimensions: Readonly<Record<string, StrategyClaimDimension>> = Object.freeze({
  "callToAction.type": "cta",
  "content.contentFormat": "format",
  "content.contentPillar": "content_pillar",
  "content.durationBand": "duration",
  "content.hook.category": "hook",
  "content.presenterMode": "presenter_mode",
});

/** Confidence column back to the contract's evidence class. */
const evidenceClasses = Object.freeze({
  INSUFFICIENT_EVIDENCE: "insufficient_evidence",
  MODERATE_ASSOCIATION: "moderate_association",
  SINGLE_POST_OUTLIER: "single_post_outlier",
  STATISTICALLY_SUPPORTED_ASSOCIATION: "statistically_supported_association",
  WEAK_DIRECTIONAL_SIGNAL: "weak_directional_signal",
} as const);

type ConfidenceColumn = keyof typeof evidenceClasses;

/** Recent posts read for context. Bounded above the manifest's own cap. */
const strategyEvidenceRecentPosts = strategyManifestCaps.posts;

const supportingRoles: readonly StrategyEvidenceRole[] = Object.freeze(["supporting", "context"]);
const counterRoles: readonly StrategyEvidenceRole[] = Object.freeze(["counterexample", "context"]);
const contextRoles: readonly StrategyEvidenceRole[] = Object.freeze(["context"]);
const limitationRoles: readonly StrategyEvidenceRole[] = Object.freeze(["limitation"]);

function dimensionFor(featurePath: string): readonly StrategyClaimDimension[] {
  const dimension = featureDimensions[featurePath];
  return Object.freeze([dimension ?? "other"]);
}

function round(value: number, places: number): string {
  return value.toFixed(places);
}

export type StrategyEvidenceRequest = Readonly<{
  formatEmphasis: readonly string[];
  instagramAccountId: string;
  pillarEmphasis: readonly string[];
  primaryMetric: DerivedMetric;
}>;

export type StrategyEvidenceCounts = Readonly<{
  analysedPostCount: number;
  comparablePostCount: number;
  publicationWeekCount: number;
}>;

export type StrategyEvidenceCandidates = Readonly<{
  ageWindow: string;
  analyticsRunId: string;
  candidates: readonly StrategyEvidenceCandidate[];
  counts: StrategyEvidenceCounts;
  publishedFrom: Date;
  publishedTo: Date;
}>;

/**
 * Every record a manifest may be built from, before any cap is applied.
 *
 * Reads the ACTIVE run rather than the statistics table directly. A statistic
 * exists for every calculation that ever wrote one, and only the run's
 * membership says which of them are current — selecting without it would let a
 * strategy cite a superseded number that no screen still shows.
 */
export async function loadStrategyEvidenceCandidates(
  database: PrismaClient,
  context: WorkspaceContext,
  request: StrategyEvidenceRequest,
): Promise<StrategyEvidenceCandidates | null> {
  const run = await database.accountAnalyticsRun.findFirst({
    select: {
      ageWindow: true,
      analysisCount: true,
      id: true,
      publishedFrom: true,
      publishedTo: true,
    },
    where: {
      instagramAccountId: request.instagramAccountId,
      state: "ACTIVE",
      workspaceId: context.workspaceId,
    },
  });

  if (run === null) return null;

  const published = await database.accountAnalyticsRunStatistic.findMany({
    select: {
      statistic: {
        select: {
          classificationReason: true,
          comparisonCount: true,
          confidence: true,
          featurePath: true,
          featureValue: true,
          groupCount: true,
          id: true,
          members: { select: { instagramPostId: true, membership: true } },
          metric: true,
          missingRatio: true,
          relativeEffect: true,
          sensitivityHoldsDirection: true,
          topContributorShare: true,
        },
      },
    },
    where: {
      runId: run.id,
      statistic: { metric: request.primaryMetric },
      workspaceId: context.workspaceId,
    },
  });

  const posts = await database.instagramPost.findMany({
    orderBy: [{ publishedAt: "desc" }, { id: "desc" }],
    select: {
      currentAnalysis: {
        select: { contentFormat: true, contentPillar: true, hookCategory: true, id: true },
      },
      id: true,
      publishedAt: true,
    },
    take: strategyManifestCaps.posts * 4,
    where: {
      currentAnalysis: { analyticsEligible: true },
      instagramAccountId: request.instagramAccountId,
      publishedAt: { gte: run.publishedFrom, lte: run.publishedTo },
      workspaceId: context.workspaceId,
    },
  });

  const priorGenerations = await database.strategyGeneration.findMany({
    orderBy: [{ requestedAt: "desc" }, { id: "desc" }],
    select: { id: true, mode: true, requestedAt: true },
    take: 3,
    where: {
      instagramAccountId: request.instagramAccountId,
      state: "SUCCEEDED",
      workspaceId: context.workspaceId,
    },
  });

  const candidates: StrategyEvidenceCandidate[] = [];
  const comparablePosts = new Set<string>();

  for (const row of published) {
    const statistic = row.statistic;
    const effect = statistic.relativeEffect === null ? null : Number(statistic.relativeEffect);
    const classification = evidenceClasses[statistic.confidence as ConfidenceColumn] ?? null;
    const postIds = statistic.members.map((member) => member.instagramPostId);
    for (const postId of postIds) comparablePosts.add(postId);

    // A counterexample is a statistic that undercuts itself: the direction did
    // not survive removing a post, or one post carries the whole effect. Those
    // are the ones a strategy must not read as agreement.
    const undercuts =
      statistic.sensitivityHoldsDirection === false ||
      classification === "single_post_outlier" ||
      (statistic.topContributorShare !== null && Number(statistic.topContributorShare) > 0.5);

    const category = undercuts
      ? "counterexample"
      : effect !== null && effect < 0
        ? "negative_statistic"
        : "positive_statistic";

    candidates.push(
      Object.freeze({
        allowedNumericClaims: Object.freeze(
          effect === null ? [] : [`${round(Math.abs(effect) * 100, 1)}%`],
        ),
        allowedRoles: undercuts ? counterRoles : supportingRoles,
        category,
        classification,
        dimensions: dimensionFor(statistic.featurePath),
        evidenceType: "feature_statistic",
        postIds: Object.freeze(postIds),
        rankScore: effect === null ? null : Math.abs(effect),
        referenceId: statistic.id,
        requiredInLimitations: false,
        retrievalReason: undercuts ? "sensitivity_or_outlier" : statistic.classificationReason,
        sampleSize: statistic.groupCount,
        summaryText: `${statistic.featurePath}=${statistic.featureValue} on ${statistic.metric}: ${
          effect === null ? "no comparable effect" : `${round(effect * 100, 1)}% vs comparison`
        }; group ${String(statistic.groupCount)}, comparison ${String(statistic.comparisonCount)}`,
      }),
    );
  }

  posts.slice(0, strategyEvidenceRecentPosts).forEach((post, index) => {
    const analysis = post.currentAnalysis;
    if (!analysis) return;

    const emphasised =
      (analysis.contentPillar !== null &&
        request.pillarEmphasis.includes(analysis.contentPillar)) ||
      (analysis.contentFormat !== null && request.formatEmphasis.includes(analysis.contentFormat));

    candidates.push(
      Object.freeze({
        allowedNumericClaims: Object.freeze([]),
        allowedRoles: contextRoles,
        category: emphasised ? "comparator_post" : "recent_post",
        classification: null,
        dimensions: Object.freeze(["content_pillar"] as const),
        evidenceType: "post",
        postIds: Object.freeze([post.id]),
        // Recency is the order, newest first, and the query already sorted it.
        rankScore: -index,
        referenceId: post.id,
        requiredInLimitations: false,
        retrievalReason: emphasised ? "requested_emphasis" : "most_recent",
        sampleSize: null,
        summaryText: `published ${post.publishedAt.toISOString().slice(0, 10)}; pillar ${
          analysis.contentPillar ?? "unknown"
        }; format ${analysis.contentFormat ?? "unknown"}; hook ${analysis.hookCategory ?? "unknown"}`,
      }),
    );
  });

  priorGenerations.forEach((generation, index) => {
    candidates.push(
      Object.freeze({
        allowedNumericClaims: Object.freeze([]),
        allowedRoles: contextRoles,
        category: "recent_strategy",
        classification: null,
        dimensions: Object.freeze([]),
        evidenceType: "recent_recommendation",
        postIds: Object.freeze([]),
        rankScore: -index,
        referenceId: generation.id,
        requiredInLimitations: false,
        retrievalReason: "recent_strategy",
        sampleSize: null,
        summaryText: `a ${String(generation.mode).toLowerCase()} strategy was generated on ${generation.requestedAt.toISOString().slice(0, 10)}`,
      }),
    );
  });

  const publicationWeeks = new Set(
    posts.map(
      (post) => `${String(post.publishedAt.getUTCFullYear())}-${String(isoWeek(post.publishedAt))}`,
    ),
  );

  candidates.push(
    Object.freeze({
      allowedNumericClaims: Object.freeze([String(posts.length), String(comparablePosts.size)]),
      allowedRoles: limitationRoles,
      category: "data_quality",
      classification: null,
      dimensions: Object.freeze([]),
      evidenceType: "data_quality",
      postIds: Object.freeze([]),
      rankScore: null,
      referenceId: null,
      // Coverage is always a limitation, never optional: a strategy that does
      // not say how much of the account it could see reads as if it saw all of it.
      requiredInLimitations: true,
      retrievalReason: "coverage_summary",
      sampleSize: posts.length,
      summaryText: `${String(comparablePosts.size)} of ${String(posts.length)} analysed posts had a comparable value for ${request.primaryMetric} in the ${run.ageWindow} observation window`,
    }),
  );

  return Object.freeze({
    ageWindow: run.ageWindow,
    analyticsRunId: run.id,
    candidates: Object.freeze(candidates),
    counts: Object.freeze({
      analysedPostCount: posts.length,
      comparablePostCount: comparablePosts.size,
      publicationWeekCount: publicationWeeks.size,
    }),
    publishedFrom: run.publishedFrom,
    publishedTo: run.publishedTo,
  });
}

function isoWeek(date: Date): number {
  const utc = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = utc.getUTCDay() || 7;
  utc.setUTCDate(utc.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(utc.getUTCFullYear(), 0, 1));
  return Math.ceil(((utc.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
}

export type FrozenStrategyManifest = Readonly<{
  entries: readonly StrategyEvidenceEntry[];
  estimatedInputTokens: number;
  identity: StrategyManifestIdentity;
  manifestHash: string;
  rendered: string;
}>;

/**
 * Builds the manifest a request will be frozen with, without writing anything.
 *
 * Separate from the write so a preview can show exactly what a generation would
 * argue from, and so the hash a caller checks for a duplicate is the hash that
 * would be stored rather than an approximation of it.
 */
export function buildStrategyManifest(
  loaded: StrategyEvidenceCandidates,
  request: Readonly<{
    editorialConstraint: string | null;
    formatEmphasis: readonly string[];
    instagramAccountId: string;
    mode: StrategyMode;
    pillarEmphasis: readonly string[];
    primaryMetric: DerivedMetric;
  }>,
): FrozenStrategyManifest {
  const selection = selectStrategyEvidence(loaded.candidates);

  const identity: StrategyManifestIdentity = Object.freeze({
    ageWindow: loaded.ageWindow,
    analysisSchemaVersion,
    analyticsRunId: loaded.analyticsRunId,
    analyticsVersion,
    cohortVersion: cohortSelectionVersion,
    editorialConstraint: request.editorialConstraint,
    formatEmphasis: Object.freeze([...request.formatEmphasis]),
    instagramAccountId: request.instagramAccountId,
    mode: request.mode,
    pillarEmphasis: Object.freeze([...request.pillarEmphasis]),
    primaryMetric: request.primaryMetric,
    publishedFrom: loaded.publishedFrom.toISOString(),
    publishedTo: loaded.publishedTo.toISOString(),
    statisticsVersion,
  });

  const rendered = renderStrategyManifest(identity, selection.entries);

  return Object.freeze({
    entries: selection.entries,
    estimatedInputTokens: estimateStrategyPromptTokens(rendered),
    identity,
    manifestHash: createStrategyManifestHash(identity, selection.entries),
    rendered,
  });
}

/** The reference column one evidence type writes into. */
function referenceColumns(entry: StrategyEvidenceEntry): Record<string, string> {
  if (entry.referenceId === null) return {};

  switch (entry.evidenceType) {
    case "feature_statistic":
      return { featureStatisticId: entry.referenceId };
    case "post_analysis":
      return { postAnalysisId: entry.referenceId };
    case "metric_snapshot":
      return { metricSnapshotId: entry.referenceId };
    case "post":
      return { instagramPostId: entry.referenceId };
    case "recent_recommendation":
      return { sourceGenerationId: entry.referenceId };
    default:
      return {};
  }
}

export type StrategyEvidenceRow = Readonly<{
  entry: StrategyEvidenceEntry;
  summaryHash: string;
}>;

/**
 * Writes the evidence rows of one generation.
 *
 * Called inside the same transaction as the generation and its job, so a
 * generation can never exist without the record of what it was asked to reason
 * over.
 *
 * One statement rather than one per entry. Written as a loop of `create` calls,
 * this cost a network round trip per row inside an interactive transaction that
 * Prisma closes after five seconds by default — and a manifest holds up to
 * several dozen entries. Against the Supabase pooler a request measured 4.9
 * seconds for 25 entries, so the transaction was passing on latency alone and
 * failing whenever the connection was slower, which is what it was doing from
 * the deployed region. The failure arrives as a raw `P2028`, not an
 * `OperationalError`, so it reached the reader as an unexplained 500.
 *
 * `createMany` cannot use `connect`, so the five composite relations are set as
 * scalar columns. The pairing is still enforced: every relation is keyed on
 * `workspaceId` with the reference, and the row carries the same `workspaceId`
 * it is written under, so a foreign key from another workspace cannot resolve.
 */
export async function writeStrategyEvidence(
  transaction: Pick<PrismaClient, "strategyEvidence">,
  context: WorkspaceContext,
  input: Readonly<{ entries: readonly StrategyEvidenceEntry[]; strategyGenerationId: string }>,
): Promise<number> {
  if (input.entries.length === 0) return 0;

  const { count } = await transaction.strategyEvidence.createMany({
    data: input.entries.map((entry) => ({
      allowedNumericClaims: [...entry.allowedNumericClaims],
      allowedRoles: [...entry.allowedRoles],
      category: toColumn(entry.category) as never,
      classification:
        entry.classification === null ? null : (toColumn(entry.classification) as never),
      dimensions: [...entry.dimensions],
      evidenceKey: entry.evidenceKey,
      evidenceType: toColumn(entry.evidenceType) as never,
      id: createId(),
      rank: entry.rank,
      rankScore: entry.rankScore,
      requiredInLimitations: entry.requiredInLimitations,
      retrievalReason: entry.retrievalReason,
      sampleSize: entry.sampleSize,
      strategyGenerationId: input.strategyGenerationId,
      summaryHash: hashSummary(entry.summaryText),
      summaryText: entry.summaryText,
      workspaceId: context.workspaceId,
      ...referenceColumns(entry),
    })),
  });

  return count;
}

function hashSummary(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/**
 * The contract is lower case and every column is upper case.
 *
 * Converted at the boundary rather than compared, the same way the confidence
 * columns already are: comparing them unconverted matches nothing, and the
 * failure is silent because an empty result reads exactly like no evidence.
 */
function toColumn(value: string): string {
  return value.toUpperCase();
}

export const strategyContractColumns = Object.freeze({
  businessProfileVersion,
  modelRequested: strategyModelRequested,
  strategyPromptSha256: strategyContractArtifacts.prompt.sha256,
  strategyPromptVersion,
  strategySchemaSha256: strategyContractArtifacts.schema.sha256,
  strategySchemaVersion,
  retrievalVersion: strategyRetrievalVersion,
});
