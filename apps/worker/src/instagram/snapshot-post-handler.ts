import {
  createWorkspaceContext,
  decryptCredential,
  recordInstagramMetricSnapshot,
  runIdempotentJobHandler,
  type DatabaseClient,
  type JobHandlerExecutionContext,
  type TransactionalJobResult,
} from "@studio-parallel/db";
import {
  classifyJobHandlerError,
  instagramApiVersion,
  instagramFailedGroupObservations,
  instagramGroupFailureAvailability,
  instagramInsightGroups,
  instagramRequestedMetrics,
  instagramUnrequestedObservations,
  JobHandlerFailure,
  readInstagramInsightGroup,
  type InstagramMediaKind,
  type InstagramMetricObservation,
  type InstagramUsageObservation,
  type QueueHandlerRegistration,
  type QueueJobEnvelope,
} from "@studio-parallel/domain";
import {
  OperationalError,
  parseCorrelationId,
  type JsonLogger,
} from "@studio-parallel/observability";

import {
  fetchInstagramInsightGroup,
  InstagramInsightsError,
  type FetchLike,
} from "./insights-client.js";

/**
 * Captures one immutable metric snapshot for one post.
 *
 * Insight work is per post so a failure on one cannot stall the others. The
 * credential is decrypted here and nowhere else, exists only as a local, and is
 * never logged or returned.
 *
 * A group that fails terminally — a permission gap, or a metric this API
 * version does not support — is recorded as that availability and the snapshot
 * still lands, because retrying cannot change the answer. A group that fails
 * retryably fails the whole job instead: persisting a snapshot with metrics
 * permanently marked `provider_error` would leave a hole in a cohort that a
 * later successful run could never fill.
 */

export const instagramSnapshotQueue = { name: "instagram.snapshot.post", version: 1 } as const;

const postResourceType = "instagram_post";

export type InstagramSnapshotDependencies = Readonly<{
  acquireConcurrency?: ((signal: AbortSignal) => Promise<() => void>) | undefined;
  database: DatabaseClient;
  fetchImplementation?: FetchLike | undefined;
  loadMasterKeys: () => ReadonlyMap<number, Buffer>;
  logger: JsonLogger;
  now?: (() => Date) | undefined;
}>;

export function createInstagramSnapshotPostHandler(
  dependencies: InstagramSnapshotDependencies,
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
          captureSnapshot({ dependencies, envelope, execution, now, workspace }),
        logger: dependencies.logger,
        now,
        // A snapshot is content-addressed: its unique key is the payload hash
        // within an age bucket, so re-running after a crash either collapses
        // onto the existing row or records a genuinely changed observation.
        // There is no job-scoped result to look up, and inventing one would
        // suppress the second, legitimate case.
        resultExists: async () => false,
        signal: context.signal,
      });
    },
    queue: instagramSnapshotQueue,
  });
}

