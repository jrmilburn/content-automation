import type { Prisma, PrismaClient } from "./generated/prisma/client.js";
import { createId } from "./id.js";
import type { WorkspaceContext } from "./workspace-context.js";

/**
 * Persistence for source-video upload intents and the assets they produce.
 *
 * Every read and write in this module is filtered by the caller's workspace, so
 * a crafted post or intent identifier from another workspace resolves to
 * nothing rather than to someone else's row. No function here talks to the
 * object store: provider calls must not run inside a transaction that holds
 * database locks.
 *
 * Byte counts are stored as BigInt because a 1 GiB ceiling today is a
 * configuration value, not a guarantee, and a column that silently truncates a
 * larger file later would corrupt the very metadata the completion check
 * compares against.
 */

type UploadExecutor = PrismaClient | Prisma.TransactionClient;

export const videoUploadIntentResourceType = "video_upload_intent";
export const videoAssetResourceType = "video_asset";

export const uploadIntentInitiatedAction = "video.upload.initiated";
export const uploadIntentCompletedAction = "video.upload.completed";
export const uploadIntentAbortedAction = "video.upload.aborted";
export const uploadIntentExpiredAction = "video.upload.expired";

export type VideoUploadIntentRecord = Readonly<{
  bucket: string;
  declaredBytes: bigint;
  declaredContentType: string;
  expiresAt: Date;
  id: string;
  instagramPostId: string;
  objectKey: string;
  partCount: number;
  partSizeBytes: number;
  providerUploadId: string;
  region: string;
  state: "PENDING" | "COMPLETED" | "ABORTED" | "EXPIRED";
}>;

const intentSelect = {
  bucket: true,
  declaredBytes: true,
  declaredContentType: true,
  expiresAt: true,
  id: true,
  instagramPostId: true,
  objectKey: true,
  partCount: true,
  partSizeBytes: true,
  providerUploadId: true,
  region: true,
  state: true,
} as const;

export type CreateUploadIntentInput = Readonly<{
  bucket: string;
  createdByUserId: string;
  declaredBytes: number;
  declaredContentType: string;
  expiresAt: Date;
  instagramPostId: string;
  objectKey: string;
  partCount: number;
  partSizeBytes: number;
  providerUploadId: string;
  region: string;
}>;

/**
 * Records a reserved upload.
 *
 * `pendingForPostId` is set to the post while the intent is pending. The unique
 * index on it is what actually enforces one pending upload per post; a check-
 * then-insert would race.
 */
export async function createVideoUploadIntent(
  executor: UploadExecutor,
  context: WorkspaceContext,
  input: CreateUploadIntentInput,
): Promise<VideoUploadIntentRecord> {
  return executor.videoUploadIntent.create({
    data: {
      bucket: input.bucket,
      createdByUserId: input.createdByUserId,
      declaredBytes: BigInt(input.declaredBytes),
      declaredContentType: input.declaredContentType,
      expiresAt: input.expiresAt,
      id: createId(),
      instagramPostId: input.instagramPostId,
      objectKey: input.objectKey,
      partCount: input.partCount,
      partSizeBytes: input.partSizeBytes,
      pendingForPostId: input.instagramPostId,
      providerUploadId: input.providerUploadId,
      region: input.region,
      state: "PENDING",
      workspaceId: context.workspaceId,
    },
    select: intentSelect,
  });
}

export async function findVideoUploadIntent(
  executor: UploadExecutor,
  context: WorkspaceContext,
  intentId: string,
): Promise<VideoUploadIntentRecord | null> {
  return executor.videoUploadIntent.findFirst({
    select: intentSelect,
    where: { id: intentId, workspaceId: context.workspaceId },
  });
}

export async function findPendingVideoUploadIntentForPost(
  executor: UploadExecutor,
  context: WorkspaceContext,
  instagramPostId: string,
): Promise<VideoUploadIntentRecord | null> {
  return executor.videoUploadIntent.findFirst({
    select: intentSelect,
    where: { instagramPostId, state: "PENDING", workspaceId: context.workspaceId },
  });
}

