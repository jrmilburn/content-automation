import "server-only";

import {
  closeVideoUploadIntent,
  createVideoAsset,
  createVideoUploadIntent,
  createWorkspaceContext,
  createWorkspaceRepositories,
  enqueueBackgroundJob,
  findVideoAssetForIntent,
  findVideoUploadIntent,
  isUuidV7,
  uploadIntentAbortedAction,
  uploadIntentCompletedAction,
  uploadIntentInitiatedAction,
  videoAssetResourceType,
  videoUploadIntentResourceType,
  type SessionPrincipal,
  type VideoUploadIntentRecord,
} from "@studio-parallel/db";
import {
  evaluateUploadAdmission,
  hasUniquePartNumbers,
  videoAssetValidationKey,
  type CompleteUploadRequest,
} from "@studio-parallel/domain";
import { createSourceVideoObjectKey } from "@studio-parallel/integrations";

import { getDatabase } from "./database";
import { getObjectStorage, getObjectStorageConfig } from "./object-storage";

/**
 * Server-authorised source-video upload.
 *
 * The browser is never trusted with anything that decides where bytes land. It
 * asks to upload for a post; the server proves the post belongs to the caller's
 * workspace, invents the object key, fixes the byte ceiling and part size, and
 * hands back only short-lived signatures scoped to that one key. A crafted post
 * id, a crafted intent id and an id belonging to another workspace are all
 * refused identically, so none of them can be used to discover what exists.
 *
 * Completion never believes the browser about what was stored. It re-reads the
 * object from the provider and compares server-observed bytes against what was
 * declared when the upload was reserved, then publishes an asset that is
 * explicitly pending validation. Nothing here can mark a video ready.
 */

export type UploadRefusalReason =
  | "CONTENT_TYPE_NOT_ACCEPTED"
  | "EMPTY_FILE"
  | "INTENT_NOT_FOUND"
  | "INTENT_NOT_PENDING"
  | "OBJECT_MISSING"
  | "PART_NUMBER_OUT_OF_RANGE"
  | "POST_NOT_FOUND"
  | "SIZE_MISMATCH"
  | "STORAGE_UNAVAILABLE"
  | "TOO_LARGE"
  | "UPLOAD_ALREADY_PENDING"
  | "UPLOAD_EXPIRED"
  | "DUPLICATE_PART";

export type InitiateUploadResult =
  | Readonly<{
      initiated: true;
      expiresAt: Date;
      intentId: string;
      partCount: number;
      partSizeBytes: number;
    }>
  | Readonly<{ initiated: false; reason: UploadRefusalReason }>;

export type SignPartResult =
  | Readonly<{ signed: true; expiresAt: Date; partNumber: number; url: string }>
  | Readonly<{ signed: false; reason: UploadRefusalReason }>;

export type CompleteUploadResult =
  | Readonly<{ completed: true; alreadyCompleted: boolean; assetId: string; bytes: number }>
  | Readonly<{ completed: false; reason: UploadRefusalReason }>;

export type AbortUploadResult =
  | Readonly<{ aborted: true; alreadyClosed: boolean }>
  | Readonly<{ aborted: false; reason: UploadRefusalReason }>;

type CommandContext = Readonly<{
  actor: SessionPrincipal;
  correlationId: string;
}>;

/**
 * Loads a pending intent the caller is allowed to act on.
 *
 * An intent that does not exist, belongs to another workspace, or has already
 * reached a terminal state is distinguished only where the difference is safe
 * to reveal: a caller who owns an intent may be told it is no longer pending,
 * but a caller who owns nothing is told only that it was not found.
 */
async function loadPendingIntent(
  context: CommandContext,
  intentId: string,
  now: Date,
): Promise<
  | Readonly<{ intent: VideoUploadIntentRecord; ok: true }>
  | Readonly<{ ok: false; reason: UploadRefusalReason }>