async function captureSnapshot(input: {
  dependencies: InstagramSnapshotDependencies;
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
      errorCode: "SNAPSHOT_CORRELATION_INVALID",
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
      errorCode: "SNAPSHOT_RESOURCE_INVALID",
    });
  }

  const post = await database.instagramPost.findFirst({
    select: {
      id: true,
      instagramAccountId: true,
      mediaKind: true,
      providerMediaId: true,
      publishedAt: true,
    },
    where: { id: job.resourceId, workspaceId: workspace.workspaceId },
  });
  if (!post) {
    throw new JobHandlerFailure({
      errorClass: "INVALID_INPUT",
      errorCode: "SNAPSHOT_POST_MISSING",
    });
  }

  const groups = instagramInsightGroups({
    apiVersion: instagramApiVersion,
    mediaKind: post.mediaKind as InstagramMediaKind,
  });

  if (groups.length === 0) {
    // No proof covers this media kind on this API version, so nothing is
    // requested. Writing a snapshot of entirely absent metrics would add a row
    // that says only "we did not ask", which the capability map already says.
    logger.info("instagram.snapshot.skipped", {
      correlationId,
      jobId: envelope.domainJobId,
      reasonCode: "MEDIA_KIND_NOT_SUPPORTED",
      stage: "loading_post",
      workspaceId: workspace.workspaceId,
    });
    return Object.freeze({ commit: async () => {} });
  }

  const account = await database.instagramAccount.findFirst({
    select: { connectionStatus: true, followerCount: true, id: true },
    where: { id: post.instagramAccountId, workspaceId: workspace.workspaceId },
  });
  if (!account) {
    throw new JobHandlerFailure({
      errorClass: "INVALID_INPUT",
      errorCode: "SNAPSHOT_ACCOUNT_MISSING",
    });
  }
  if (account.connectionStatus !== "ACTIVE") {
    throw new JobHandlerFailure({
      errorClass: "CREDENTIAL",
      errorCode: "SNAPSHOT_ACCOUNT_NOT_CONNECTED",
    });
  }

  const accessToken = await readAccessToken({ accountId: account.id, dependencies, workspace });

  await execution.heartbeat();
  await execution.recordStage("fetching_insights");

  const observations: InstagramMetricObservation[] = [];
  const rawPayload: Record<string, unknown> = {};
  const usage: InstagramUsageObservation[] = [];
  const limitations: string[] = [];

  for (const group of groups) {
    await execution.throwIfCancellationRequested();

    try {
      const fetched = await fetchInstagramInsightGroup({
        accessToken,
        ...(dependencies.fetchImplementation
          ? { fetchImplementation: dependencies.fetchImplementation }
          : {}),
        group,
        providerMediaId: post.providerMediaId,
      });

      usage.push(...fetched.usage);
      rawPayload[group.key] = fetched.body;

      const read = readInstagramInsightGroup(fetched.body, group);
      observations.push(...read.observations);
      for (const rejection of read.rejections) limitations.push(`${group.key}:${rejection}`);
    } catch (error) {
      if (!(error instanceof InstagramInsightsError)) throw error;

      // Retrying can only help a rate limit or a transient fault, and a
      // half-empty snapshot would be permanent, so the job fails instead.
      if (error.responseClass === "rate_limit" || error.responseClass === "transient") {
        throw toJobFailure(error);
      }

      const availability = instagramGroupFailureAvailability(error.responseClass);
      observations.push(...instagramFailedGroupObservations(group, availability));
      limitations.push(`${group.key}:${availability}`);
    }
  }

  observations.push(
    ...instagramUnrequestedObservations(
      instagramRequestedMetrics({
        apiVersion: instagramApiVersion,
        mediaKind: post.mediaKind as InstagramMediaKind,
      }),
    ),
  );

  const capturedAt = now();
  const postAgeSeconds = Math.max(
    0,
    Math.floor((capturedAt.getTime() - post.publishedAt.getTime()) / 1000),
  );

  logger.info("instagram.snapshot.captured", {
    correlationId,
    jobId: envelope.domainJobId,
    ...(limitations.length > 0 ? { limitations } : {}),
    stage: "fetching_insights",
    ...(usage.length > 0 ? { usage: toUsageSummary(usage) } : {}),
    workspaceId: workspace.workspaceId,
  });

  return Object.freeze({
    commit: async (transaction) => {
      await recordInstagramMetricSnapshot(transaction, workspace, {
        apiVersion: instagramApiVersion,
        capturedAt,
        followerCount: account.followerCount,
        instagramPostId: post.id,
        observations,
        postAgeSeconds,
        rawPayload: rawPayload as never,
      });
    },
  });
}

async function readAccessToken(input: {
  accountId: string;
  dependencies: InstagramSnapshotDependencies;
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
      errorCode: "SNAPSHOT_CREDENTIAL_MISSING",
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
      errorCode: "SNAPSHOT_CREDENTIAL_UNREADABLE",
    });
  }
}

export function toJobFailure(error: unknown): JobHandlerFailure {
  if (error instanceof JobHandlerFailure) return error;

  if (error instanceof InstagramInsightsError) {
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
      errorCode: "SNAPSHOT_DATABASE_UNAVAILABLE",
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
