import {
  activateAnalyticsRun,
  buildFeatureRequests,
  calculateFeatureFamily,
  createRunInputFingerprint,
  createWorkspaceContext,
  failAnalyticsRun,
  loadAnalyticsInputs,
  runIdempotentJobHandler,
  startAnalyticsRun,
  storeFeatureStatistics,
  type AnalyticsInputRequest,
  type DatabaseClient,
  type JobHandlerExecutionContext,
  type TransactionalJobResult,
} from "@studio-parallel/db";
import {
  JobHandlerFailure,
  type QueueHandlerRegistration,
  type QueueJobEnvelope,
  type SnapshotAgeWindowKey,
} from "@studio-parallel/domain";
import { parseCorrelationId, type JsonLogger } from "@studio-parallel/observability";

/**
 * Recalculates and publishes one account's statistics.
 *
 * Publication is the whole design. Every statistic is written under a `BUILDING`
 * run that no reader can see, and the run becomes `ACTIVE` in a single
 * transaction that supersedes the previous one. A reader therefore sees the old
 * complete set or the new complete set and never a half-written mixture, which
 * is what makes a partial failure safe: the previous set stays current and
 * nothing is deleted.
 *
 * The inputs are fingerprinted before the calculation and checked again at
 * activation. A run whose inputs moved underneath it is refused rather than
 * published, because activating it would present a set that never existed at any
 * single moment — half measured before the change and half after.
 *
 * Nothing here reads credentials or post content. The logs carry counts and IDs.
 */

export const analyticsRecalculateQueue = {
  name: "analytics.recalculate",
  version: 1,
} as const;

const accountResourceType = "instagram_account";

/**
 * The window statistics are published for.
 *
 * One window rather than all of them: the 30-day window is the one the trends
 * dashboard reads, and calculating every window per run would multiply the work
 * by the number of windows for output nothing displays yet.
 */
export const recalculationAgeWindow: SnapshotAgeWindowKey = "day_30";

/** How far back a run reads. Bounds the work as history accumulates. */
export const recalculationHistoryDays = 365;

export type AnalyticsRecalculateDependencies = Readonly<{
  acquireConcurrency?: ((signal: AbortSignal) => Promise<() => void>) | undefined;
  database: DatabaseClient;
  logger: JsonLogger;
  now?: (() => Date) | undefined;
}>;

export function createAnalyticsRecalculateHandler(
  dependencies: AnalyticsRecalculateDependencies,
): QueueHandlerRegistration {
  const now = dependencies.now ?? (() => new Date());

  return Object.freeze({
    handler: async (envelope: QueueJobEnvelope, context: { signal: AbortSignal }) => {
      const workspace = createWorkspaceContext(envelope.workspaceId);

      await runIdempotentJobHandler({
        ...(dependencies.acquireConcurrency
          ? { acquireConcurrency: dependencies.acquireConcurrency }
          : {}),
        context: workspace,
        database: dependencies.database,
        envelope,
        execute: (execution) => recalculate({ dependencies, envelope, execution, now, workspace }),
        logger: dependencies.logger,
        now,
        // A recalculation has no job-scoped result to look up. An account that
        // is still dirty genuinely needs calculating again, and treating an
        // existing active run as this job's result would skip the work that
        // dirtied it.
        resultExists: async () => false,
        signal: context.signal,
      });
    },
    queue: analyticsRecalculateQueue,
  });
}

