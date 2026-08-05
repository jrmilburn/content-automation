import {
  toStrategyManifestEvidence,
  type StrategyEvidenceCategory,
  type StrategyEvidenceEntry,
  type StrategyManifestEvidence,
  type StrategyMode,
} from "@studio-parallel/domain";

import { Prisma } from "./generated/prisma/client.js";
import type { PrismaClient } from "./generated/prisma/client.js";
import type { WorkspaceContext } from "./workspace-context.js";

/**
 * Running one frozen strategy request, and publishing what it produced.
 *
 * The handler reads its manifest back from these rows rather than rebuilding it.
 * That is the whole point of freezing: a retry two hours later must argue from
 * what the first attempt argued from, and re-running retrieval would quietly
 * substitute whatever the account looks like now. The reader is therefore the
 * only path a handler has to its evidence.
 *
 * Publication moves the account's current pointer inside the same transaction
 * that stores the result, so nothing observes an account between two current
 * strategies and a failed attempt leaves the previous one exactly where it was.
 */

type Executor = Pick<
  PrismaClient,
  "instagramAccount" | "strategyEvidence" | "strategyGeneration"
> & { $transaction?: unknown };

/** Column back to the contract's lower-case vocabulary. */
function fromColumn(value: string): string {
  return value.toLowerCase();
}

export type FrozenStrategyGeneration = Readonly<{
  ageWindow: string;
  editorialConstraint: string | null;
  entries: readonly StrategyEvidenceEntry[];
  id: string;
  /** Null for a strategy frozen against the pooled calculation across every linked account. */
  instagramAccountId: string | null;
  manifest: readonly StrategyManifestEvidence[];
  manifestHash: string;
  mode: StrategyMode;
  primaryMetric: string;
  publishedFrom: Date;
  publishedTo: Date;
  recentRecommendationFingerprints: readonly string[];
  repairAttempted: boolean;
  state: string;
}>;

/**
 * The frozen request behind one background job, with its evidence.
 *
 * Resolved through the background job rather than by ID, so a redelivered job
 * finds the same generation it was created with and cannot be pointed at
 * another account's work by a crafted payload.
 */
export async function findStrategyGenerationForJob(
  executor: Executor,
  context: WorkspaceContext,
  backgroundJobId: string,
): Promise<FrozenStrategyGeneration | null> {
  const generation = await executor.strategyGeneration.findFirst({
    select: {
      ageWindow: true,
      editorialConstraint: true,
      evidence: {
        orderBy: [{ category: "asc" }, { rank: "asc" }],
        select: {
          allowedNumericClaims: true,
          allowedRoles: true,
          category: true,
          classification: true,
          dimensions: true,
          evidenceKey: true,
          evidenceType: true,
          rank: true,
          rankScore: true,
          requiredInLimitations: true,
          retrievalReason: true,
          sampleSize: true,
          summaryText: true,
        },
      },
      id: true,
      instagramAccountId: true,
      manifestHash: true,
      mode: true,
      primaryMetric: true,
      publishedFrom: true,
      publishedTo: true,
      repairAttempted: true,
      state: true,
    },
    where: { backgroundJobId, workspaceId: context.workspaceId },
  });

  if (generation === null) return null;

  // Rank within category is the stored order, and the manifest was written in
  // category precedence order, so reading it back in that order reproduces the
  // sequence the request was frozen with.
  const entries: StrategyEvidenceEntry[] = generation.evidence.map((row) =>
    Object.freeze({
      allowedNumericClaims: Object.freeze([...row.allowedNumericClaims]),
      allowedRoles: Object.freeze(
        row.allowedRoles.map((role) => fromColumn(role)),
      ) as StrategyEvidenceEntry["allowedRoles"],
      category: fromColumn(row.category) as StrategyEvidenceCategory,
      classification:
        row.classification === null
          ? null
          : (fromColumn(row.classification) as StrategyEvidenceEntry["classification"]),
      dimensions: Object.freeze([...row.dimensions]) as StrategyEvidenceEntry["dimensions"],
      evidenceKey: row.evidenceKey,
      evidenceType: fromColumn(row.evidenceType) as StrategyEvidenceEntry["evidenceType"],
      postIds: Object.freeze([]),
      rank: row.rank,
      rankScore: row.rankScore === null ? null : Number(row.rankScore),
      referenceId: null,
      requiredInLimitations: row.requiredInLimitations,
      retrievalReason: row.retrievalReason,
      sampleSize: row.sampleSize,
      summaryText: row.summaryText,
    }),
  );

  // Ideas the last few strategies already proposed. Passed to validation so a
  // new one is refused for repeating them rather than quietly duplicating.
  const priorFingerprints = await executor.strategyGeneration.findMany({
    orderBy: [{ requestedAt: "desc" }, { id: "desc" }],
    select: { recommendationFingerprints: true },
    take: 3,
    where: {
      id: { not: generation.id },
      instagramAccountId: generation.instagramAccountId,
      state: "SUCCEEDED",
      workspaceId: context.workspaceId,
    },
  });

  return Object.freeze({
    ageWindow: generation.ageWindow,
    editorialConstraint: generation.editorialConstraint,
    entries: Object.freeze(entries),
    id: generation.id,
    instagramAccountId: generation.instagramAccountId,
    manifest: Object.freeze(entries.map((entry) => toStrategyManifestEvidence(entry))),
    manifestHash: generation.manifestHash,
    mode: fromColumn(generation.mode) as StrategyMode,
    primaryMetric: generation.primaryMetric,
    publishedFrom: generation.publishedFrom,
    publishedTo: generation.publishedTo,
    recentRecommendationFingerprints: Object.freeze(
      priorFingerprints.flatMap((row) => row.recommendationFingerprints).slice(0, 30),
    ),
    repairAttempted: generation.repairAttempted,
    state: generation.state,
  });
}

