import { createHash, randomUUID } from "node:crypto";

import {
  type AbandonedUpload,
  type CompletedPart,
  type CreateMultipartUploadRequest,
  type ListAbandonedUploadsRequest,
  type MultipartUploadHandle,
  type ObjectStorageAdapter,
  ObjectStorageError,
  type PutObjectStreamRequest,
  type SignedPartInstruction,
  type StoredObjectBody,
  type StoredObjectMetadata,
} from "./contract.js";

/**
 * In-memory stand-in used when PROVIDER_MODE is fake.
 *
 * It deliberately reproduces the behaviours the product depends on rather than
 * being permissive: parts are rejected unless their upload exists, completion
 * requires every claimed part to have been written, and byte counts come from
 * the bytes actually stored. A fake that accepted anything would let real
 * defects reach a live provider unnoticed.
 */

type FakePart = Readonly<{ body: Uint8Array; etag: string }>;

type FakeUpload = {
  readonly contentType: string;
  readonly initiatedAt: Date;
  readonly objectKey: string;
  readonly parts: Map<number, FakePart>;
};

type FakeObject = Readonly<{
  body: Uint8Array;
  contentType: string;
  etag: string;
  objectVersion: string;
}>;

export type FakeObjectStorageDependencies = Readonly<{
  partUploadBaseUrl?: string | undefined;
  signedUrlTtlSeconds?: number | undefined;
  now?: (() => Date) | undefined;
}>;

export type FakeObjectStorage = Readonly<{
  adapter: ObjectStorageAdapter;
  /** Stores part bytes as a provider would when the browser PUTs a part. */
  putPart(providerUploadId: string, partNumber: number, body: Uint8Array): string;
  /** Stores a whole object directly, for seeding media fixtures in tests. */
  putObject(objectKey: string, body: Uint8Array, contentType: string): void;
  /** Reads a stored object back, for assertions. */
  readObject(objectKey: string): Uint8Array | null;
  /** Backdates an upload so abandonment sweeps can be exercised. */
  setInitiatedAt(providerUploadId: string, initiatedAt: Date): void;
  uploadCount(): number;
}>;

/** Small enough that even a modest fixture is delivered in several reads. */
const fakeReadChunkBytes = 64 * 1024;

function digest(body: Uint8Array): string {
  return createHash("sha256").update(body).digest("hex").slice(0, 32);
}