async function recalculate(input: {
  dependencies: AnalyticsRecalculateDependencies;
  envelope: QueueJobEnvelope;
  execution: JobHandlerExecutionContext;
  now: () => Date;
  workspace: ReturnType<typeof createWorkspaceContext>;
}): Promise<TransactionalJobResult> {
  const { dependencies, envelope, execution, now, workspace } = input;
  const { database, logger } = dependencies;

  const correlationId = parseCorrelationId(envelope.correlationId);
  if (!correlationId) {
    throw new JobHandlerFailure({
      errorClass: "INVALID_INPUT",
      errorCode: "ANALYTICS_CORRELATION_INVALID",
    });
  }

  await execution.recordStage("loading_account");

  const job = await database.backgroundJob.findFirst({
    select: { resourceId: true, resourceType: true },
    where: { id: envelope.domainJobId, workspaceId: workspace.workspaceId },
  });
  if (!job || job.resourceType !== accountResourceType || !job.resourceId) {
    throw new JobHandlerFailure({
      errorClass: "INVALID_INPUT",
      errorCode: "ANALYTICS_RESOURCE_INVALID",
    });
  }

  const account = await database.instagramAccount.findFirst({
    select: { analyticsDirtySince: true, id: true },
    where: { id: job.resourceId, workspaceId: workspace.workspaceId },
  });
  if (!account) {
    throw new JobHandlerFailure({
      errorClass: "INVALID_INPUT",
      errorCode: "ANALYTICS_ACCOUNT_MISSING",
    });
  }

  // Read before the calculation and compared at activation. Clearing a marker
  // that moved while the run was building would lose the change that arrived,
  // so the value it started from is what activation is allowed to clear.
  const dirtySince = account.analyticsDirtySince;
  if (dirtySince === null) {
    // Something else already published for this account. Repeating the work
    // would produce the same set and collapse onto the same rows.
    logger.info("analytics.recalculate.skipped", {
      correlationId,
      jobId: envelope.domainJobId,
      reasonCode: "ALREADY_CURRENT",
      stage: "loading_account",
      workspaceId: workspace.workspaceId,
    });

    return Object.freeze({ commit: async () => undefined });
  }

  const startedAt = now();
  const request: AnalyticsInputRequest = Object.freeze({
    ageWindow: recalculationAgeWindow,
    instagramAccountId: account.id,
    publishedFrom: new Date(startedAt.getTime() - recalculationHistoryDays * 24 * 60 * 60 * 1_000),
    publishedTo: startedAt,
  });

  await execution.recordStage("reading_inputs");

  const inputs = await loadAnalyticsInputs(database, workspace, request);

  if (inputs.posts.length === 0) {
    // Nothing analysed yet is a normal state for a new account, not a failure.
    // The marker is cleared so the sweep stops rediscovering it every window;
    // the next analysis or snapshot dirties it again.
    logger.info("analytics.recalculate.skipped", {
      correlationId,
      jobId: envelope.domainJobId,
      reasonCode: "NO_ELIGIBLE_ANALYSES",
      stage: "reading_inputs",
      workspaceId: workspace.workspaceId,
    });

    return Object.freeze({
      commit: async (transaction) => {
        await transaction.instagramAccount.updateMany({
          data: { analyticsDirtySince: null, analyticsDueAt: null },
          where: {
            analyticsDirtySince: dirtySince,
            id: account.id,
            workspaceId: workspace.workspaceId,
          },
        });
      },
    });
  }

  const inputFingerprint = createRunInputFingerprint({
    analysisIds: inputs.analysisIds,
    snapshotIds: inputs.snapshotIds,
  });

  const families = buildFeatureRequests(request, inputs);
  const expectedStatisticCount = families.reduce(
    (total, family) => total + family.candidates.length,
    0,
  );

  await execution.recordStage("calculating");

  const run = await startAnalyticsRun(database, workspace, {
    ageWindow: request.ageWindow,
    analysisCount: inputs.posts.length,
    inputFingerprint,
    instagramAccountId: account.id,
    now: startedAt,
    publishedFrom: request.publishedFrom,
    publishedTo: request.publishedTo,
  });

  try {
    let stored = 0;

    for (const family of families) {
      await execution.throwIfCancellationRequested();
      await execution.heartbeat();

      const result = await storeFeatureStatistics(
        database,
        workspace,
        family,
        calculateFeatureFamily(family),
        startedAt,
        run.id,
      );

      stored += result.stored + result.skipped;
    }

    await execution.recordStage("activating");

    return Object.freeze({
      commit: async (transaction) => {
        const activation = await activateAnalyticsRun(transaction, workspace, {
          dirtySince,
          expectedStatisticCount,
          inputFingerprint,
          instagramAccountId: account.id,
          now: now(),
          runId: run.id,
        });

        if (!activation.activated) {
          // Refusing to publish is a correct outcome, not an error: the previous
          // complete set stays current and the account stays dirty, so the next
          // sweep runs again over the inputs as they now are.
          logger.warn("analytics.recalculate.refused", {
            correlationId,
            jobId: envelope.domainJobId,
            reasonCode: activation.reason,
            stage: "activating",
            workspaceId: workspace.workspaceId,
          });

          return;
        }

        logger.info("analytics.recalculate.published", {
          correlationId,
          jobId: envelope.domainJobId,
          stage: "activating",
          unit: "count",
          value: stored,
          workspaceId: workspace.workspaceId,
        });
      },
    });
  } catch (error) {
    // The run is marked failed outside the job's transaction, because that
    // transaction is about to roll back and the diagnostic has to survive it.
    await failAnalyticsRun(database, workspace, {
      failureCode: "CALCULATION_FAILED",
      runId: run.id,
    }).catch(() => undefined);

    throw error;
  }
}