> {
  if (!isUuidV7(intentId)) {
    return Object.freeze({ ok: false as const, reason: "INTENT_NOT_FOUND" as const });
  }

  const workspace = createWorkspaceContext(context.actor.workspaceId);
  const intent = await findVideoUploadIntent(getDatabase(), workspace, intentId);

  if (intent === null) {
    return Object.freeze({ ok: false as const, reason: "INTENT_NOT_FOUND" as const });
  }

  if (intent.state !== "PENDING") {
    return Object.freeze({ ok: false as const, reason: "INTENT_NOT_PENDING" as const });
  }

  if (intent.expiresAt.getTime() <= now.getTime()) {
    return Object.freeze({ ok: false as const, reason: "UPLOAD_EXPIRED" as const });
  }

  return Object.freeze({ intent, ok: true as const });
}

export async function initiateVideoUpload(
  input: CommandContext &
    Readonly<{
      declaredBytes: number;
      declaredContentType: string;
      now?: Date | undefined;
      postId: string;
    }>,
): Promise<InitiateUploadResult> {
  const { actor, correlationId, declaredBytes, declaredContentType, postId } = input;
  const now = input.now ?? new Date();
  const database = getDatabase();
  const workspace = createWorkspaceContext(actor.workspaceId);
  const repositories = createWorkspaceRepositories(database, workspace);
  const config = getObjectStorageConfig();

  const refuse = async (reason: UploadRefusalReason): Promise<InitiateUploadResult> => {
    await repositories.audit.record({
      action: uploadIntentInitiatedAction,
      actor: { type: "USER", userId: actor.internalUserId },
      correlationId,
      outcome: "REFUSED",
      reasonCode: reason,
      resourceType: videoUploadIntentResourceType,
    });

    return Object.freeze({ initiated: false as const, reason });
  };

  // A crafted identifier is refused with the same reason as an absent post, so
  // neither can be used to probe another workspace.
  if (!isUuidV7(postId)) {
    return refuse("POST_NOT_FOUND");
  }

  const post = await database.instagramPost.findFirst({
    select: { id: true },
    where: { id: postId, workspaceId: actor.workspaceId },
  });

  if (!post) {
    return refuse("POST_NOT_FOUND");
  }

  const admission = evaluateUploadAdmission({
    declaredBytes,
    declaredContentType,
    maxBytes: config.UPLOAD_MAX_BYTES,
    partSizeBytes: config.UPLOAD_PART_SIZE_BYTES,
  });

  if (!admission.admitted) {
    return refuse(admission.reason);
  }

  const objectKey = createSourceVideoObjectKey({
    environment: config.APP_ENV,
    workspaceId: actor.workspaceId,
  });

  // The provider call happens before the insert so a failed reservation leaves
  // no database row claiming an upload that does not exist.
  let providerUploadId: string;

  try {
    const handle = await getObjectStorage().createMultipartUpload({
      contentType: declaredContentType,
      objectKey,
    });

    providerUploadId = handle.providerUploadId;
  } catch {
    return refuse("STORAGE_UNAVAILABLE");
  }

  const expiresAt = new Date(now.getTime() + config.UPLOAD_ABANDON_AFTER_HOURS * 60 * 60 * 1000);

  let intent: VideoUploadIntentRecord;

  try {
    intent = await createVideoUploadIntent(database, workspace, {
      bucket: config.STORAGE_BUCKET,
      createdByUserId: actor.internalUserId,
      declaredBytes,
      declaredContentType,
      expiresAt,
      instagramPostId: post.id,
      objectKey,
      partCount: admission.partCount,
      partSizeBytes: admission.partSizeBytes,
      providerUploadId,
      region: config.STORAGE_REGION,
    });
  } catch {
    // The unique index on the pending marker is what enforces one pending
    // upload per post, so the collision surfaces here rather than from a
    // check that could race. Release the provider reservation we just made.
    await getObjectStorage()
      .abortMultipartUpload({ objectKey, providerUploadId })
      .catch(() => undefined);

    return refuse("UPLOAD_ALREADY_PENDING");
  }

  await repositories.audit.record({
    action: uploadIntentInitiatedAction,
    actor: { type: "USER", userId: actor.internalUserId },
    correlationId,
    outcome: "RESERVED",
    resourceId: intent.id,
    resourceType: videoUploadIntentResourceType,
  });

  return Object.freeze({
    expiresAt: intent.expiresAt,
    initiated: true as const,
    intentId: intent.id,
    partCount: intent.partCount,
    partSizeBytes: intent.partSizeBytes,
  });
}

