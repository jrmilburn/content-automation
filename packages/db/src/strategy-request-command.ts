import {
  createStrategyRequestSignature,
  evaluateStrategyEligibility,
  strategyGenerateKey,
  type DerivedMetric,
  type StrategyMode,
  type StrategyRefusalReason,
} from "@studio-parallel/domain";

import { enqueueBackgroundJobInTransaction } from "./background-jobs.js";
import type { PrismaClient } from "./generated/prisma/client.js";
import { createId } from "./id.js";
import {
  buildStrategyManifest,
  loadStrategyEvidenceCandidates,
  strategyContractColumns,
  writeStrategyEvidence,
  type StrategyEvidenceCandidates,
} from "./strategy-evidence.js";
import type { WorkspaceContext } from "./workspace-context.js";

/**
 * Asking for one strategy, and freezing what it may argue from.
 *
 * The enqueue, the generation and every evidence row are written in one
 * transaction, so a job can never exist without the record of what it was asked
 * to reason over. Splitting them would leave a handler holding a generation ID
 * and an empty manifest, which the model would answer anyway.
 *
 * Duplicate submits collapse on the background job's idempotency key, derived
 * from the manifest hash and the regeneration ordinal. Two people asking for the
 * same strategy over the same evidence produce one job and one provider call; an
 * explicit regeneration is a different ordinal and therefore a different
 * request, even though the evidence has not moved.
 */

/** How far back a request reads by default, in publication days. */
export const strategyDefaultPeriodDays = 180;

export type StrategyRequestInput = Readonly<{
  acceptExploratory: boolean;
  correlationId: string;
  editorialConstraint: string | null;
  formatEmphasis: readonly string[];
  instagramAccountId: string;
  pillarEmphasis: readonly string[];
  primaryMetric: DerivedMetric;
  regeneratedFromId?: string | null;
  requestedByUserId: string | null;
}>;

export type StrategyRequestPreview = Readonly<{
  ageWindow: string | null;
  analysedPostCount: number;
  comparablePostCount: number;
  /** The mode a request would run as, or null when it would be refused. */
  mode: StrategyMode | null;
  publicationWeekCount: number;
  reason: StrategyRefusalReason | null;
  /** Windows the evidence covers, which is the run's rather than the request's. */
  publishedFrom: string | null;
  publishedTo: string | null;
}>;

export type StrategyRequestOutcome =
  | Readonly<{
      backgroundJobId: string;
      /** False when this request already existed. */
      created: boolean;
      manifestHash: string;
      mode: StrategyMode;
      requested: true;
      strategyGenerationId: string;
    }>
  | Readonly<{ reason: StrategyRefusalReason; requested: false }>;

async function readEligibility(
  database: PrismaClient,
  context: WorkspaceContext,
  input: Readonly<{
    acceptExploratory: boolean;
    instagramAccountId: string;
    primaryMetric: DerivedMetric;
  }>,
): Promise<
  Readonly<{
    decision: ReturnType<typeof evaluateStrategyEligibility>;
    loaded: StrategyEvidenceCandidates | null;
  }>
> {
  const account = await database.instagramAccount.findFirst({
    select: { analyticsDirtySince: true, id: true },
    where: { id: input.instagramAccountId, workspaceId: context.workspaceId },
  });

  if (!account) {
    return Object.freeze({
      decision: evaluateStrategyEligibility({
        acceptExploratory: input.acceptExploratory,
        activeRunId: null,
        analysedPostCount: 0,
        analyticsDirty: false,
        comparablePostCount: 0,
        instagramAccountId: null,
        primaryMetric: input.primaryMetric,
        publicationWeekCount: 0,
      }),
      loaded: null,
    });
  }

  const loaded = await loadStrategyEvidenceCandidates(database, context, {
    formatEmphasis: [],
    instagramAccountId: account.id,
    pillarEmphasis: [],
    primaryMetric: input.primaryMetric,
  });

  return Object.freeze({
    decision: evaluateStrategyEligibility({
      acceptExploratory: input.acceptExploratory,
      activeRunId: loaded?.analyticsRunId ?? null,
      analysedPostCount: loaded?.counts.analysedPostCount ?? 0,
      analyticsDirty: account.analyticsDirtySince !== null,
      comparablePostCount: loaded?.counts.comparablePostCount ?? 0,
      instagramAccountId: account.id,
      primaryMetric: input.primaryMetric,
      publicationWeekCount: loaded?.counts.publicationWeekCount ?? 0,
    }),
    loaded,
  });
}

