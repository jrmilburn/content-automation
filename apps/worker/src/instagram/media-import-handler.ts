import type { ObjectStorageConfig } from "@studio-parallel/config";
import {
  createImportedVideoAsset,
  createWorkspaceContext,
  createWorkspaceRepositories,
  decryptCredential,
  enqueueBackgroundJobInTransaction,
  findVideoAssetForImportJob,
  instagramPostResourceType,
  runIdempotentJobHandler,
  videoAssetResourceType,
  type DatabaseClient,
  type JobHandlerExecutionContext,
  type TransactionalJobResult,
} from "@studio-parallel/db";
import {
  isImportableInstagramMediaKind,
  JobHandlerFailure,
  videoAssetValidationKey,
  type QueueHandlerRegistration,
  type QueueJobEnvelope,
} from "@studio-parallel/domain";
import {
  createDerivedSourceVideoObjectKey,
  type ObjectStorageAdapter,
} from "@studio-parallel/integrations";
import { parseCorrelationId, type JsonLogger } from "@studio-parallel/observability";

import { withHeartbeat } from "../heartbeat.js";
import { fetchInstagramMediaItem, InstagramMediaError } from "./media-client.js";
import {
  InstagramMediaDownloadError,
  limitStream,
  openInstagramMediaDownload,
} from "./media-download.js";

/**
 * Copies one post's own Instagram video into private storage as its source
 * asset.
 *
 * The copy is the file Instagram serves, not the master the account owner
 * filmed, which is why the asset it creates records its origin. It is otherwise
 * treated exactly like an upload: it lands PENDING_VALIDATION and the ordinary
 * `asset.validate` job decides whether it is analysable. Nothing here may
 * publish a video the probe has not seen.
 *
 * The signed media URL is fetched at the moment of use and never stored. Meta
 * re-signs it on every request, so a value kept from an earlier read is a URL
 * that has already started refusing.
 *
 * Ordering matters on the failure path. The object is written before the row
 * exists, so the key is derived from this job rather than minted afresh: a
 * retry overwrites its own previous attempt instead of leaving bytes in the
 * bucket that no row points at and no purge sweep can find.
 */

export const instagramMediaImportQueue = { name: "instagram.media.import", version: 1 } as const;

export type InstagramMediaImportDependencies = Readonly<{
  acquireConcurrency?: ((signal: AbortSignal) => Promise<() => void>) | undefined;
  database: DatabaseClient;
  /** Prefixes the object key, keeping production objects out of other buckets. */
  environment: string;
  loadMasterKeys: () => ReadonlyMap<number, Buffer>;
  logger: JsonLogger;
  now?: (() => Date) | undefined;
  storage: ObjectStorageAdapter;
  storageConfig: ObjectStorageConfig;
}>;

type ImportablePost = Readonly<{
  accountId: string;
  id: string;
  mediaKind: string;
  providerMediaId: string;
}>;

