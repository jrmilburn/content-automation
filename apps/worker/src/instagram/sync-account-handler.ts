import {
  commitInstagramMediaPage,
  completeInstagramSyncRun,
  createWorkspaceContext,
  createWorkspaceRepositories,
  decryptCredential,
  failInstagramSyncRun,
  instagramSyncRunSucceededForJob,
  JobCancellationRequestedError,
  runIdempotentJobHandler,
  startInstagramSyncRun,
  type DatabaseClient,
  type JobHandlerExecutionContext,
  type TransactionalJobResult,
} from "@studio-parallel/db";
import {
  classifyJobHandlerError,
  instagramApiVersion,
  instagramBootstrapHorizonDays,
  instagramMaximumSyncPages,
  JobHandlerFailure,
  normaliseInstagramMediaItem,
  type InstagramSyncTrigger,
  type InstagramUsageObservation,
  type NormalisedInstagramMedia,
  type QueueHandlerRegistration,
  type QueueJobEnvelope,
} from "@studio-parallel/domain";
import {
  OperationalError,
  parseCorrelationId,
  type CorrelationId,
  type JsonLogger,
} from "@studio-parallel/observability";

import { fetchInstagramMediaPage, InstagramMediaError, type FetchLike } from "./media-client.js";

/**
 * Imports the authorised account's owned media under one auditable sync run.
 *
 * The credential is decrypted here and nowhere else, exists only as a local,
 * and is never logged or passed outward. Each page is normalised, then its
 * posts and the cursor that follows them commit together, so an interrupted run
 * resumes at a page boundary without duplicating or skipping media.
 */

export const instagramSyncQueue = { name: "instagram.sync.account", version: 1 } as const;

const accountResourceType = "instagram_account";
const dayMilliseconds = 86_400_000;

export type InstagramSyncDependencies = Readonly<{
  acquireConcurrency?: ((signal: AbortSignal) => Promise<() => void>) | undefined;
  database: DatabaseClient;
  fetchImplementation?: FetchLike | undefined;
  loadMasterKeys: () => ReadonlyMap<number, Buffer>;
  logger: JsonLogger;
  now?: (() => Date) | undefined;
}>;

export function createInstagramSyncAccountHandler(
  dependencies: InstagramSyncDependencies,
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
        execute: (execution) =>
          importAccountMedia({ dependencies, envelope, execution, now, workspace }),
        logger: dependencies.logger,
        now,
        resultExists: (executor) =>
          instagramSyncRunSucceededForJob(executor, workspace, envelope.domainJobId),
        signal: context.signal,
      });
    },
    queue: instagramSyncQueue,
  });
}

type ImportOptions = Readonly<{
  dependencies: InstagramSyncDependencies;
  envelope: QueueJobEnvelope;
  execution: JobHandlerExecutionContext;
  now: () => Date;
  workspace: ReturnType<typeof createWorkspaceContext>;
}>;

