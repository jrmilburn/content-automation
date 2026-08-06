import {
  commitInstagramComments,
  createWorkspaceContext,
  decryptCredential,
  runIdempotentJobHandler,
  type DatabaseClient,
  type JobHandlerExecutionContext,
  type TransactionalJobResult,
} from "@studio-parallel/db";
import {
  classifyJobHandlerError,
  instagramApiVersion,
  instagramMaximumCommentPages,
  JobHandlerFailure,
  normaliseInstagramCommentItem,
  type NormalisedInstagramComment,
  type QueueHandlerRegistration,
  type QueueJobEnvelope,
  type InstagramUsageObservation,
} from "@studio-parallel/domain";
import {
  OperationalError,
  parseCorrelationId,
  type JsonLogger,
} from "@studio-parallel/observability";

import {
  fetchInstagramCommentsPage,
  InstagramCommentsError,
  type FetchLike,
} from "./comments-client.js";

/**
 * Imports one post's comments, including the replies beneath them.
 *
 * Work is per post so a failure on one cannot stall the others, and so a post
 * with thousands of comments cannot hold a lease that every other post is
 * waiting behind. The credential is decrypted here and nowhere else, exists
 * only as a local, and is never logged or returned.
 *
 * Comments are addressed by provider id and written as upserts, so a crash
 * mid-import replays from the first page and converges rather than duplicating
 * or skipping. That is why no cursor is persisted: resuming from the start is
 * correct, and the alternative is a checkpoint that can only ever be wrong
 * after a comment is deleted and the paging shifts under it.
 */

export const instagramCommentsQueue = { name: "instagram.comments.post", version: 1 } as const;

const postResourceType = "instagram_post";

export type InstagramCommentsDependencies = Readonly<{
  acquireConcurrency?: ((signal: AbortSignal) => Promise<() => void>) | undefined;
  database: DatabaseClient;
  fetchImplementation?: FetchLike | undefined;
  loadMasterKeys: () => ReadonlyMap<number, Buffer>;
  logger: JsonLogger;
  now?: (() => Date) | undefined;
}>;

export function createInstagramCommentsPostHandler(
  dependencies: InstagramCommentsDependencies,
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
          importComments({ dependencies, envelope, execution, now, workspace }),
        logger: dependencies.logger,
        now,
        // Comments are upserted by provider id, so re-running after a crash
        // converges on the same rows. There is no job-scoped result to look up,
        // and a re-run is also how an edited or newly arrived comment is picked
        // up, so suppressing it would defeat the point of scheduling one.
        resultExists: async () => false,
        signal: context.signal,
      });
    },
    queue: instagramCommentsQueue,
  });
}

