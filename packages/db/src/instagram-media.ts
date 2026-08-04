import type { InstagramSyncTrigger, NormalisedInstagramMedia } from "@studio-parallel/domain";
import { OperationalError } from "@studio-parallel/observability";

import type { Prisma, PrismaClient, SyncRun } from "./generated/prisma/client.js";
import { createId } from "./id.js";
import type { WorkspaceContext } from "./workspace-context.js";

/**
 * Persistence for imported Instagram media and the sync runs that produce it.
 *
 * The ordering guarantee this module exists to provide is that a page's posts
 * and the cursor that would skip them past that page commit in one transaction.
 * A crash therefore either loses the whole page and replays it, or keeps it and
 * resumes after it — never advances past uncommitted records.
 *
 * Every write is scoped by the caller's workspace and by the account recorded
 * on the run, so a crafted account or media identifier cannot attach a post to
 * another workspace's account.
 */

type MediaDatabase = PrismaClient;
type MediaExecutor = PrismaClient | Prisma.TransactionClient;

const safeStagePattern = /^[a-z][a-z0-9_]{0,63}$/u;
const safeFailureClassPattern = /^[A-Z][A-Z0-9_]{0,31}$/u;
const safeFailureCodePattern = /^[A-Z][A-Z0-9_]{0,63}$/u;
const safeIdempotencyKeyPattern = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,254}$/u;

/** The resource an imported post is identified as on a job or an audit row. */
export const instagramPostResourceType = "instagram_post";

/**
 * The only supported read projection. `rawPayload` is restricted provenance and
 * is deliberately absent so a caption or provider payload cannot reach a
 * response or a log through an ordinary read.
 */
export const instagramPostSafeSelect = {
  createdAt: true,
  firstImportedAt: true,
  id: true,
  instagramAccountId: true,
  lastImportedAt: true,
  lastSyncRunId: true,
  mediaKind: true,
  mediaProductType: true,
  mediaType: true,
  permalink: true,
  providerMediaId: true,
  providerThumbnailUrl: true,
  publishedAt: true,
  rawApiVersion: true,
  rawPayloadHash: true,
  rawRetrievedAt: true,
  updatedAt: true,
  workspaceId: true,
} as const;

export type InstagramPostSummary = Prisma.InstagramPostGetPayload<{
  select: typeof instagramPostSafeSelect;
}>;

export type StartInstagramSyncRunInput = Readonly<{
  apiVersion: string;
  backgroundJobId?: string | null;
  correlationId: string;
  horizonStart?: Date | null;
  idempotencyKey: string;
  instagramAccountId: string;
  requestedByUserId?: string | null;
  startedAt: Date;
  trigger: InstagramSyncTrigger;
}>;

export type CommitInstagramMediaPageInput = Readonly<{
  cursor: string | null;
  importedAt: Date;
  invalidCount: number;
  media: readonly NormalisedInstagramMedia[];
  rawApiVersion: string;
  skippedCount: number;
  stage: string;
  syncRunId: string;
  usageSummary?: Prisma.InputJsonValue | undefined;
}>;

export type InstagramMediaPageCommit = Readonly<{
  imported: number;
  updated: number;
}>;

function mediaError(code: string, statusCode: number, retryable = false): OperationalError {
  return new OperationalError({
    code,
    errorClass: statusCode === 404 ? "not_found" : statusCode === 409 ? "conflict" : "validation",
    retryable,
    statusCode,
  });
}

function assertSafeStage(stage: string): void {
  if (!safeStagePattern.test(stage)) throw mediaError("SYNC_RUN_STAGE_INVALID", 400);
}

function assertNonNegativeInteger(value: number, code: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw mediaError(code, 400);
}

/**
 * Opens or resumes the run for one idempotency key.
 *
 * A key that already has a run is never duplicated: a finished run is returned
 * unchanged so a redelivered job is a no-op, and a failed run is reopened with
 * its cursor and counters intact so the retry continues from the checkpoint
 * rather than re-importing from the start.
 */
