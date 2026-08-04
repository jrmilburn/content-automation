import type { Prisma, PrismaClient, VideoAssetRejectionCode } from "./generated/prisma/client.js";
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

export type CreateImportedVideoAssetInput = Readonly<{
  bucket: string;
  bytes: number;
  contentType: string;
  etag: string;
  importJobId: string;
  instagramPostId: string;
  objectKey: string;
  objectVersion: string | null;
  region: string;
}>;

/**
 * Publishes the asset one import produced.
 *
 * Like the upload path it starts PENDING_VALIDATION: bytes that came from the
 * provider get no more trust than bytes that came from a browser, and only the
 * probe may publish either.
 *
 * There is no declared checksum, because there was no second party to declare
 * one. Validation still computes the verified checksum as it streams.
 */
export async function createImportedVideoAsset(
  executor: UploadExecutor,
  context: WorkspaceContext,
  input: CreateImportedVideoAssetInput,
): Promise<VideoAssetRecord> {
  return executor.videoAsset.create({
    data: {
      bucket: input.bucket,
      bytes: BigInt(input.bytes),
      contentType: input.contentType,
      etag: input.etag,
      id: createId(),
      importJobId: input.importJobId,
      instagramPostId: input.instagramPostId,
      objectKey: input.objectKey,
      objectVersion: input.objectVersion,
      origin: "PROVIDER_IMPORT",
      region: input.region,
      state: "PENDING_VALIDATION",
      workspaceId: context.workspaceId,
    },
    select: assetSelect,
  });
}

/**
 * The asset a given import job already created, if it created one.
 *
 * This is what makes a redelivered import safe: the unique anchor means the
 * second delivery finds the first delivery's asset instead of downloading the
 * video again and writing a second object.
 */
export async function findVideoAssetForImportJob(
  executor: UploadExecutor,
  context: WorkspaceContext,
  importJobId: string,
): Promise<VideoAssetRecord | null> {
  return executor.videoAsset.findFirst({
    select: assetSelect,
    where: { importJobId, workspaceId: context.workspaceId },
  });
}

/** Everything validation needs to judge one asset, read in a single query. */
export type VideoAssetForValidation = Readonly<{
  bytes: bigint;
  declaredChecksum: string | null;
  id: string;
  instagramPostId: string;
  objectKey: string;
  state: "PENDING_VALIDATION" | "READY" | "REJECTED";
  /**
   * What the asset's source claimed its type was, before any probe ran.
   *
   * For an upload that is the browser's claim, recorded on the intent when the
   * server authorised it. For a provider import there is no intent and no
   * browser, so it is the type the provider's response carried. Either way it
   * is an unverified claim, which is exactly what the validation policy needs:
   * it checks the claim against the container header and the probe, and refuses
   * when the three disagree.
   */
  declaredContentType: string;
}>;

export async function findVideoAssetForValidation(
  executor: UploadExecutor,
  context: WorkspaceContext,
  assetId: string,
): Promise<VideoAssetForValidation | null> {
  const asset = await executor.videoAsset.findFirst({
    select: {
      ...assetSelect,
      contentType: true,
      declaredChecksum: true,
      // For an upload the claim lives on the intent, which is the record of what
      // the browser said when the server authorised it. An import has no intent,
      // so its claim is the content type recorded from the provider's response.
      uploadIntent: { select: { declaredContentType: true } },
    },
    where: { id: assetId, workspaceId: context.workspaceId },
  });

  if (asset === null) {
    return null;
  }

  const declaredContentType = asset.uploadIntent?.declaredContentType ?? asset.contentType;

  // An asset with no claim at all cannot be validated: the policy compares the
  // claim against the header and the probe, and a missing claim would quietly
  // reduce that to a two-way check.
  if (declaredContentType === null) {
    return null;
  }

  return Object.freeze({
    bytes: asset.bytes,
    declaredChecksum: asset.declaredChecksum,
    declaredContentType,
    id: asset.id,
    instagramPostId: asset.instagramPostId,
    objectKey: asset.objectKey,
    state: asset.state,
  });
}

export type RecordVideoAssetValidationInput = Readonly<{
  assetId: string;
  audioCodec?: string | null | undefined;
  containerFormat?: string | null | undefined;
  durationMs?: number | null | undefined;
  heightPx?: number | null | undefined;
  purgeAfter?: Date | null | undefined;
  rejectionCode?: VideoAssetRejectionCode | null | undefined;
  state: "READY" | "REJECTED";
  validatedAt: Date;
  verifiedChecksum?: string | null | undefined;
  videoCodec?: string | null | undefined;
  widthPx?: number | null | undefined;
}>;

/**
 * Records one terminal validation outcome.
 *
 * The update is conditional on the asset still being PENDING_VALIDATION, so a
 * redelivered job cannot overwrite a verdict that already landed, and a failed
 * replacement can never displace an asset that is already READY. The boolean
 * says whether this call was the one that decided the outcome.
 */
export async function recordVideoAssetValidation(
  executor: UploadExecutor,
  context: WorkspaceContext,
  input: RecordVideoAssetValidationInput,
): Promise<boolean> {
  const updated = await executor.videoAsset.updateMany({
    data: {
      audioCodec: input.audioCodec ?? null,
      containerFormat: input.containerFormat ?? null,
      durationMs: input.durationMs ?? null,
      heightPx: input.heightPx ?? null,
      purgeAfter: input.purgeAfter ?? null,
      rejectionCode: input.rejectionCode ?? null,
      state: input.state,
      validatedAt: input.validatedAt,
      verifiedChecksum: input.verifiedChecksum ?? null,
      videoCodec: input.videoCodec ?? null,
      widthPx: input.widthPx ?? null,
    },
    where: {
      id: input.assetId,
      state: "PENDING_VALIDATION",
      workspaceId: context.workspaceId,
    },
  });

  return updated.count === 1;
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

export type PurgeableVideoAsset = Readonly<{
  id: string;
  objectKey: string;
  workspaceId: string;
}>;

/**
 * Finds rejected assets whose stored object is now due for deletion.
 *
 * Like the intent sweep this runs as the system across every workspace, and
 * each row carries its own workspace so the caller acts in the right context.
 * `purgedAt` being null is what makes a repeated sweep skip work already done.
 */
export async function listPurgeableVideoAssets(
  executor: UploadExecutor,
  input: Readonly<{ dueBefore: Date; limit: number }>,
): Promise<readonly PurgeableVideoAsset[]> {
  const rows = await executor.videoAsset.findMany({
    orderBy: { purgeAfter: "asc" },
    select: { id: true, objectKey: true, workspaceId: true },
    take: input.limit,
    where: {
      purgeAfter: { lt: input.dueBefore },
      purgedAt: null,
      state: "REJECTED",
    },
  });

  return Object.freeze(rows.map((row) => Object.freeze(row)));
}

/**
 * Records that a rejected asset's stored object has been deleted.
 *
 * Conditional on `purgedAt` still being null so two racing sweeps cannot both
 * believe they purged it. The rejection metadata stays on the row: the object
 * is gone, but why it was refused remains answerable.
 */
export async function markVideoAssetPurged(
  executor: UploadExecutor,
  context: WorkspaceContext,
  input: Readonly<{ assetId: string; purgedAt: Date }>,
): Promise<boolean> {
  const updated = await executor.videoAsset.updateMany({
    data: { purgedAt: input.purgedAt },
    where: {
      id: input.assetId,
      purgedAt: null,
      state: "REJECTED",
      workspaceId: context.workspaceId,
    },
  });

  return updated.count === 1;
}