async function importAccountMedia(options: ImportOptions): Promise<TransactionalJobResult> {
  const { dependencies, envelope, execution, now, workspace } = options;
  const { database, logger } = dependencies;
  const correlationId = parseCorrelationId(envelope.correlationId);
  if (!correlationId) {
    throw new JobHandlerFailure({
      errorClass: "INVALID_INPUT",
      errorCode: "SYNC_CORRELATION_INVALID",
    });
  }

  await execution.recordStage("loading_account");

  const job = await database.backgroundJob.findFirst({
    select: { idempotencyKey: true, resourceId: true, resourceType: true },
    where: { id: execution.jobId, workspaceId: workspace.workspaceId },
  });
  if (!job?.resourceId || job.resourceType !== accountResourceType) {
    throw new JobHandlerFailure({
      errorClass: "INVALID_INPUT",
      errorCode: "SYNC_RESOURCE_INVALID",
    });
  }

  // Scoped by workspace, so a job carrying another workspace's account id
  // finds nothing rather than reading across the boundary.
  const account = await database.instagramAccount.findFirst({
    where: { id: job.resourceId, workspaceId: workspace.workspaceId },
  });
  if (!account) {
    throw new JobHandlerFailure({ errorClass: "INVALID_INPUT", errorCode: "SYNC_ACCOUNT_MISSING" });
  }
  if (account.connectionStatus !== "ACTIVE") {
    throw new JobHandlerFailure({
      errorClass: "CREDENTIAL",
      errorCode: "SYNC_ACCOUNT_NOT_CONNECTED",
    });
  }

  const accessToken = await readAccessToken({ account, dependencies, workspace });

  const startedAt = now();
  const trigger: InstagramSyncTrigger = account.lastSuccessfulSyncAt ? "SCHEDULED" : "BOOTSTRAP";
  const run = await startInstagramSyncRun(database, workspace, {
    apiVersion: instagramApiVersion,
    backgroundJobId: execution.jobId,
    correlationId: envelope.correlationId,
    horizonStart: new Date(startedAt.getTime() - instagramBootstrapHorizonDays * dayMilliseconds),
    idempotencyKey: job.idempotencyKey,
    instagramAccountId: account.id,
    startedAt,
    trigger,
  });

  const logContext = {
    accountId: account.id,
    correlationId,
    jobId: execution.jobId,
    workspaceId: workspace.workspaceId,
  } as const;

  try {
    // The horizon is read from the run, not recomputed, so a retry keeps the
    // window the first attempt committed against.
    await pageAccountMedia({
      accessToken,
      correlationId,
      dependencies,
      execution,
      horizonStart: run.horizonStart,
      logContext,
      now,
      providerAccountId: account.providerAccountId,
      syncRunId: run.id,
      workspace,
    });
  } catch (error) {
    if (error instanceof JobCancellationRequestedError) throw error;

    const failure = toJobFailure(error);
    await failInstagramSyncRun(database, workspace, {
      failedAt: now(),
      failureClass: failure.failure.errorClass,
      failureCode: failure.failure.errorCode,
      syncRunId: run.id,
    });
    logger.warn("instagram.sync.failed", {
      ...logContext,
      errorClass: failure.failure.errorClass,
      errorCode: failure.failure.errorCode,
      stage: "importing_media",
    });
    throw failure;
  }

  return Object.freeze({
    commit: async (transaction) => {
      await completeInstagramSyncRun(transaction, workspace, {
        completedAt: now(),
        syncRunId: run.id,
      });
    },
  });
}

async function readAccessToken(
  input: Readonly<{
    account: Readonly<{ id: string }>;
    dependencies: InstagramSyncDependencies;
    workspace: ReturnType<typeof createWorkspaceContext>;
  }>,
): Promise<string> {
  const credential = await createWorkspaceRepositories(
    input.dependencies.database,
    input.workspace,
  ).credentials.findActive({ accountId: input.account.id, integrationType: "INSTAGRAM" });

  if (!credential) {
    throw new JobHandlerFailure({
      errorClass: "CREDENTIAL",
      errorCode: "SYNC_CREDENTIAL_MISSING",
    });
  }

  let masterKeys: ReadonlyMap<number, Buffer>;
  try {
    masterKeys = input.dependencies.loadMasterKeys();
  } catch {
    // A missing or malformed deployment key is an operator problem, not a
    // reason to ask the user to reconnect a perfectly good account.
    throw new JobHandlerFailure({
      errorClass: "UNKNOWN",
      errorCode: "SYNC_ENCRYPTION_UNAVAILABLE",
    });
  }

  try {
    // The additional data binds the ciphertext to this workspace, integration
    // and account, so a credential row moved between accounts fails here.
    return decryptCredential({
      context: {
        accountId: input.account.id,
        integrationType: "INSTAGRAM",
        workspaceId: input.workspace.workspaceId,
      },
      masterKeys,
      sealed: credential.ciphertext,
    });
  } catch {
    throw new JobHandlerFailure({
      errorClass: "CREDENTIAL",
      errorCode: "SYNC_CREDENTIAL_UNREADABLE",
    });
  }
}

type PageOptions = Readonly<{
  accessToken: string;
  correlationId: CorrelationId;
  dependencies: InstagramSyncDependencies;
  execution: JobHandlerExecutionContext;
  horizonStart: Date | null;
  logContext: Readonly<{
    accountId: string;
    correlationId: CorrelationId;
    jobId: string;
    workspaceId: string;
  }>;
  now: () => Date;
  providerAccountId: string;
  syncRunId: string;
  workspace: ReturnType<typeof createWorkspaceContext>;
}>;