export async function startInstagramSyncRun(
  database: MediaDatabase,
  context: WorkspaceContext,
  input: StartInstagramSyncRunInput,
): Promise<SyncRun> {
  if (!safeIdempotencyKeyPattern.test(input.idempotencyKey)) {
    throw mediaError("SYNC_RUN_IDEMPOTENCY_KEY_INVALID", 400);
  }

  const account = await database.instagramAccount.findFirst({
    select: { id: true },
    where: { id: input.instagramAccountId, workspaceId: context.workspaceId },
  });
  // Reported as not found rather than forbidden so a crafted identifier cannot
  // be used to discover which accounts exist in another workspace.
  if (!account) throw mediaError("SYNC_ACCOUNT_NOT_FOUND", 404);

  const existing = await database.syncRun.findUnique({
    where: {
      workspaceId_instagramAccountId_trigger_idempotencyKey: {
        idempotencyKey: input.idempotencyKey,
        instagramAccountId: input.instagramAccountId,
        trigger: input.trigger,
        workspaceId: context.workspaceId,
      },
    },
  });

  if (existing?.state === "SUCCEEDED" || existing?.state === "RUNNING") return existing;

  if (existing) {
    const reopened = await database.syncRun.updateMany({
      data: {
        backgroundJobId: input.backgroundJobId ?? existing.backgroundJobId,
        completedAt: null,
        correlationId: input.correlationId,
        failureClass: null,
        failureCode: null,
        stage: "starting",
        state: "RUNNING",
      },
      where: { id: existing.id, state: "FAILED", workspaceId: context.workspaceId },
    });
    if (reopened.count !== 1) throw mediaError("SYNC_RUN_REOPEN_CONFLICT", 409);

    const current = await database.syncRun.findFirst({
      where: { id: existing.id, workspaceId: context.workspaceId },
    });
    if (!current) throw mediaError("SYNC_RUN_NOT_FOUND", 404);
    return current;
  }

  try {
    return await database.syncRun.create({
      data: {
        apiVersion: input.apiVersion,
        backgroundJobId: input.backgroundJobId ?? null,
        correlationId: input.correlationId,
        horizonStart: input.horizonStart ?? null,
        id: createId(),
        idempotencyKey: input.idempotencyKey,
        instagramAccountId: input.instagramAccountId,
        requestedByUserId: input.requestedByUserId ?? null,
        startedAt: input.startedAt,
        trigger: input.trigger,
        workspaceId: context.workspaceId,
      },
    });
  } catch {
    // The partial unique index permits one RUNNING run per account and trigger,
    // so a concurrent run for the same purpose collides here rather than both
    // paging the same media.
    throw mediaError("SYNC_RUN_ALREADY_ACTIVE", 409);
  }
}

/**
 * Commits one page of media and the cursor that follows it in a single
 * transaction.
 *
 * Identity is immutable across repeated or overlapping pages: an existing
 * provider media ID is updated in place, keeping its row id and its original
 * `firstImportedAt`, so a re-read never creates a second post or rewrites when
 * the media first entered the system.
 */
export async function commitInstagramMediaPage(
  database: MediaDatabase,
  context: WorkspaceContext,
  input: CommitInstagramMediaPageInput,
): Promise<InstagramMediaPageCommit> {
  assertSafeStage(input.stage);
  assertNonNegativeInteger(input.invalidCount, "SYNC_RUN_INVALID_COUNT_INVALID");
  assertNonNegativeInteger(input.skippedCount, "SYNC_RUN_SKIPPED_COUNT_INVALID");

  return database.$transaction(async (transaction) => {
    const run = await transaction.syncRun.findFirst({
      where: { id: input.syncRunId, state: "RUNNING", workspaceId: context.workspaceId },
    });
    if (!run) throw mediaError("SYNC_RUN_NOT_ACTIVE", 409);

    const instagramAccountId = run.instagramAccountId;
    const providerMediaIds = input.media.map((item) => item.providerMediaId);
    const existing = await transaction.instagramPost.findMany({
      select: { id: true, providerMediaId: true },
      where: { instagramAccountId, providerMediaId: { in: providerMediaIds } },
    });
    const existingByProviderMediaId = new Map(
      existing.map((post) => [post.providerMediaId, post.id]),
    );

    let imported = 0;
    let updated = 0;

    for (const item of input.media) {
      const shared = {
        caption: item.caption,
        lastImportedAt: input.importedAt,
        lastSyncRunId: run.id,
        mediaKind: item.kind,
        mediaProductType: item.mediaProductType,
        mediaType: item.mediaType,
        permalink: item.permalink,
        // Display metadata that expires. It is never promoted to a source
        // asset; `media_url` is not stored outside the restricted payload.
        providerThumbnailUrl: item.ephemeralThumbnailUrl,
        publishedAt: item.publishedAt,
        rawApiVersion: input.rawApiVersion,
        rawPayload: { ...item.rawPayload } as Prisma.InputJsonValue,
        rawPayloadHash: item.rawPayloadHash,
        rawRetrievedAt: input.importedAt,
      };

      const existingId = existingByProviderMediaId.get(item.providerMediaId);
      if (existingId) {
        await transaction.instagramPost.update({ data: shared, where: { id: existingId } });
        updated += 1;
        continue;
      }

      await transaction.instagramPost.create({
        data: {
          ...shared,
          firstImportedAt: input.importedAt,
          id: createId(),
          instagramAccountId,
          providerMediaId: item.providerMediaId,
          workspaceId: context.workspaceId,
        },
      });
      imported += 1;
    }

    // The cursor moves only now, in the same transaction as the rows above.
    const advanced = await transaction.syncRun.updateMany({
      data: {
        checkpointAt: input.importedAt,
        cursor: input.cursor,
        itemsImported: { increment: imported },
        itemsInvalid: { increment: input.invalidCount },
        itemsSeen: { increment: input.media.length + input.invalidCount + input.skippedCount },
        itemsSkipped: { increment: input.skippedCount },
        itemsUpdated: { increment: updated },
        pagesCompleted: { increment: 1 },
        stage: input.stage,
        ...(input.usageSummary === undefined ? {} : { usageSummary: input.usageSummary }),
      },
      where: { id: run.id, state: "RUNNING", workspaceId: context.workspaceId },
    });
    if (advanced.count !== 1) throw mediaError("SYNC_RUN_NOT_ACTIVE", 409);

    return Object.freeze({ imported, updated });
  });
}

