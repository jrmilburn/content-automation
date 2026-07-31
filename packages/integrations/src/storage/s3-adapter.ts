import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  HeadObjectCommand,
  ListMultipartUploadsCommand,
  NotFound,
  S3Client,
  UploadPartCommand,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { ObjectStorageConfig, ObjectStorageCredentials } from "@studio-parallel/config";

import {
  type AbandonedUpload,
  type CompletedPart,
  type CreateMultipartUploadRequest,
  type ListAbandonedUploadsRequest,
  type MultipartUploadHandle,
  type ObjectStorageAdapter,
  ObjectStorageError,
  type SignedPartInstruction,
  type StoredObjectMetadata,
} from "./contract.js";

export type S3ObjectStorageDependencies = Readonly<{
  config: ObjectStorageConfig;
  credentials: ObjectStorageCredentials;
  now?: (() => Date) | undefined;
}>;

// ListMultipartUploads pages in key order, not initiation order, so a bucket
// with many fresh uploads can push the abandoned ones past a single page. The
// sweep walks a bounded number of pages rather than pretending one is enough;
// anything still unseen is collected by the next scheduled sweep.
const maxAbandonedListPages = 10;

function toStoredObjectMetadata(
  source: Readonly<{
    ContentLength?: number | undefined;
    ContentType?: string | undefined;
    ETag?: string | undefined;
    VersionId?: string | undefined;
  }>,
  operation: string,
): StoredObjectMetadata {
  // A response without an ETag means the provider did not store an object we
  // can identify, so fail rather than invent one.
  if (source.ETag === undefined) {
    throw new ObjectStorageError(operation);
  }

  return Object.freeze({
    bytes: source.ContentLength ?? 0,
    contentType: source.ContentType ?? null,
    // S3 quotes ETags; strip them so stored values compare cleanly.
    etag: source.ETag.replaceAll('"', ""),
    objectVersion: source.VersionId ?? null,
  });
}