export async function signVideoUploadPart(
  input: CommandContext &
    Readonly<{ intentId: string; now?: Date | undefined; partNumber: number }>,
): Promise<SignPartResult> {
  const now = input.now ?? new Date();
  const loaded = await loadPendingIntent(input, input.intentId, now);

  if (!loaded.ok) {
    return Object.freeze({ reason: loaded.reason, signed: false as const });
  }

  const { intent } = loaded;

  // Part numbers outside the reserved range would sign an upload larger than
  // the ceiling the server admitted.
  if (
    !Number.isSafeInteger(input.partNumber) ||
    input.partNumber < 1 ||
    input.partNumber > intent.partCount
  ) {
    return Object.freeze({
      reason: "PART_NUMBER_OUT_OF_RANGE" as const,
      signed: false as const,
    });
  }

  try {
    const instruction = await getObjectStorage().signPartUpload(
      { objectKey: intent.objectKey, providerUploadId: intent.providerUploadId },
      input.partNumber,
    );

    return Object.freeze({
      expiresAt: instruction.expiresAt,
      partNumber: instruction.partNumber,
      signed: true as const,
      url: instruction.url,
    });
  } catch {
    return Object.freeze({ reason: "STORAGE_UNAVAILABLE" as const, signed: false as const });
  }
}

