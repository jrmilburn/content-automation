/**
 * Contract for private S3-compatible object storage.
 *
 * The adapter exists so the provider stays replaceable: Cloudflare R2 is the
 * documented default, AWS S3 and MinIO are the other tested endpoints, and no
 * caller above this boundary may assume which one is deployed. See
 * `docs/technical/architecture.md` and `docs/technical/video-ingestion.md`.
 *
 * Two rules hold for every implementation:
 *
 * 1. Storage credentials never leave the server. Callers receive signed URLs
 *    scoped to one exact key, method and part, never a credential.
 * 2. Nothing the browser reports is trusted. Byte counts, content type and
 *    checksums supplied by a client are advisory until the server observes the
 *    stored object itself.
 */

/** Identifies one in-flight multipart upload at the provider. */
export type MultipartUploadHandle = Readonly<{
  objectKey: string;
  providerUploadId: string;
}>;

/** A single short-lived, exact-scope signed instruction for one part. */
export type SignedPartInstruction = Readonly<{
  expiresAt: Date;
  partNumber: number;
  url: string;
}>;

/** A part the browser finished uploading, as reported back by the provider. */
export type CompletedPart = Readonly<{
  etag: string;
  partNumber: number;
}>;

/**
 * Object metadata as observed by the server, never as declared by a client.
 *
 * `etag` is a provider integrity token and explicitly not a cryptographic
 * checksum: for multipart objects S3 returns a composite of per-part digests.
 * The whole-object cryptographic checksum is produced when the validation
 * worker streams the object, so it is deliberately absent here.
 */
export type StoredObjectMetadata = Readonly<{
  bytes: number;
  contentType: string | null;
  etag: string;
  objectVersion: string | null;
}>;

/** A multipart upload the provider still holds but no client completed. */
export type AbandonedUpload = Readonly<{
  initiatedAt: Date;
  objectKey: string;
  providerUploadId: string;
}>;

export type CreateMultipartUploadRequest = Readonly<{
  contentType: string;
  objectKey: string;
}>;

export type ListAbandonedUploadsRequest = Readonly<{
  initiatedBefore: Date;
  limit: number;
}>;

/**
 * Raised when the provider rejects or cannot serve an operation. Callers
 * classify retryability; the adapter only reports what happened.
 */
export class ObjectStorageError extends Error {
  readonly operation: string;

  constructor(operation: string, cause?: unknown) {
    super(`Object storage operation failed: ${operation}`);
    this.name = "ObjectStorageError";
    this.operation = operation;

    if (cause !== undefined) {
      this.cause = cause;
    }
  }
}

export type ObjectStorageAdapter = Readonly<{
  abortMultipartUpload(handle: MultipartUploadHandle): Promise<void>;
  completeMultipartUpload(
    handle: MultipartUploadHandle,
    parts: readonly CompletedPart[],
  ): Promise<StoredObjectMetadata>;
  createMultipartUpload(request: CreateMultipartUploadRequest): Promise<MultipartUploadHandle>;
  /** Returns null when the object does not exist, rather than throwing. */
  headObject(objectKey: string): Promise<StoredObjectMetadata | null>;
  listAbandonedUploads(request: ListAbandonedUploadsRequest): Promise<readonly AbandonedUpload[]>;
  signPartUpload(handle: MultipartUploadHandle, partNumber: number): Promise<SignedPartInstruction>;
}>;