export function createFakeObjectStorage(
  dependencies: FakeObjectStorageDependencies = {},
): FakeObjectStorage {
  const now = dependencies.now ?? (() => new Date());
  const ttlSeconds = dependencies.signedUrlTtlSeconds ?? 900;
  const baseUrl = dependencies.partUploadBaseUrl ?? "https://fake-storage.invalid/parts";
  const uploads = new Map<string, FakeUpload>();
  const objects = new Map<string, FakeObject>();

  function requireUpload(providerUploadId: string, operation: string): FakeUpload {
    const upload = uploads.get(providerUploadId);

    if (upload === undefined) {
      throw new ObjectStorageError(operation);
    }

    return upload;
  }

  const adapter: ObjectStorageAdapter = Object.freeze({
    abortMultipartUpload(handle: MultipartUploadHandle): Promise<void> {
      // Aborting an unknown upload is the desired end state, so it succeeds.
      uploads.delete(handle.providerUploadId);

      return Promise.resolve();
    },

    // These are async so a rejected precondition surfaces as a rejected promise
    // rather than a synchronous throw, matching how a real provider fails.
    async completeMultipartUpload(
      handle: MultipartUploadHandle,
      parts: readonly CompletedPart[],
    ): Promise<StoredObjectMetadata> {
      const upload = requireUpload(handle.providerUploadId, "completeMultipartUpload");

      if (parts.length === 0) {
        throw new ObjectStorageError("completeMultipartUpload");
      }

      const ordered = [...parts].sort((left, right) => left.partNumber - right.partNumber);
      const bodies: Uint8Array[] = [];

      for (const claimed of ordered) {
        const stored = upload.parts.get(claimed.partNumber);

        // A part the client claims but never uploaded, or whose ETag does not
        // match what was stored, must not produce a completed object.
        if (stored === undefined || stored.etag !== claimed.etag) {
          throw new ObjectStorageError("completeMultipartUpload");
        }

        bodies.push(stored.body);
      }

      const total = bodies.reduce((sum, part) => sum + part.byteLength, 0);
      const body = new Uint8Array(total);
      let offset = 0;

      for (const part of bodies) {
        body.set(part, offset);
        offset += part.byteLength;
      }

      const object: FakeObject = Object.freeze({
        body,
        contentType: upload.contentType,
        // Mirror S3's composite multipart ETag shape so callers cannot mistake
        // it for a whole-object cryptographic checksum.
        etag: `${digest(body)}-${ordered.length}`,
        objectVersion: randomUUID(),
      });

      objects.set(upload.objectKey, object);
      uploads.delete(handle.providerUploadId);

      return Object.freeze({
        bytes: body.byteLength,
        contentType: object.contentType,
        etag: object.etag,
        objectVersion: object.objectVersion,
      });
    },

    createMultipartUpload(request: CreateMultipartUploadRequest): Promise<MultipartUploadHandle> {
      const providerUploadId = randomUUID();

      uploads.set(providerUploadId, {
        contentType: request.contentType,
        initiatedAt: now(),
        objectKey: request.objectKey,
        parts: new Map(),
      });

      return Promise.resolve(Object.freeze({ objectKey: request.objectKey, providerUploadId }));
    },

    deleteObject(objectKey: string): Promise<void> {
      // Deleting an object that is already gone is the desired end state.
      objects.delete(objectKey);

      return Promise.resolve();
    },

    getObject(objectKey: string): Promise<StoredObjectBody | null> {
      const object = objects.get(objectKey);

      if (object === undefined) {
        return Promise.resolve(null);
      }

      const { body } = object;
      let sent = 0;

      return Promise.resolve(
        Object.freeze({
          // Deliver in several chunks even though the bytes are already in
          // memory. A caller that only works when the whole object arrives in
          // one read would pass here and fail against a real provider.
          body: new ReadableStream<Uint8Array>({
            pull(controller) {
              const offset = Math.min(sent, body.byteLength);

              if (offset >= body.byteLength) {
                controller.close();
                return;
              }

              const end = Math.min(offset + fakeReadChunkBytes, body.byteLength);

              controller.enqueue(body.subarray(offset, end));
              sent = end;
            },
          }),
          metadata: Object.freeze({
            bytes: body.byteLength,
            contentType: object.contentType,
            etag: object.etag,
            objectVersion: object.objectVersion,
          }),
        }),
      );
    },

    headObject(objectKey: string): Promise<StoredObjectMetadata | null> {
      const object = objects.get(objectKey);

      if (object === undefined) {
        return Promise.resolve(null);
      }

      return Promise.resolve(
        Object.freeze({
          bytes: object.body.byteLength,
          contentType: object.contentType,
          etag: object.etag,
          objectVersion: object.objectVersion,
        }),
      );
    },

    listAbandonedUploads(
      request: ListAbandonedUploadsRequest,
    ): Promise<readonly AbandonedUpload[]> {
      const abandoned: AbandonedUpload[] = [];

      for (const [providerUploadId, upload] of uploads) {
        if (upload.initiatedAt.getTime() >= request.initiatedBefore.getTime()) {
          continue;
        }

        abandoned.push(
          Object.freeze({
            initiatedAt: upload.initiatedAt,
            objectKey: upload.objectKey,
            providerUploadId,
          }),
        );

        if (abandoned.length >= request.limit) {
          break;
        }
      }

      return Promise.resolve(Object.freeze(abandoned));
    },

    /**
     * Drains the stream chunk by chunk and stores what it actually read.
     *
     * Strict on the two things the real adapter is strict about, because a
     * permissive fake here would let both defects reach a live provider: a
     * stream that fails part-way must leave nothing addressable at the key, and
     * a zero-byte body is a fault rather than an empty object.
     */
    async putObjectStream(request: PutObjectStreamRequest): Promise<StoredObjectMetadata> {
      const reader = request.body.getReader();
      const chunks: Uint8Array[] = [];
      let bytes = 0;

      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;

          chunks.push(value);
          bytes += value.byteLength;
        }
      } catch (error) {
        // Nothing is written on the failure path, so a caller that retries
        // finds the key clear exactly as it would against S3.
        throw new ObjectStorageError("putObjectStream", error);
      } finally {
        reader.cancel().catch(() => undefined);
      }

      if (bytes === 0) {
        throw new ObjectStorageError("putObjectStream");
      }

      const body = new Uint8Array(bytes);
      let offset = 0;
      for (const chunk of chunks) {
        body.set(chunk, offset);
        offset += chunk.byteLength;
      }

      const stored = Object.freeze({
        body,
        contentType: request.contentType,
        // A single-part shape, deliberately distinguishable from the
        // `-<partCount>` composite a completed multipart upload produces.
        etag: digest(body),
        objectVersion: randomUUID(),
      });
      objects.set(request.objectKey, stored);

      return Object.freeze({
        bytes,
        contentType: stored.contentType,
        etag: stored.etag,
        objectVersion: stored.objectVersion,
      });
    },

    async signPartUpload(
      handle: MultipartUploadHandle,
      partNumber: number,
    ): Promise<SignedPartInstruction> {
      requireUpload(handle.providerUploadId, "signPartUpload");

      const url = new URL(baseUrl);
      url.searchParams.set("uploadId", handle.providerUploadId);
      url.searchParams.set("partNumber", String(partNumber));

      return Object.freeze({
        expiresAt: new Date(now().getTime() + ttlSeconds * 1000),
        partNumber,
        url: url.toString(),
      });
    },
  });

  return Object.freeze({
    adapter,

    putPart(providerUploadId: string, partNumber: number, body: Uint8Array): string {
      const upload = requireUpload(providerUploadId, "putPart");
      const etag = digest(body);

      upload.parts.set(partNumber, Object.freeze({ body, etag }));

      return etag;
    },

    putObject(objectKey: string, body: Uint8Array, contentType: string): void {
      objects.set(
        objectKey,
        Object.freeze({ body, contentType, etag: digest(body), objectVersion: randomUUID() }),
      );
    },

    readObject(objectKey: string): Uint8Array | null {
      return objects.get(objectKey)?.body ?? null;
    },

    setInitiatedAt(providerUploadId: string, initiatedAt: Date): void {
      const upload = requireUpload(providerUploadId, "setInitiatedAt");

      uploads.set(providerUploadId, { ...upload, initiatedAt });
    },

    uploadCount(): number {
      return uploads.size;
    },
  });
}
