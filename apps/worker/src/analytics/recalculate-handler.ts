import {
  activateAnalyticsRun,
  buildFeatureRequests,
  calculateFeatureFamily,
  createRunInputFingerprint,
  createWorkspaceContext,
  failAnalyticsRun,
  findActiveRunFingerprint,
  loadBestAnalyticsInputs,
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
  recalculationWindowCandidates,
  type QueueHandlerRegistration,
  type QueueJobEnvelope,
  type SnapshotAgeWindowKey,
} from "@studio-parallel/domain";
import { parseCorrelationId, type JsonLogger } from "@studio-parallel/observability";

/**
 * Recalculates and publishes the statistics for one scope.
 *
 * A scope is either one account or every linked account pooled, and the job's
 * resource says which. The two produce independent published sets — a pooled run
 * never replaces a per-account one — so a reader can ask what holds for an
 * account and what holds across the workspace and get two answers rather than a
 * blend.
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
 * What a pooled job names as its resource.
 *
 * The debounce markers live on `instagram_accounts`, so the pooled scope has no
 * row of its own to point at; the workspace is the only thing that identifies
 * it.
 */
export const pooledResourceType = "workspace";

/**
 * The windows a run may publish for, in the order they are offered.
 *
 * Still one window per run — the dashboard reads a single active set, and
 * publishing several would multiply the work for output nothing displays. The
 * choice is made per run rather than pinned, because a pinned `day_30` could
 * never see a post that was already older than that when its account connected,
 * and those are most of an established account's history. Offering the windows
 * costs one extra read in total, not one per window.
 */
export const recalculationAgeWindows: readonly SnapshotAgeWindowKey[] =
  recalculationWindowCandidates;

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

type RecalculationScope =
  | Readonly<{
      /** The unprocessed change this run is measuring, and all it may clear. */
      dirtySince: Date;
      instagramAccountId: string;
      kind: "account";
    }>
  /** Every linked account together. It owns no marker, so it carries no anchor. */
  | Readonly<{ kind: "pooled" }>
  /** Nothing to publish, and the reason a reader of the logs would want. */
  | Readonly<{ kind: "skip"; reasonCode: "ALREADY_CURRENT" | "NOTHING_TO_POOL" }>;

/**
 * What the job is asking to be recalculated, and — for an account — the change
 * that owes it.
 *
 * A pooled job carries the workspace rather than an account, because the
 * debounce columns live on `instagram_accounts` and the pooled scope has no row
 * of its own. It deliberately reads no marker at all: the markers belong to the
 * accounts, whose own runs are enqueued by the same sweep and clear them as they
 * publish, so a pooled run that took them as its cue would find them clear and
 * conclude it had nothing to do. Whether it is current is settled against what
 * it last published instead, once the inputs have been read.
 *
 * It does need two accounts to pool. Over one, the pooled calculation is the
 * account's own calculation wearing a different scope — and a worse one, since
 * every comparison then draws 100% of both sides from a single source and is
 * demoted for it. Publishing that would give the trends screen a second scope to
 * offer, defaulted to, on which every result reads weaker than the same numbers
 * do on the account's own.
 */