async function pageAccountMedia(options: PageOptions): Promise<void> {
  const { dependencies, execution, horizonStart, logContext, now, workspace } = options;
  const { database, logger } = dependencies;

  const resumed = await database.syncRun.findFirst({
    select: { cursor: true },
    where: { id: options.syncRunId, workspaceId: workspace.workspaceId },
  });

  let after = resumed?.cursor ?? null;
  let pagesVisited = 0;
  let completed = false;

  while (pagesVisited < instagramMaximumSyncPages) {
    // Extends the lease as well as recording progress; paging a large account
    // can otherwise outlast it and have the attempt reclaimed mid-run.
    await execution.heartbeat();
    await execution.recordStage("fetching_page");

    const fetched = await fetchInstagramMediaPage({
      accessToken: options.accessToken,
      after,
      fetchImplementation: dependencies.fetchImplementation,
      providerAccountId: options.providerAccountId,
    });

    const media: NormalisedInstagramMedia[] = [];
    let invalidCount = 0;
    let skippedCount = 0;
    let reachedHorizon = false;

    for (const item of fetched.page.items) {
      const normalised = normaliseInstagramMediaItem(item);

      if (!normalised.ok) {
        // One malformed item is counted and dropped; the rest of the page and
        // every page already committed are unaffected.
        invalidCount += 1;
        logger.warn("instagram.media.item_rejected", {
          ...logContext,
          reasonCode: normalised.reason,
          stage: "normalising_page",
        });
        continue;
      }

      if (horizonStart && normalised.media.publishedAt < horizonStart) {
        skippedCount += 1;
        reachedHorizon = true;
        continue;
      }

      media.push(normalised.media);
    }

    await execution.recordStage("persisting_page");
    const committed = await commitInstagramMediaPage(database, workspace, {
      cursor: fetched.page.after ?? after,
      importedAt: now(),
      invalidCount,
      media,
      rawApiVersion: instagramApiVersion,
      skippedCount,
      stage: "page_committed",
      syncRunId: options.syncRunId,
      usageSummary: toUsageSummary(fetched.usage),
    });
    pagesVisited += 1;

    logger.info("instagram.media.page_committed", {
      ...logContext,
      stage: "persisting_page",
      unit: "posts",
      value: committed.imported + committed.updated,
    });

    // The media edge is returned newest first, so the first item older than the
    // horizon means every remaining page is out of range.
    if (!fetched.page.hasNextPage || reachedHorizon) {
      completed = true;
      break;
    }

    after = fetched.page.after;
  }

  if (!completed) {
    // Reporting success here would claim a complete import that stopped early.
    // The cursor is committed, so the retry resumes instead of restarting.
    throw new JobHandlerFailure({
      errorClass: "TRANSIENT",
      errorCode: "SYNC_PAGE_LIMIT_REACHED",
    });
  }
}

function toUsageSummary(
  usage: readonly InstagramUsageObservation[],
): Readonly<Record<string, number>> | undefined {
  if (usage.length === 0) return undefined;

  const summary: Record<string, number> = {};
  for (const observation of usage) {
    if (observation.maximumPercentage !== null) {
      summary[observation.header] = observation.maximumPercentage;
    }
  }

  return Object.keys(summary).length > 0 ? summary : undefined;
}

/**
 * Maps a provider or infrastructure failure to the retry class the job
 * framework understands. Rate limits back off, an unusable token asks for a
 * reconnect rather than retrying into a lockout, and a rejected request is not
 * retried at all.
 */
export function toJobFailure(error: unknown): JobHandlerFailure {
  if (error instanceof JobHandlerFailure) return error;

  if (error instanceof InstagramMediaError) {
    switch (error.responseClass) {
      case "authorisation":
        return new JobHandlerFailure({
          errorClass: "CREDENTIAL",
          errorCode: "INSTAGRAM_TOKEN_REJECTED",
        });
      case "invalid_request":
        return new JobHandlerFailure({
          errorClass: "INVALID_INPUT",
          errorCode: "INSTAGRAM_REQUEST_REJECTED",
        });
      case "rate_limit":
        return new JobHandlerFailure({
          errorClass: "RATE_LIMIT",
          errorCode: "INSTAGRAM_RATE_LIMITED",
          ...(error.retryAfterMs === null ? {} : { providerRetryAfterMs: error.retryAfterMs }),
        });
      case "transient":
        return new JobHandlerFailure({
          errorClass: "TRANSIENT",
          errorCode: "INSTAGRAM_UNAVAILABLE",
        });
      case "unsupported":
        return new JobHandlerFailure({
          errorClass: "INVALID_INPUT",
          errorCode: "INSTAGRAM_REQUEST_UNSUPPORTED",
        });
    }
  }

  if (error instanceof OperationalError && error.retryable) {
    return new JobHandlerFailure({
      errorClass: "DATABASE",
      errorCode: "SYNC_DATABASE_UNAVAILABLE",
    });
  }

  return new JobHandlerFailure(classifyJobHandlerError(error));
}