export async function completeVideoUpload(
  input: CommandContext &
    Readonly<{
      intentId: string;
      now?: Date | undefined;
      request: CompleteUploadRequest;
    }>,
): Promise<CompleteUploadResult> {
  const { actor, correlationId, request } = input;
  const now = input.now ?? new Date();
  const database = getDatabase();
  const workspace = createWorkspaceContext(actor.workspaceId);
  const repositories = createWorkspaceRepositories(database, workspace);
  const config = getObjectStorageConfig();

  const refuse = async (reason: UploadRefusalReason): Promise<CompleteUploadResult> => {
    await repositories.audit.record({
      action: uploadIntentCompletedAction,
      actor: { type: "USER", userId: actor.internalUserId },
      correlationId,
      outcome: "REFUSED",
      reasonCode: reason,
      resourceType: videoUploadIntentResourceType,
    });

    return Object.freeze({ completed: false as const, reason });
  };

  if (!isUuidV7(input.intentId)) {
    return refuse("INTENT_NOT_FOUND");
  }

  const intent = await findVideoUploadIntent(database, workspace, input.intentId);

  if (intent === null) {
    return refuse("INTENT_NOT_FOUND");
  }

  // A retried completion must resolve to the asset the first call published
  // rather than creating a second one or reading as a failure.
  if (intent.state !== "PENDING") {
    const existing = await findVideoAssetForIntent(database, workspace, intent.id);

    if (existing !== null) {
      return Object.freeze({
        alreadyCompleted: true,
        assetId: existing.id,
        bytes: Number(existing.bytes),
        completed: true as const,
      });
    }

    return refuse("INTENT_NOT_PENDING");
  }

  if (!hasUniquePartNumbers(request.parts)) {
    return refuse("DUPLICATE_PART");
  }

  if (request.parts.some((part) => part.partNumber > intent.partCount)) {
    return refuse("PART_NUMBER_OUT_OF_RANGE");
  }

  const storage = getObjectStorage();
  let stored;

  try {
    stored = await storage.completeMultipartUpload(
      { objectKey: intent.objectKey, providerUploadId: intent.providerUploadId },
      request.parts,
    );
  } catch {
    return refuse("STORAGE_UNAVAILABLE");
  }

  // The declared byte count was a browser claim. What the provider actually
  // stored is the only figure allowed to reach the asset record, and a
  // mismatch means the upload is not the file that was admitted.
  if (stored.bytes !== Number(intent.declaredBytes)) {
    await storage
      .abortMultipartUpload({
        objectKey: intent.objectKey,
        providerUploadId: intent.providerUploadId,
      })
      .catch(() => undefined);
    await closeVideoUploadIntent(database, workspace, {
      intentId: intent.id,
      state: "ABORTED",
    });

    return refuse("SIZE_MISMATCH");
  }

  if (stored.bytes > config.UPLOAD_MAX_BYTES) {
    return refuse("TOO_LARGE");
  }

  const closed = await closeVideoUploadIntent(database, workspace, {
    completedAt: now,
    intentId: intent.id,
    state: "COMPLETED",
  });

  if (!closed) {
    // Another request completed this intent between the read and the update.
    const existing = await findVideoAssetForIntent(database, workspace, intent.id);

    if (existing !== null) {
      return Object.freeze({
        alreadyCompleted: true,
        assetId: existing.id,
        bytes: Number(existing.bytes),
        completed: true as const,
      });
    }

    return refuse("INTENT_NOT_PENDING");
  }

  const asset = await createVideoAsset(database, workspace, {
    bucket: intent.bucket,
    bytes: stored.bytes,
    contentType: stored.contentType,
    declaredChecksum: request.checksumSha256 ?? null,
    etag: stored.etag,
    instagramPostId: intent.instagramPostId,
    objectKey: intent.objectKey,
    objectVersion: stored.objectVersion,
    region: intent.region,
    uploadIntentId: intent.id,
  });

  // Keyed by the asset, so a replayed completion that resolves to the same
  // asset enqueues nothing new. A failure to enqueue must not undo a stored
  // object: the reconciliation sweep picks up an asset left unvalidated.
  await enqueueBackgroundJob(database, workspace, {
    correlationId,
    handlerVersion: 1,
    idempotencyKey: videoAssetValidationKey(asset.id),
    queueName: "asset.validate",
    resourceId: asset.id,
    resourceType: videoAssetResourceType,
  });

  await repositories.audit.record({
    action: uploadIntentCompletedAction,
    actor: { type: "USER", userId: actor.internalUserId },
    correlationId,
    outcome: "STORED",
    resourceId: asset.id,
    resourceType: videoAssetResourceType,
  });

  return Object.freeze({
    alreadyCompleted: false,
    assetId: asset.id,
    bytes: stored.bytes,
    completed: true as const,
  });
}

export async function abortVideoUpload(
  input: CommandContext & Readonly<{ intentId: string }>,
): Promise<AbortUploadResult> {
  const { actor, correlationId, intentId } = input;
  const database = getDatabase();
  const workspace = createWorkspaceContext(actor.workspaceId);
  const repositories = createWorkspaceRepositories(database, workspace);

  if (!isUuidV7(intentId)) {
    return Object.freeze({ aborted: false as const, reason: "INTENT_NOT_FOUND" as const });
  }

  const intent = await findVideoUploadIntent(database, workspace, intentId);

  if (intent === null) {
    return Object.freeze({ aborted: false as const, reason: "INTENT_NOT_FOUND" as const });
  }

  // Abandoning an already-closed upload is the desired end state, so it is
  // reported as no change rather than as an error.
  if (intent.state !== "PENDING") {
    return Object.freeze({ aborted: true as const, alreadyClosed: true });
  }

  await getObjectStorage()
    .abortMultipartUpload({
      objectKey: intent.objectKey,
      providerUploadId: intent.providerUploadId,
    })
    .catch(() => undefined);

  const closed = await closeVideoUploadIntent(database, workspace, {
    intentId: intent.id,
    state: "ABORTED",
  });

  await repositories.audit.record({
    action: uploadIntentAbortedAction,
    actor: { type: "USER", userId: actor.internalUserId },
    correlationId,
    outcome: closed ? "ABORTED" : "NO_CHANGE",
    resourceId: intent.id,
    resourceType: videoUploadIntentResourceType,
  });

  return Object.freeze({ aborted: true as const, alreadyClosed: !closed });
}
