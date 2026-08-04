import { strategyV1Schema, type StrategyMode, type StrategyV1 } from "@studio-parallel/domain";

import type { PrismaClient } from "./generated/prisma/client.js";
import { isUuidV7 } from "./id.js";
import type { WorkspaceContext } from "./workspace-context.js";

/**
 * Reading strategies for a person rather than for a handler.
 *
 * The existing readers are all worker-scoped and resolve through a background
 * job, which is right for a handler and useless here: a reader arrives with an
 * account or a strategy id and no job at all. These read by those instead, and
 * every one of them is scoped by workspace in its `where` rather than filtered
 * afterwards, so a crafted id returns nothing rather than someone else's work.
 *
 * The stored result is parsed rather than cast. It was validated when it was
 * written, but it has been sitting in a `Json` column since, and a reader that
 * assumes its shape would turn a bad row into a runtime error inside a
 * component tree.
 */

type Executor = Pick<PrismaClient, "instagramAccount" | "strategyEvidence" | "strategyGeneration">;

const generationSelect = {
  analysedPostCount: true,
  analyticsVersion: true,
  comparablePostCount: true,
  evidenceCount: true,
  failureClass: true,
  failureCode: true,
  generatedAt: true,
  id: true,
  instagramAccountId: true,
  mode: true,
  modelVersion: true,
  primaryMetric: true,
  publicationWeekCount: true,
  publishedFrom: true,
  publishedTo: true,
  regenerationOrdinal: true,
  requestedAt: true,
  result: true,
  state: true,
  statisticsVersion: true,
  strategySchemaVersion: true,
} as const;

export type StrategySummary = Readonly<{
  analysedPostCount: number;
  comparablePostCount: number;
  evidenceCount: number;
  /** Present only on a failure, and a code rather than a message. */
  failureCode: string | null;
  generatedAt: string | null;
  id: string;
  instagramAccountId: string;
  mode: StrategyMode;
  primaryMetric: string;
  publicationWeekCount: number;
  publishedFrom: string;
  publishedTo: string;
  /** Zero for a first request, higher for an explicit regeneration. */
  regenerationOrdinal: number;
  requestedAt: string;
  state: string;
}>;

/**
 * One frozen manifest entry, as the reader needs it.
 *
 * `referenceId` is the row the entry stands on, whichever kind it is, so a
 * screen can build one link without knowing five column names. It is null for
 * `data_quality`, which is synthesised from the sample rather than read from a
 * row and therefore has nothing to open.
 */
export type StrategyEvidenceEntry = Readonly<{
  category: string;
  evidenceKey: string;
  evidenceType: string;
  referenceId: string | null;
  summaryText: string;
}>;

export type StrategyDetail = Readonly<{
  analyticsVersion: string;
  /** The manifest this strategy was allowed to argue from, keyed by the ids it cites. */
  evidence: readonly StrategyEvidenceEntry[];
  modelVersion: string | null;
  /** Null while the strategy is pending, failed, or stored in a shape this version cannot read. */
  strategy: StrategyV1 | null;
  strategySchemaVersion: string;
  statisticsVersion: string;
  summary: StrategySummary;
}>;

type GenerationRow = Readonly<{
  analysedPostCount: number;
  analyticsVersion: string;
  comparablePostCount: number;
  evidenceCount: number;
  failureClass: string | null;
  failureCode: string | null;
  generatedAt: Date | null;
  id: string;
  instagramAccountId: string;
  mode: string;
  modelVersion: string | null;
  primaryMetric: string;
  publicationWeekCount: number;
  publishedFrom: Date;
  publishedTo: Date;
  regenerationOrdinal: number;
  requestedAt: Date;
  result: unknown;
  state: string;
  statisticsVersion: string;
  strategySchemaVersion: string;
}>;

function toSummary(row: GenerationRow): StrategySummary {
  return Object.freeze({
    analysedPostCount: row.analysedPostCount,
    comparablePostCount: row.comparablePostCount,
    evidenceCount: row.evidenceCount,
    failureCode: row.failureCode,
    generatedAt: row.generatedAt === null ? null : row.generatedAt.toISOString(),
    id: row.id,
    instagramAccountId: row.instagramAccountId,
    mode: row.mode.toLowerCase() as StrategyMode,
    primaryMetric: row.primaryMetric,
    publicationWeekCount: row.publicationWeekCount,
    publishedFrom: row.publishedFrom.toISOString(),
    publishedTo: row.publishedTo.toISOString(),
    regenerationOrdinal: row.regenerationOrdinal,
    requestedAt: row.requestedAt.toISOString(),
    state: row.state,
  });
}

/**
 * The stored result, or null when it cannot be read as this contract.
 *
 * A strategy written under an older schema version is not rendered as if it
 * were current. Returning null puts the screen into its "cannot display this"
 * path, which is a statement a reader can act on, rather than a component
 * failing part-way through a section.
 */