export function createS3ObjectStorageAdapter(
  dependencies: S3ObjectStorageDependencies,
): ObjectStorageAdapter {
  const { config, credentials } = dependencies;
  const now = dependencies.now ?? (() => new Date());
  const bucket = config.STORAGE_BUCKET;

  const client = new S3Client({
    credentials: {
      accessKeyId: credentials.STORAGE_ACCESS_KEY_ID,
      secretAccessKey: credentials.STORAGE_SECRET_ACCESS_KEY,
    },
    forcePathStyle: config.STORAGE_FORCE_PATH_STYLE,
    region: config.STORAGE_REGION,
    ...(config.STORAGE_ENDPOINT === undefined ? {} : { endpoint: config.STORAGE_ENDPOINT }),
  });

  async function headObject(objectKey: string): Promise<StoredObjectMetadata | null> {
    try {
      const head = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: objectKey }));

      return toStoredObjectMetadata(head, "headObject");
    } catch (error) {
      if (error instanceof NotFound) {
        return null;
      }

      throw new ObjectStorageError("headObject", error);
    }
  }

  async function abortMultipartUpload(handle: MultipartUploadHandle): Promise<void> {
    try {
      await client.send(
        new AbortMultipartUploadCommand({
          Bucket: bucket,
          Key: handle.objectKey,
          UploadId: handle.providerUploadId,
        }),
      );
    } catch (error) {
      // An upload the provider has already discarded is the desired end state,
      // so a missing upload counts as success and the sweep stays idempotent.
      if (error instanceof NotFound) {
        return;
      }

      throw new ObjectStorageError("abortMultipartUpload", error);
    }
  }

  async function completeMultipartUpload(
    handle: MultipartUploadHandle,
    parts: readonly CompletedPart[],
  ): Promise<StoredObjectMetadata> {
    let completedVersion: string | null;

    try {
      const completed = await client.send(
        new CompleteMultipartUploadCommand({
          Bucket: bucket,
          Key: handle.objectKey,
          MultipartUpload: {
            Parts: [...parts]
              .sort((left, right) => left.partNumber - right.partNumber)
              .map((part) => ({ ETag: part.etag, PartNumber: part.partNumber })),
          },
          UploadId: handle.providerUploadId,
        }),
      );

      completedVersion = completed.VersionId ?? null;
    } catch (error) {
      throw new ObjectStorageError("completeMultipartUpload", error);
    }

    // CompleteMultipartUpload does not report the stored byte count, and the
    // browser's claim is not evidence. Read the object back so callers only
    // ever compare against server-observed metadata.
    const observed = await headObject(handle.objectKey);

    if (observed === null) {
      throw new ObjectStorageError("completeMultipartUpload");
    }

    return Object.freeze({
      bytes: observed.bytes,
      contentType: observed.contentType,
      etag: observed.etag,
      objectVersion: observed.objectVersion ?? completedVersion,
    });
  }

  async function createMultipartUpload(
    request: CreateMultipartUploadRequest,
  ): Promise<MultipartUploadHandle> {
    let uploadId: string | undefined;

    try {
      const created = await client.send(
        new CreateMultipartUploadCommand({
          Bucket: bucket,
          ContentType: request.contentType,
          Key: request.objectKey,
          // Provider-managed keys are accepted for v1 by the storage policy.
          ServerSideEncryption: "AES256",
        }),
      );

      uploadId = created.UploadId;
    } catch (error) {
      throw new ObjectStorageError("createMultipartUpload", error);
    }

    if (uploadId === undefined) {
      throw new ObjectStorageError("createMultipartUpload");
    }

    return Object.freeze({ objectKey: request.objectKey, providerUploadId: uploadId });
  }

  async function listAbandonedUploads(
    request: ListAbandonedUploadsRequest,
  ): Promise<readonly AbandonedUpload[]> {
    const abandoned: AbandonedUpload[] = [];
    let keyMarker: string | undefined;
    let uploadIdMarker: string | undefined;

    try {
      for (let page = 0; page < maxAbandonedListPages; page += 1) {
        const listed = await client.send(
          new ListMultipartUploadsCommand({
            Bucket: bucket,
            ...(keyMarker === undefined ? {} : { KeyMarker: keyMarker }),
            ...(uploadIdMarker === undefined ? {} : { UploadIdMarker: uploadIdMarker }),
          }),
        );

        for (const upload of listed.Uploads ?? []) {
          if (
            upload.Key === undefined ||
            upload.UploadId === undefined ||
            upload.Initiated === undefined ||
            upload.Initiated.getTime() >= request.initiatedBefore.getTime()
          ) {
            continue;
          }

          abandoned.push(
            Object.freeze({
              initiatedAt: upload.Initiated,
              objectKey: upload.Key,
              providerUploadId: upload.UploadId,
            }),
          );

          if (abandoned.length >= request.limit) {
            return Object.freeze(abandoned);
          }
        }

        if (listed.IsTruncated !== true) {
          break;
        }

        keyMarker = listed.NextKeyMarker;
        uploadIdMarker = listed.NextUploadIdMarker;
      }
    } catch (error) {
      throw new ObjectStorageError("listAbandonedUploads", error);
    }

    return Object.freeze(abandoned);
  }

  async function signPartUpload(
    handle: MultipartUploadHandle,
    partNumber: number,
  ): Promise<SignedPartInstruction> {
    try {
      // The signature covers this bucket, key, upload and part number under PUT
      // only, so it cannot be replayed against another object or method.
      const url = await getSignedUrl(
        client,
        new UploadPartCommand({
          Bucket: bucket,
          Key: handle.objectKey,
          PartNumber: partNumber,
          UploadId: handle.providerUploadId,
        }),
        { expiresIn: config.UPLOAD_SIGNED_URL_TTL_SECONDS },
      );

      return Object.freeze({
        expiresAt: new Date(now().getTime() + config.UPLOAD_SIGNED_URL_TTL_SECONDS * 1000),
        partNumber,
        url,
      });
    } catch (error) {
      throw new ObjectStorageError("signPartUpload", error);
    }
  }

  return Object.freeze({
    abortMultipartUpload,
    completeMultipartUpload,
    createMultipartUpload,
    headObject,
    listAbandonedUploads,
    signPartUpload,
  });
}