export function createInstagramMediaImportHandler(
  dependencies: InstagramMediaImportDependencies,
): QueueHandlerRegistration {
  return Object.freeze({
    handler: async (envelope: QueueJobEnvelope, context: { signal: AbortSignal }) => {
      const workspace = createWorkspaceContext(envelope.workspaceId);

      await runIdempotentJobHandler({
        context: workspace,
        database: dependencies.database,
        envelope,
        execute: async (execution: JobHandlerExecutionContext): Promise<TransactionalJobResult> => {
          const correlationId = parseCorrelationId(envelope.correlationId);

          if (!correlationId) {
            throw new JobHandlerFailure({
              errorClass: "INVALID_INPUT",
              errorCode: "MEDIA_IMPORT_CORRELATION_INVALID",
            });
          }

          await execution.recordStage("loading_post");

          const job = await dependencies.database.backgroundJob.findFirst({
            select: { resourceId: true, resourceType: true },
            where: { id: execution.jobId, workspaceId: workspace.workspaceId },
          });

          if (!job?.resourceId || job.resourceType !== instagramPostResourceType) {
            // Nothing identifiable to import; a retry cannot discover a resource
            // the job never carried.
            return Object.freeze({ commit: async () => undefined });
          }

          // A redelivery that already produced an asset must not download the
          // video a second time.
          const existing = await findVideoAssetForImportJob(
            dependencies.database,
            workspace,
            execution.jobId,
          );

          if (existing !== null) {
            return Object.freeze({ commit: async () => undefined });
          }

          const post = await loadImportablePost(dependencies, workspace, job.resourceId);

          if (post === null) {
            return Object.freeze({ commit: async () => undefined });
          }

          // Answered without touching the provider: an image has no video to
          // fetch, whatever the CDN would say about it.
          if (!isImportableInstagramMediaKind(post.mediaKind)) {
            throw new JobHandlerFailure({
              errorClass: "INVALID_INPUT",
              errorCode: "MEDIA_IMPORT_NOT_A_VIDEO",
            });
          }

          const release = await dependencies.acquireConcurrency?.(context.signal);

          try {
            const stored = await withHeartbeat(execution, async () => {
              await execution.recordStage("reading_media_url");

              const accessToken = await readAccessToken(dependencies, workspace, post.accountId);
              const item = await readMediaItem(dependencies, accessToken, post.providerMediaId);

              if (!item.mediaUrl) {
                // A video whose node carries no URL cannot be imported, and no
                // number of retries will add one.
                throw new JobHandlerFailure({
                  errorClass: "INVALID_INPUT",
                  errorCode: "MEDIA_IMPORT_URL_ABSENT",
                });
              }

              await execution.recordStage("transferring_media");

              return await transfer({
                dependencies,
                mediaUrl: item.mediaUrl,
                objectKey: importObjectKey(dependencies, workspace.workspaceId, execution.jobId),
              });
            });

            await execution.recordStage("recording_asset");

            return Object.freeze({
              commit: async (transaction) => {
                const asset = await createImportedVideoAsset(transaction, workspace, {
                  bucket: dependencies.storageConfig.STORAGE_BUCKET,
                  bytes: stored.bytes,
                  contentType: stored.contentType,
                  etag: stored.etag,
                  importJobId: execution.jobId,
                  instagramPostId: post.id,
                  objectKey: stored.objectKey,
                  objectVersion: stored.objectVersion,
                  region: dependencies.storageConfig.STORAGE_REGION,
                });

                // The same gate an upload goes through. An imported file gets no
                // more trust than one a person chose.
                await enqueueBackgroundJobInTransaction(transaction, workspace, {
                  correlationId: envelope.correlationId,
                  handlerVersion: 1,
                  idempotencyKey: videoAssetValidationKey(asset.id),
                  queueName: "asset.validate",
                  resourceId: asset.id,
                  resourceType: videoAssetResourceType,
                });

                dependencies.logger.info("video.asset.imported", {
                  correlationId,
                  stage: "media_import",
                  // Byte count only. Never the media URL, the object key or the
                  // post's provider identifier.
                  unit: "bytes",
                  value: stored.bytes,
                });
              },
            });
          } finally {
            release?.();
          }
        },
        logger: dependencies.logger,
        // The asset carrying this job's id is the durable evidence the work
        // landed, and it is unique, so a redelivery cannot produce a second one.
        resultExists: async (executor) =>
          (await executor.videoAsset.findFirst({
            select: { id: true },
            where: { importJobId: envelope.domainJobId, workspaceId: workspace.workspaceId },
          })) !== null,
        signal: context.signal,
      });
    },
    queue: instagramMediaImportQueue,
  });
}

/**
 * The object key for this job's attempt.
 *
 * Derived from the job rather than minted per attempt, so a retry writes over
 * its own earlier bytes. The job id is hashed rather than used directly because
 * it is a UUIDv7 and the key convention deliberately leaks neither creation
 * time nor neighbouring keys.
 */
function importObjectKey(
  dependencies: InstagramMediaImportDependencies,
  workspaceId: string,
  jobId: string,
): string {
  return createDerivedSourceVideoObjectKey({
    environment: dependencies.environment,
    seed: jobId,
    workspaceId,
  });
}

type TransferResult = Readonly<{
  bytes: number;
  contentType: string;
  etag: string;
  objectKey: string;
  objectVersion: string | null;
}>;