async function loadScope(
  database: DatabaseClient,
  workspace: ReturnType<typeof createWorkspaceContext>,
  job: Readonly<{ resourceId: string; resourceType: string | null }>,
): Promise<RecalculationScope> {
  if (job.resourceType === pooledResourceType) {
    // The resource is the workspace itself. A job naming another workspace's id
    // would be routed here by its envelope and read this workspace's accounts,
    // so the two have to agree before anything is read.
    if (job.resourceId !== workspace.workspaceId) {
      throw new JobHandlerFailure({
        errorClass: "INVALID_INPUT",
        errorCode: "ANALYTICS_RESOURCE_INVALID",
      });
    }

    const poolable = await database.instagramAccount.count({
      where: { connectionStatus: "ACTIVE", workspaceId: workspace.workspaceId },
    });

    return poolable < 2
      ? Object.freeze({ kind: "skip" as const, reasonCode: "NOTHING_TO_POOL" as const })
      : Object.freeze({ kind: "pooled" as const });
  }

  if (job.resourceType !== accountResourceType) {
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

  return account.analyticsDirtySince === null
    ? Object.freeze({ kind: "skip" as const, reasonCode: "ALREADY_CURRENT" as const })
    : Object.freeze({
        dirtySince: account.analyticsDirtySince,
        instagramAccountId: account.id,
        kind: "account" as const,
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
  if (!job || !job.resourceId) {
    throw new JobHandlerFailure({
      errorClass: "INVALID_INPUT",
      errorCode: "ANALYTICS_RESOURCE_INVALID",
    });
  }

  const scope = await loadScope(database, workspace, {
    resourceId: job.resourceId,
    resourceType: job.resourceType,
  });

  if (scope.kind === "skip") {
    logger.info("analytics.recalculate.skipped", {
      correlationId,
      jobId: envelope.domainJobId,
      reasonCode: scope.reasonCode,
      stage: "loading_account",
      workspaceId: workspace.workspaceId,
    });

    return Object.freeze({ commit: async () => undefined });
  }

  // An absent key is the pooled scope, not a missing value, and it has to reach
  // the reads, the run row and the activation identically — one of the three
  // disagreeing would publish a set under a scope it was not measured for. The
  // marker travels with the scope at activation because clearing one is only
  // ever an account's business.
  const accountBound =
    scope.kind === "account" ? { instagramAccountId: scope.instagramAccountId } : {};
  const activationBound =
    scope.kind === "account"
      ? { dirtySince: scope.dirtySince, instagramAccountId: scope.instagramAccountId }
      : {};

  const startedAt = now();
  const window = Object.freeze({
    ...accountBound,
    publishedFrom: new Date(startedAt.getTime() - recalculationHistoryDays * 24 * 60 * 60 * 1_000),
    publishedTo: startedAt,
  });

  await execution.recordStage("reading_inputs");

  const selection = await loadBestAnalyticsInputs(
    database,
    workspace,
    window,
    recalculationAgeWindows,
  );

  if (selection === null) {
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
        // A pooled run clears nothing, for the reason activation does not: it
        // owns no marker, and one anchor could not say which accounts' windows
        // it had consumed anyway.
        if (scope.kind !== "account") return;

        await transaction.instagramAccount.updateMany({
          data: { analyticsDirtySince: null, analyticsDueAt: null },
          where: {
            analyticsDirtySince: scope.dirtySince,
            id: scope.instagramAccountId,
            workspaceId: workspace.workspaceId,
          },
        });
      },
    });
  }

  const { inputs } = selection;
  const request: AnalyticsInputRequest = Object.freeze({
    ageWindow: selection.ageWindow,
    ...window,
  });

  // Which window won and what the others would have measured. A run that
  // publishes a different window than the last one is a change in what the
  // dashboard means, so the reason is recorded rather than inferred later.
  logger.info("analytics.recalculate.window", {
    correlationId,
    jobId: envelope.domainJobId,
    outcome: selection.ageWindow,
    reasonCode: "WINDOW_SELECTED",
    source: selection.considered
      .map((candidate) => `${candidate.ageWindow}=${String(candidate.eligiblePosts)}`)
      .join(","),
    stage: "reading_inputs",
    value: inputs.posts.length,
    workspaceId: workspace.workspaceId,
  });

  const inputFingerprint = createRunInputFingerprint({
    analysisIds: inputs.analysisIds,
    snapshotIds: inputs.snapshotIds,
  });

  // The pooled scope's answer to the question a debounce marker answers for an
  // account: it has already published exactly these inputs, so building the run
  // would collapse onto the rows it published last time and supersede itself for
  // nothing. Asked here rather than up front because the fingerprint is only
  // knowable once the inputs have been read.
  if (
    scope.kind === "pooled" &&
    (await findActiveRunFingerprint(database, workspace, null)) === inputFingerprint
  ) {
    logger.info("analytics.recalculate.skipped", {
      correlationId,
      jobId: envelope.domainJobId,
      reasonCode: "ALREADY_CURRENT",
      stage: "reading_inputs",
      workspaceId: workspace.workspaceId,
    });

    return Object.freeze({ commit: async () => undefined });
  }

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
    ...accountBound,
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
          ...activationBound,
          expectedStatisticCount,
          inputFingerprint,
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