async function importComments(input: {
  dependencies: InstagramCommentsDependencies;
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
      errorCode: "COMMENTS_CORRELATION_INVALID",
    });
  }

  await execution.recordStage("loading_post");

  const job = await database.backgroundJob.findFirst({
    select: { resourceId: true, resourceType: true },
    where: { id: envelope.domainJobId, workspaceId: workspace.workspaceId },
  });
  if (!job || job.resourceType !== postResourceType || !job.resourceId) {
    throw new JobHandlerFailure({
      errorClass: "INVALID_INPUT",
      errorCode: "COMMENTS_RESOURCE_INVALID",
    });
  }

  const post = await database.instagramPost.findFirst({
    select: { id: true, instagramAccountId: true, providerMediaId: true },
    where: { id: job.resourceId, workspaceId: workspace.workspaceId },
  });
  if (!post) {
    throw new JobHandlerFailure({
      errorClass: "INVALID_INPUT",
      errorCode: "COMMENTS_POST_MISSING",
    });
  }

  const account = await database.instagramAccount.findFirst({
    select: { connectionStatus: true, id: true },
    where: { id: post.instagramAccountId, workspaceId: workspace.workspaceId },
  });
  if (!account) {
    throw new JobHandlerFailure({
      errorClass: "INVALID_INPUT",
      errorCode: "COMMENTS_ACCOUNT_MISSING",
    });
  }
  if (account.connectionStatus !== "ACTIVE") {
    throw new JobHandlerFailure({
      errorClass: "CREDENTIAL",
      errorCode: "COMMENTS_ACCOUNT_NOT_CONNECTED",
    });
  }

  const accessToken = await readAccessToken({ accountId: account.id, dependencies, workspace });

  let after: string | null = null;
  let pagesVisited = 0;
  let imported = 0;
  let updated = 0;
  let invalidCount = 0;
  let completed = false;
  const usage: InstagramUsageObservation[] = [];

  while (pagesVisited < instagramMaximumCommentPages) {
    await execution.throwIfCancellationRequested();
    // Extends the lease as well as recording progress; a post with many pages
    // of comments can otherwise outlast it and have the attempt reclaimed.
    await execution.heartbeat();
    await execution.recordStage("fetching_page");

    let fetched;
    try {
      fetched = await fetchInstagramCommentsPage({
        accessToken,
        after,
        ...(dependencies.fetchImplementation
          ? { fetchImplementation: dependencies.fetchImplementation }
          : {}),
        providerMediaId: post.providerMediaId,
      });
    } catch (error) {
      // Mapped here rather than left to the generic classifier, which would
      // read a rate limit as an unknown fault and discard the provider's own
      // retry-after — turning a wait into a burst of doomed attempts.
      throw toJobFailure(error);
    }

    usage.push(...fetched.usage);

    const comments: NormalisedInstagramComment[] = [];
    for (const item of fetched.page.items) {
      const normalised = normaliseInstagramCommentItem(item);
      // One malformed comment is counted and dropped; the rest of the page and
      // every page already committed are unaffected. The reason is a shape
      // code, never the body that failed to parse.
      invalidCount += normalised.rejected.length;
      comments.push(...normalised.comments);
    }

    await execution.recordStage("persisting_page");
    const committed = await commitInstagramComments(database, workspace, {
      comments,
      importedAt: now(),
      instagramPostId: post.id,
      rawApiVersion: instagramApiVersion,
    });
    imported += committed.imported;
    updated += committed.updated;
    pagesVisited += 1;

    if (!fetched.page.hasNextPage) {
      completed = true;
      break;
    }

    after = fetched.page.after;
  }

  // Not a failure. A post past the page bound keeps the comments it has, and
  // the next scheduled run reads it again; throwing here would retry the same
  // post forever and never reach the ones behind it.
  logger.info("instagram.comments.imported", {
    correlationId,
    ...(completed ? {} : { limitations: ["COMMENT_PAGE_LIMIT_REACHED"] }),
    ...(invalidCount > 0 ? { invalidCount } : {}),
    jobId: envelope.domainJobId,
    stage: "persisting_page",
    unit: "comments",
    ...(usage.length > 0 ? { usage: toUsageSummary(usage) } : {}),
    value: imported + updated,
    workspaceId: workspace.workspaceId,
  });

  return Object.freeze({ commit: async () => {} });
}

async function readAccessToken(input: {
  accountId: string;
  dependencies: InstagramCommentsDependencies;
  workspace: ReturnType<typeof createWorkspaceContext>;
}): Promise<string> {
  const credential = await input.dependencies.database.integrationCredential.findFirst({
    select: { ciphertext: true },
    where: {
      accountId: input.accountId,
      integrationType: "INSTAGRAM",
      status: "ACTIVE",
      workspaceId: input.workspace.workspaceId,
    },
  });
  if (!credential) {
    throw new JobHandlerFailure({
      errorClass: "CREDENTIAL",
      errorCode: "COMMENTS_CREDENTIAL_MISSING",
    });
  }

  try {
    return decryptCredential({
      context: {
        accountId: input.accountId,
        integrationType: "INSTAGRAM",
        workspaceId: input.workspace.workspaceId,
      },
      masterKeys: input.dependencies.loadMasterKeys(),
      sealed: credential.ciphertext,
    });
  } catch {
    throw new JobHandlerFailure({
      errorClass: "CREDENTIAL",
      errorCode: "COMMENTS_CREDENTIAL_UNREADABLE",
    });
  }
}

export function toJobFailure(error: unknown): JobHandlerFailure {
  if (error instanceof JobHandlerFailure) return error;

  if (error instanceof InstagramCommentsError) {
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
        // The comments edge refusing this media is permanent for this post —
        // an image with comments disabled, or a kind the edge does not serve.
        return new JobHandlerFailure({
          errorClass: "INVALID_INPUT",
          errorCode: "INSTAGRAM_REQUEST_UNSUPPORTED",
        });
    }
  }

  if (error instanceof OperationalError && error.retryable) {
    return new JobHandlerFailure({
      errorClass: "DATABASE",
      errorCode: "COMMENTS_DATABASE_UNAVAILABLE",
    });
  }

  return new JobHandlerFailure(classifyJobHandlerError(error));
}

function toUsageSummary(
  usage: readonly InstagramUsageObservation[],
): Readonly<Record<string, number>> {
  const summary: Record<string, number> = {};
  for (const observation of usage) {
    if (observation.maximumPercentage === null) continue;
    summary[observation.header] = Math.max(
      summary[observation.header] ?? 0,
      observation.maximumPercentage,
    );
  }
  return Object.freeze(summary);
}