function toStrategy(result: unknown): StrategyV1 | null {
  if (result === null || result === undefined) return null;

  const parsed = strategyV1Schema.safeParse(result);
  return parsed.success ? parsed.data : null;
}

const evidenceSelect = {
  category: true,
  evidenceKey: true,
  evidenceType: true,
  featureStatisticId: true,
  instagramPostId: true,
  metricSnapshotId: true,
  postAnalysisId: true,
  sourceGenerationId: true,
  summaryText: true,
} as const;

type EvidenceRow = Readonly<{
  category: string;
  evidenceKey: string;
  evidenceType: string;
  featureStatisticId: string | null;
  instagramPostId: string | null;
  metricSnapshotId: string | null;
  postAnalysisId: string | null;
  sourceGenerationId: string | null;
  summaryText: string;
}>;

function toEvidenceEntry(row: EvidenceRow): StrategyEvidenceEntry {
  return Object.freeze({
    category: row.category.toLowerCase(),
    evidenceKey: row.evidenceKey,
    evidenceType: row.evidenceType.toLowerCase(),
    referenceId:
      row.featureStatisticId ??
      row.instagramPostId ??
      row.postAnalysisId ??
      row.metricSnapshotId ??
      row.sourceGenerationId,
    summaryText: row.summaryText,
  });
}

/**
 * The manifest a generation was frozen against.
 *
 * Read separately from the result rather than joined into it, because a
 * generation that has not finished still has a manifest: it is written in the
 * same transaction as the job, before the model is ever called.
 */
async function readEvidence(
  executor: Executor,
  context: WorkspaceContext,
  strategyGenerationId: string,
): Promise<readonly StrategyEvidenceEntry[]> {
  const rows = await executor.strategyEvidence.findMany({
    orderBy: [{ category: "asc" }, { rank: "asc" }],
    select: evidenceSelect,
    where: { strategyGenerationId, workspaceId: context.workspaceId },
  });

  return Object.freeze(rows.map((row) => toEvidenceEntry(row as EvidenceRow)));
}

function toDetail(row: GenerationRow, evidence: readonly StrategyEvidenceEntry[]): StrategyDetail {
  return Object.freeze({
    analyticsVersion: row.analyticsVersion,
    evidence,
    modelVersion: row.modelVersion,
    statisticsVersion: row.statisticsVersion,
    strategy: toStrategy(row.result),
    strategySchemaVersion: row.strategySchemaVersion,
    summary: toSummary(row),
  });
}

/**
 * The strategy an account currently stands behind.
 *
 * Resolved through the account's own pointer rather than by taking the newest
 * generation, so a failed or still-running request never displaces the one a
 * reader was last shown.
 */
export async function loadCurrentStrategy(
  executor: Executor,
  context: WorkspaceContext,
  instagramAccountId: string,
): Promise<StrategyDetail | null> {
  if (!isUuidV7(instagramAccountId)) return null;

  const account = await executor.instagramAccount.findFirst({
    select: { currentStrategy: { select: generationSelect } },
    where: { id: instagramAccountId, workspaceId: context.workspaceId },
  });

  const current = account?.currentStrategy;
  if (!current) return null;

  const row = current as GenerationRow;
  return toDetail(row, await readEvidence(executor, context, row.id));
}

/**
 * Every generation an account has requested, newest first.
 *
 * Pending and failed requests are included. A history that showed only what
 * succeeded would leave a reader unable to tell "nothing was asked for" from
 * "it was asked for and did not work", which is the question history exists to
 * answer.
 */
export async function listStrategyGenerations(
  executor: Executor,
  context: WorkspaceContext,
  input: Readonly<{ instagramAccountId: string; limit?: number }>,
): Promise<readonly StrategySummary[]> {
  if (!isUuidV7(input.instagramAccountId)) return Object.freeze([]);

  const rows = await executor.strategyGeneration.findMany({
    orderBy: [{ requestedAt: "desc" }, { id: "desc" }],
    select: generationSelect,
    take: Math.min(Math.max(input.limit ?? strategyHistoryLimit, 1), 100),
    where: {
      instagramAccountId: input.instagramAccountId,
      workspaceId: context.workspaceId,
    },
  });

  return Object.freeze(rows.map((row) => toSummary(row as GenerationRow)));
}

/** Generations a history page shows before it needs paging. */
export const strategyHistoryLimit = 20;

/**
 * One generation by its own id.
 *
 * Null covers both "no such strategy" and "not this workspace's", which is what
 * a reader is told either way: a crafted id must not be distinguishable from a
 * missing one.
 */
export async function loadStrategyGeneration(
  executor: Executor,
  context: WorkspaceContext,
  strategyGenerationId: string,
): Promise<StrategyDetail | null> {
  if (!isUuidV7(strategyGenerationId)) return null;

  const row = await executor.strategyGeneration.findFirst({
    select: generationSelect,
    where: { id: strategyGenerationId, workspaceId: context.workspaceId },
  });

  if (!row) return null;

  return toDetail(
    row as GenerationRow,
    await readEvidence(executor, context, strategyGenerationId),
  );
}