/**
 * What a request would produce, without writing anything.
 *
 * Exists so the screen can say "this will be exploratory" before the user
 * commits, rather than after. Reads the same counts through the same functions
 * the request itself uses, so a preview and the generation that follows it
 * cannot disagree about whether the account had enough evidence.
 */
export async function previewStrategyRequest(
  database: PrismaClient,
  context: WorkspaceContext,
  input: Readonly<{
    acceptExploratory: boolean;
    instagramAccountId: string;
    primaryMetric: DerivedMetric;
  }>,
): Promise<StrategyRequestPreview> {
  const { decision, loaded } = await readEligibility(database, context, input);

  return Object.freeze({
    ageWindow: loaded?.ageWindow ?? null,
    analysedPostCount: loaded?.counts.analysedPostCount ?? 0,
    comparablePostCount: loaded?.counts.comparablePostCount ?? 0,
    mode: decision.mode,
    publicationWeekCount: loaded?.counts.publicationWeekCount ?? 0,
    publishedFrom: loaded?.publishedFrom.toISOString() ?? null,
    publishedTo: loaded?.publishedTo.toISOString() ?? null,
    reason: decision.eligible ? null : decision.reason,
  });
}

/**
 * Freezes a manifest and queues the generation that will argue from it.
 *
 * The evidence is resolved here rather than by the handler, so what was asked
 * for is fixed at the moment of asking. A recalculation landing a minute later
 * is a different question and needs its own request — which is exactly what the
 * manifest hash makes it.
 */