/**
 * Closes a run as successful and stamps the account's last successful sync.
 *
 * This takes an executor rather than a client so it can run inside the job
 * framework's success transaction: the run is only ever marked complete
 * together with the background job that produced it.
 */
export async function completeInstagramSyncRun(
  executor: MediaExecutor,
  context: WorkspaceContext,
  input: Readonly<{ completedAt: Date; syncRunId: string }>,
): Promise<void> {
  const completed = await executor.syncRun.updateMany({
    data: {
      checkpointAt: input.completedAt,
      completedAt: input.completedAt,
      failureClass: null,
      failureCode: null,
      stage: "completed",
      state: "SUCCEEDED",
    },
    where: { id: input.syncRunId, state: "RUNNING", workspaceId: context.workspaceId },
  });
  if (completed.count !== 1) throw mediaError("SYNC_RUN_NOT_ACTIVE", 409);

  const run = await executor.syncRun.findFirst({
    select: { instagramAccountId: true },
    where: { id: input.syncRunId, workspaceId: context.workspaceId },
  });
  if (!run) throw mediaError("SYNC_RUN_NOT_FOUND", 404);

  await executor.instagramAccount.updateMany({
    data: { lastSuccessfulSyncAt: input.completedAt },
    where: { id: run.instagramAccountId, workspaceId: context.workspaceId },
  });
}

/**
 * Records a redacted failure against the run. Committed pages and the cursor
 * are left untouched so the retry resumes rather than restarts.
 */
export async function failInstagramSyncRun(
  database: MediaDatabase,
  context: WorkspaceContext,
  input: Readonly<{ failedAt: Date; failureClass: string; failureCode: string; syncRunId: string }>,
): Promise<void> {
  if (!safeFailureClassPattern.test(input.failureClass)) {
    throw mediaError("SYNC_RUN_FAILURE_CLASS_INVALID", 400);
  }
  if (!safeFailureCodePattern.test(input.failureCode)) {
    throw mediaError("SYNC_RUN_FAILURE_CODE_INVALID", 400);
  }

  await database.syncRun.updateMany({
    data: {
      completedAt: input.failedAt,
      failureClass: input.failureClass,
      failureCode: input.failureCode,
      stage: "failed",
      state: "FAILED",
    },
    where: { id: input.syncRunId, state: "RUNNING", workspaceId: context.workspaceId },
  });
}

/**
 * Idempotency probe for the job framework: true once this job's run has
 * committed its terminal state.
 */
export async function instagramSyncRunSucceededForJob(
  executor: MediaExecutor,
  context: WorkspaceContext,
  backgroundJobId: string,
): Promise<boolean> {
  const run = await executor.syncRun.findFirst({
    select: { id: true },
    where: { backgroundJobId, state: "SUCCEEDED", workspaceId: context.workspaceId },
  });
  return run !== null;
}

export async function findInstagramSyncRun(
  executor: MediaExecutor,
  context: WorkspaceContext,
  syncRunId: string,
): Promise<SyncRun | null> {
  return executor.syncRun.findFirst({
    where: { id: syncRunId, workspaceId: context.workspaceId },
  });
}

export async function findInstagramPostByProviderMediaId(
  executor: MediaExecutor,
  context: WorkspaceContext,
  input: Readonly<{ instagramAccountId: string; providerMediaId: string }>,
): Promise<InstagramPostSummary | null> {
  return executor.instagramPost.findFirst({
    select: instagramPostSafeSelect,
    where: {
      instagramAccountId: input.instagramAccountId,
      providerMediaId: input.providerMediaId,
      workspaceId: context.workspaceId,
    },
  });
}

export async function listInstagramPosts(
  executor: MediaExecutor,
  context: WorkspaceContext,
  input: Readonly<{ instagramAccountId: string; take?: number }>,
): Promise<readonly InstagramPostSummary[]> {
  return executor.instagramPost.findMany({
    orderBy: { publishedAt: "desc" },
    select: instagramPostSafeSelect,
    take: Math.min(Math.max(input.take ?? 50, 1), 200),
    where: {
      instagramAccountId: input.instagramAccountId,
      workspaceId: context.workspaceId,
    },
  });
}