async function transfer(input: {
  dependencies: InstagramMediaImportDependencies;
  mediaUrl: string;
  objectKey: string;
}): Promise<TransferResult> {
  const maxBytes = input.dependencies.storageConfig.UPLOAD_MAX_BYTES;

  let download;
  try {
    download = await openInstagramMediaDownload({ mediaUrl: input.mediaUrl });
  } catch (error) {
    throw toDownloadFailure(error);
  }

  // Refused before a byte is stored when the provider is willing to say how
  // large the response is.
  if (download.declaredBytes !== null && download.declaredBytes > maxBytes) {
    await download.body.cancel().catch(() => undefined);
    throw new JobHandlerFailure({
      errorClass: "INVALID_INPUT",
      errorCode: "MEDIA_IMPORT_TOO_LARGE",
    });
  }

  try {
    const stored = await input.dependencies.storage.putObjectStream({
      body: limitStream(download.body, maxBytes),
      contentType: download.contentType,
      objectKey: input.objectKey,
    });

    return Object.freeze({
      bytes: stored.bytes,
      contentType: stored.contentType ?? download.contentType,
      etag: stored.etag,
      objectKey: input.objectKey,
      objectVersion: stored.objectVersion,
    });
  } catch (error) {
    throw toDownloadFailure(error);
  }
}

function toDownloadFailure(error: unknown): JobHandlerFailure {
  if (error instanceof JobHandlerFailure) return error;

  if (error instanceof InstagramMediaDownloadError) {
    return new JobHandlerFailure({
      errorClass: error.retryable ? "TRANSIENT" : "INVALID_INPUT",
      errorCode: `MEDIA_IMPORT_${error.reasonCode}`,
    });
  }

  // A storage fault is worth another attempt: the bytes are still at the
  // provider and the key is this job's own.
  return new JobHandlerFailure({
    errorClass: "TRANSIENT",
    errorCode: "MEDIA_IMPORT_STORAGE_UNAVAILABLE",
  });
}

async function readMediaItem(
  dependencies: InstagramMediaImportDependencies,
  accessToken: string,
  providerMediaId: string,
) {
  try {
    return await fetchInstagramMediaItem({ accessToken, providerMediaId });
  } catch (error) {
    if (error instanceof InstagramMediaError) {
      throw new JobHandlerFailure({
        errorClass:
          error.responseClass === "authorisation"
            ? "CREDENTIAL"
            : error.responseClass === "transient" || error.responseClass === "rate_limit"
              ? "TRANSIENT"
              : "INVALID_INPUT",
        errorCode: `MEDIA_IMPORT_${error.reasonCode}`,
      });
    }

    throw new JobHandlerFailure({
      errorClass: "TRANSIENT",
      errorCode: "MEDIA_IMPORT_MEDIA_ITEM_UNREACHABLE",
    });
  }
}

async function loadImportablePost(
  dependencies: InstagramMediaImportDependencies,
  workspace: ReturnType<typeof createWorkspaceContext>,
  postId: string,
): Promise<ImportablePost | null> {
  const post = await dependencies.database.instagramPost.findFirst({
    select: {
      id: true,
      instagramAccountId: true,
      mediaKind: true,
      providerMediaId: true,
    },
    where: { id: postId, workspaceId: workspace.workspaceId },
  });

  if (post === null) return null;

  return Object.freeze({
    accountId: post.instagramAccountId,
    id: post.id,
    mediaKind: post.mediaKind,
    providerMediaId: post.providerMediaId,
  });
}

async function readAccessToken(
  dependencies: InstagramMediaImportDependencies,
  workspace: ReturnType<typeof createWorkspaceContext>,
  accountId: string,
): Promise<string> {
  const credential = await createWorkspaceRepositories(
    dependencies.database,
    workspace,
  ).credentials.findActive({ accountId, integrationType: "INSTAGRAM" });

  if (!credential) {
    throw new JobHandlerFailure({
      errorClass: "CREDENTIAL",
      errorCode: "MEDIA_IMPORT_CREDENTIAL_MISSING",
    });
  }

  let masterKeys: ReadonlyMap<number, Buffer>;
  try {
    masterKeys = dependencies.loadMasterKeys();
  } catch {
    // An operator problem, not a reason to send the user to a reconnect button
    // that cannot help them.
    throw new JobHandlerFailure({
      errorClass: "UNKNOWN",
      errorCode: "MEDIA_IMPORT_ENCRYPTION_UNAVAILABLE",
    });
  }

  try {
    return decryptCredential({
      context: { accountId, integrationType: "INSTAGRAM", workspaceId: workspace.workspaceId },
      masterKeys,
      sealed: credential.ciphertext,
    });
  } catch {
    throw new JobHandlerFailure({
      errorClass: "CREDENTIAL",
      errorCode: "MEDIA_IMPORT_CREDENTIAL_UNREADABLE",
    });
  }
}