export async function requestStrategyGeneration(
  database: PrismaClient,
  context: WorkspaceContext,
  input: StrategyRequestInput,
): Promise<StrategyRequestOutcome> {
  const { decision, loaded } = await readEligibility(database, context, {
    acceptExploratory: input.acceptExploratory,
    instagramAccountId: input.instagramAccountId,
    primaryMetric: input.primaryMetric,
  });

  // Refused before the transaction opens, so nothing is enqueued and no
  // background job row exists for a request that produced no model call.
  if (!decision.eligible || loaded === null) {
    return Object.freeze({
      reason: decision.eligible ? "no_active_calculation" : decision.reason,
      requested: false as const,
    });
  }

  const withEmphasis = await loadStrategyEvidenceCandidates(database, context, {
    formatEmphasis: input.formatEmphasis,
    instagramAccountId: input.instagramAccountId,
    pillarEmphasis: input.pillarEmphasis,
    primaryMetric: input.primaryMetric,
  });

  if (withEmphasis === null) {
    return Object.freeze({ reason: "no_active_calculation" as const, requested: false as const });
  }

  const manifest = buildStrategyManifest(withEmphasis, {
    editorialConstraint: input.editorialConstraint,
    formatEmphasis: input.formatEmphasis,
    instagramAccountId: input.instagramAccountId,
    mode: decision.mode,
    pillarEmphasis: input.pillarEmphasis,
    primaryMetric: input.primaryMetric,
  });

  const regenerationOrdinal = await nextRegenerationOrdinal(database, context, {
    instagramAccountId: input.instagramAccountId,
    manifestHash: manifest.manifestHash,
    // An explicit regeneration is a new question about unchanged evidence, so it
    // takes the next ordinal. Anything else keeps the ordinal it had, which is
    // what makes a duplicate submit collapse onto the request it repeats.
    regenerate: (input.regeneratedFromId ?? null) !== null,
  });
  const requestSignature = createStrategyRequestSignature(
    manifest.manifestHash,
    regenerationOrdinal,
  );

  const existing = await database.strategyGeneration.findFirst({
    select: { backgroundJobId: true, id: true },
    where: { requestSignature, workspaceId: context.workspaceId },
  });

  if (existing) {
    return Object.freeze({
      backgroundJobId: existing.backgroundJobId,
      created: false,
      manifestHash: manifest.manifestHash,
      mode: decision.mode,
      requested: true as const,
      strategyGenerationId: existing.id,
    });
  }

  const now = new Date();
  const entries = manifest.entries;

  return database.$transaction(
    async (transaction) => {
      const enqueued = await enqueueBackgroundJobInTransaction(transaction, context, {
        correlationId: input.correlationId,
        handlerVersion: 1,
        idempotencyKey: strategyGenerateKey(requestSignature),
        queueName: "strategy.generate",
        resourceId: input.instagramAccountId,
        resourceType: "instagram_account",
      });

      const strategyGenerationId = createId();

      await transaction.strategyGeneration.create({
        data: {
          account: {
            connect: {
              workspaceId_id: { id: input.instagramAccountId, workspaceId: context.workspaceId },
            },
          },
          ageWindow: withEmphasis.ageWindow,
          analysedPostCount: withEmphasis.counts.analysedPostCount,
          analysisSchemaVersion: manifest.identity.analysisSchemaVersion,
          analyticsRun: {
            connect: {
              workspaceId_id: {
                id: withEmphasis.analyticsRunId,
                workspaceId: context.workspaceId,
              },
            },
          },
          analyticsVersion: manifest.identity.analyticsVersion,
          backgroundJob: {
            connect: { workspaceId_id: { id: enqueued.job.id, workspaceId: context.workspaceId } },
          },
          cohortVersion: manifest.identity.cohortVersion,
          comparablePostCount: withEmphasis.counts.comparablePostCount,
          correlationId: input.correlationId,
          editorialConstraint: input.editorialConstraint,
          estimatedInputTokens: manifest.estimatedInputTokens,
          evidenceCount: entries.length,
          formatEmphasis: [...input.formatEmphasis],
          frozenAt: now,
          id: strategyGenerationId,
          manifestHash: manifest.manifestHash,
          modelRequested: strategyContractColumns.modelRequested,
          mode: decision.mode === "evidence_led" ? "EVIDENCE_LED" : "EXPLORATORY",
          pillarEmphasis: [...input.pillarEmphasis],
          postEvidenceCount: entries.filter((entry) => entry.evidenceType === "post").length,
          primaryMetric: input.primaryMetric,
          publicationWeekCount: withEmphasis.counts.publicationWeekCount,
          publishedFrom: withEmphasis.publishedFrom,
          publishedTo: withEmphasis.publishedTo,
          regenerationOrdinal,
          requestSignature,
          requestedAt: now,
          requestedPeriodDays: strategyDefaultPeriodDays,
          retrievalVersion: strategyContractColumns.retrievalVersion,
          statisticEvidenceCount: entries.filter(
            (entry) => entry.evidenceType === "feature_statistic",
          ).length,
          statisticsVersion: manifest.identity.statisticsVersion,
          strategyPromptSha256: strategyContractColumns.strategyPromptSha256,
          strategyPromptVersion: strategyContractColumns.strategyPromptVersion,
          strategySchemaSha256: strategyContractColumns.strategySchemaSha256,
          strategySchemaVersion: strategyContractColumns.strategySchemaVersion,
          workspace: { connect: { id: context.workspaceId } },
          ...(input.requestedByUserId
            ? {
                requestedByUser: {
                  connect: {
                    workspaceId_id: {
                      id: input.requestedByUserId,
                      workspaceId: context.workspaceId,
                    },
                  },
                },
              }
            : {}),
          ...(input.regeneratedFromId
            ? {
                regeneratedFrom: {
                  connect: {
                    workspaceId_id: {
                      id: input.regeneratedFromId,
                      workspaceId: context.workspaceId,
                    },
                  },
                },
              }
            : {}),
        },
      });

      await writeStrategyEvidence(transaction, context, { entries, strategyGenerationId });

      return Object.freeze({
        backgroundJobId: enqueued.job.id,
        created: enqueued.created,
        manifestHash: manifest.manifestHash,
        mode: decision.mode,
        requested: true as const,
        strategyGenerationId,
      });
    },
    // Stated rather than defaulted. Prisma closes an interactive transaction
    // after five seconds, and this one crosses the network for the job, the
    // generation and the evidence: on the default it failed from the deployed
    // region on latency alone, and the raw `P2028` reached the reader as an
    // unexplained 500. Batching the evidence brought the work well inside the
    // default, so this is the margin for a slow connection rather than the
    // budget the request is designed to spend.
    { maxWait: 10_000, timeout: 20_000 },
  );
}

/**
 * The ordinal a new request takes for this evidence.
 *
 * Counts generations that already froze the same manifest. A first request is
 * zero; an explicit regeneration over evidence that has not moved is one more
 * than the last, which is what stops it collapsing onto the answer it was asked
 * to replace.
 */
async function nextRegenerationOrdinal(
  database: PrismaClient,
  context: WorkspaceContext,
  input: Readonly<{ instagramAccountId: string; manifestHash: string; regenerate: boolean }>,
): Promise<number> {
  const previous = await database.strategyGeneration.findFirst({
    orderBy: { regenerationOrdinal: "desc" },
    select: { regenerationOrdinal: true },
    where: {
      instagramAccountId: input.instagramAccountId,
      manifestHash: input.manifestHash,
      workspaceId: context.workspaceId,
    },
  });

  if (previous === null) return 0;

  return input.regenerate ? previous.regenerationOrdinal + 1 : previous.regenerationOrdinal;
}