/**
 * Whether this job already produced a strategy.
 *
 * Reads the durable result rather than a marker, so a crash between the write
 * and the job's own bookkeeping still reads as done. `result` is null until a
 * generation publishes, which makes its presence the fact rather than a proxy.
 */
export async function strategyResultExistsForJob(
  executor: Executor,
  context: WorkspaceContext,
  backgroundJobId: string,
): Promise<boolean> {
  const existing = await executor.strategyGeneration.findFirst({
    select: { id: true },
    where: {
      backgroundJobId,
      result: { not: Prisma.DbNull },
      workspaceId: context.workspaceId,
    },
  });

  return existing !== null;
}

/** Records how far an attempt got, and bounds the repair to one. */
export async function recordStrategyStage(
  executor: Executor,
  context: WorkspaceContext,
  input: Readonly<{
    repairAttempted?: boolean;
    stage: "REQUESTING" | "REPAIRING" | "PUBLISHING";
    strategyGenerationId: string;
  }>,
): Promise<void> {
  await executor.strategyGeneration.updateMany({
    data: {
      ...(input.repairAttempted === undefined ? {} : { repairAttempted: input.repairAttempted }),
      stage: input.stage as never,
      state: "PROCESSING",
    },
    where: { id: input.strategyGenerationId, workspaceId: context.workspaceId },
  });
}

/** Records why an attempt produced nothing, in redacted terms only. */
export async function failStrategyGeneration(
  executor: Executor,
  context: WorkspaceContext,
  input: Readonly<{
    failureClass: string;
    failureCode: string;
    now: Date;
    strategyGenerationId: string;
  }>,
): Promise<void> {
  await executor.strategyGeneration.updateMany({
    data: {
      completedAt: input.now,
      failureClass: input.failureClass,
      failureCode: input.failureCode,
      state: "FAILED",
    },
    // Only a generation that has not published. A late failure must never
    // retract a strategy a reader has already been shown.
    where: {
      id: input.strategyGenerationId,
      result: { equals: Prisma.DbNull },
      workspaceId: context.workspaceId,
    },
  });
}

export type PublishStrategyInput = Readonly<{
  finishReason: string | null;
  generatedAt: Date;
  inputTokens: number | null;
  /** Null for a pooled strategy, which no account row stands behind. */
  instagramAccountId: string | null;
  modelVersion: string | null;
  outputTokens: number | null;
  providerLatencyMs: number | null;
  recommendationFingerprints: readonly string[];
  result: Prisma.InputJsonValue;
  strategyGenerationId: string;
  totalTokens: number | null;
}>;

export type PublishStrategyResult = Readonly<{ published: boolean }>;

/**
 * Stores one validated strategy and makes it the scope's current one.
 *
 * Idempotent by reading the result column first: a redelivered job that already
 * published finds its own row and changes nothing, rather than writing a second
 * strategy for the same request.
 */
export async function publishStrategyGeneration(
  executor: Executor,
  context: WorkspaceContext,
  input: PublishStrategyInput,
): Promise<PublishStrategyResult> {
  const existing = await executor.strategyGeneration.findFirst({
    select: { id: true },
    where: {
      id: input.strategyGenerationId,
      result: { not: Prisma.DbNull },
      workspaceId: context.workspaceId,
    },
  });

  if (existing) return Object.freeze({ published: false });

  await executor.strategyGeneration.updateMany({
    data: {
      completedAt: input.generatedAt,
      failureClass: null,
      failureCode: null,
      finishReason: input.finishReason,
      generatedAt: input.generatedAt,
      inputTokens: input.inputTokens,
      modelVersion: input.modelVersion,
      outputTokens: input.outputTokens,
      providerLatencyMs: input.providerLatencyMs,
      recommendationFingerprints: [...input.recommendationFingerprints],
      result: input.result,
      stage: "PUBLISHING" as never,
      state: "SUCCEEDED",
      totalTokens: input.totalTokens,
    },
    where: { id: input.strategyGenerationId, workspaceId: context.workspaceId },
  });

  // Same transaction as the result, so a reader never sees a published strategy
  // the account does not point at, or a pointer to a strategy with no result.
  //
  // A pooled strategy sets no pointer, because there is no row that stands for
  // "every linked account" to hold one. Its reader takes the newest SUCCEEDED
  // pooled generation instead, which the update above has just made this one.
  if (input.instagramAccountId !== null) {
    await executor.instagramAccount.updateMany({
      data: { currentStrategyId: input.strategyGenerationId },
      where: { id: input.instagramAccountId, workspaceId: context.workspaceId },
    });
  }

  return Object.freeze({ published: true });
}