/**
 * Moves an intent to a terminal state and clears its pending marker.
 *
 * The update is conditional on the intent still being PENDING, so two racing
 * callers cannot both believe they closed it: the loser updates zero rows.
 */
export async function closeVideoUploadIntent(
  executor: UploadExecutor,
  context: WorkspaceContext,
  input: Readonly<{
    completedAt?: Date | undefined;
    intentId: string;
    state: "COMPLETED" | "ABORTED" | "EXPIRED";
  }>,
): Promise<boolean> {
  const result = await executor.videoUploadIntent.updateMany({
    data: {
      completedAt: input.completedAt ?? null,
      pendingForPostId: null,
      state: input.state,
    },
    where: { id: input.intentId, state: "PENDING", workspaceId: context.workspaceId },
  });

  return result.count === 1;
}

export type CreateVideoAssetInput = Readonly<{
  bucket: string;
  bytes: number;
  contentType: string | null;
  declaredChecksum: string | null;
  etag: string;
  instagramPostId: string;
  objectKey: string;
  objectVersion: string | null;
  region: string;
  uploadIntentId: string;
}>;

export type VideoAssetRecord = Readonly<{
  bytes: bigint;
  id: string;
  instagramPostId: string;
  objectKey: string;
  state: "PENDING_VALIDATION" | "READY" | "REJECTED";
}>;

const assetSelect = {
  bytes: true,
  id: true,
  instagramPostId: true,
  objectKey: true,
  state: true,
} as const;

export async function findVideoAssetForIntent(
  executor: UploadExecutor,
  context: WorkspaceContext,
  uploadIntentId: string,
): Promise<VideoAssetRecord | null> {
  return executor.videoAsset.findFirst({
    select: assetSelect,
    where: { uploadIntentId, workspaceId: context.workspaceId },
  });
}

/**
 * Publishes the asset for a completed intent.
 *
 * The asset always starts PENDING_VALIDATION: nothing in the upload path may
 * mark a video ready, because no probe has looked at it yet.
 */
export async function createVideoAsset(
  executor: UploadExecutor,
  context: WorkspaceContext,
  input: CreateVideoAssetInput,
): Promise<VideoAssetRecord> {
  return executor.videoAsset.create({
    data: {
      bucket: input.bucket,
      bytes: BigInt(input.bytes),
      contentType: input.contentType,
      declaredChecksum: input.declaredChecksum,
      etag: input.etag,
      id: createId(),
      instagramPostId: input.instagramPostId,
      objectKey: input.objectKey,
      objectVersion: input.objectVersion,
      region: input.region,
      state: "PENDING_VALIDATION",
      uploadIntentId: input.uploadIntentId,
      workspaceId: context.workspaceId,
    },
    select: assetSelect,
  });
}

export type ExpiredUploadIntent = Readonly<{
  id: string;
  objectKey: string;
  providerUploadId: string;
  workspaceId: string;
}>;

/**
 * Finds pending intents whose upload window has closed.
 *
 * This is intentionally not workspace-scoped: the sweep runs as the system
 * across every workspace, and each result carries the workspace it belongs to
 * so the caller can act within the right context.
 */
export async function listExpiredVideoUploadIntents(
  executor: UploadExecutor,
  input: Readonly<{ expiredBefore: Date; limit: number }>,
): Promise<readonly ExpiredUploadIntent[]> {
  const rows = await executor.videoUploadIntent.findMany({
    orderBy: { expiresAt: "asc" },
    select: { id: true, objectKey: true, providerUploadId: true, workspaceId: true },
    take: input.limit,
    where: { expiresAt: { lt: input.expiredBefore }, state: "PENDING" },
  });

  return Object.freeze(rows.map((row) => Object.freeze(row)));
}
