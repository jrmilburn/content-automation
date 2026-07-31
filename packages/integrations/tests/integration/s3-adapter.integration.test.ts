import { CreateBucketCommand, S3Client } from "@aws-sdk/client-s3";
import { loadObjectStorageConfig, loadObjectStorageCredentials } from "@studio-parallel/config";
import { beforeAll, describe, expect, it } from "vitest";

import { ObjectStorageError } from "../../src/storage/contract.js";
import { createSourceVideoObjectKey } from "../../src/storage/object-key.js";
import { createS3ObjectStorageAdapter } from "../../src/storage/s3-adapter.js";

/**
 * The real adapter against a real S3 implementation.
 *
 * Everything the unit suite proves is proved against a fake that was written to
 * agree with the adapter. This file is the only place the signing format,
 * multipart assembly, ETag shape, abort semantics and byte accounting are
 * checked against a server that will disagree.
 */

const config = loadObjectStorageConfig();
const credentials = loadObjectStorageCredentials();
const adapter = createS3ObjectStorageAdapter({ config, credentials });

// Every part except the last must be at least 5 MiB, so the smallest honest
// two-part upload is 5 MiB plus a tail.
const minimumPartBytes = 5 * 1024 * 1024;

function keyFor(): string {
  return createSourceVideoObjectKey({ environment: "test", workspaceId: "integration" });
}

function body(fill: number, length: number): Uint8Array {
  return new Uint8Array(length).fill(fill);
}

async function putPart(url: string, payload: Uint8Array): Promise<string> {
  const response = await fetch(url, { body: payload, method: "PUT" });

  if (!response.ok) {
    throw new Error(`part upload failed with ${response.status}`);
  }

  return (response.headers.get("ETag") ?? "").replaceAll('"', "");
}

beforeAll(async () => {
  const client = new S3Client({
    credentials: {
      accessKeyId: credentials.STORAGE_ACCESS_KEY_ID,
      secretAccessKey: credentials.STORAGE_SECRET_ACCESS_KEY,
    },
    forcePathStyle: true,
    region: config.STORAGE_REGION,
    ...(config.STORAGE_ENDPOINT === undefined ? {} : { endpoint: config.STORAGE_ENDPOINT }),
  });

  await client.send(new CreateBucketCommand({ Bucket: config.STORAGE_BUCKET })).catch(() => {
    // Already created by a previous file in the suite.
  });
});

describe("multipart upload against a real S3 implementation", () => {
  it("stores a two-part object and reports the bytes the server actually holds", async () => {
    const objectKey = keyFor();
    const handle = await adapter.createMultipartUpload({
      contentType: "video/mp4",
      objectKey,
    });

    const first = await adapter.signPartUpload(handle, 1);
    const second = await adapter.signPartUpload(handle, 2);
    const firstEtag = await putPart(first.url, body(1, minimumPartBytes));
    const secondEtag = await putPart(second.url, body(2, 1024));

    const stored = await adapter.completeMultipartUpload(handle, [
      { etag: firstEtag, partNumber: 1 },
      { etag: secondEtag, partNumber: 2 },
    ]);

    expect(stored.bytes).toBe(minimumPartBytes + 1024);
    expect(stored.contentType).toBe("video/mp4");
  });

  it("returns a composite etag that is not a whole-object digest", async () => {
    const objectKey = keyFor();
    const handle = await adapter.createMultipartUpload({ contentType: "video/mp4", objectKey });
    const first = await adapter.signPartUpload(handle, 1);
    const second = await adapter.signPartUpload(handle, 2);
    const firstEtag = await putPart(first.url, body(3, minimumPartBytes));
    const secondEtag = await putPart(second.url, body(4, 512));

    const stored = await adapter.completeMultipartUpload(handle, [
      { etag: firstEtag, partNumber: 1 },
      { etag: secondEtag, partNumber: 2 },
    ]);

    // S3 marks a multipart ETag with a "-<partCount>" suffix. This is exactly
    // why video-ingestion.md refuses to treat it as a cryptographic checksum.
    expect(stored.etag).toMatch(/-2$/u);
  });

  it("assembles parts in part-number order regardless of the order given", async () => {
    const objectKey = keyFor();
    const handle = await adapter.createMultipartUpload({ contentType: "video/mp4", objectKey });
    const first = await adapter.signPartUpload(handle, 1);
    const second = await adapter.signPartUpload(handle, 2);
    const firstEtag = await putPart(first.url, body(7, minimumPartBytes));
    const secondEtag = await putPart(second.url, body(9, 16));

    await adapter.completeMultipartUpload(handle, [
      { etag: secondEtag, partNumber: 2 },
      { etag: firstEtag, partNumber: 1 },
    ]);

    const head = await adapter.headObject(objectKey);

    expect(head?.bytes).toBe(minimumPartBytes + 16);
  });

  it("signs a url scoped to one method, key and part", async () => {
    const objectKey = keyFor();
    const handle = await adapter.createMultipartUpload({ contentType: "video/mp4", objectKey });
    const signed = await adapter.signPartUpload(handle, 1);

    // The signature covers PUT. A GET against the same URL must not be honoured.
    const wrongMethod = await fetch(signed.url, { method: "GET" });
    expect(wrongMethod.ok).toBe(false);

    // Nor may the signature be replayed against a different object.
    const tampered = signed.url.replace(objectKey, keyFor());
    const wrongKey = await fetch(tampered, { body: body(1, 16), method: "PUT" });
    expect(wrongKey.ok).toBe(false);

    await adapter.abortMultipartUpload(handle);
  });

  it("refuses a completion naming a part the server never stored", async () => {
    const objectKey = keyFor();
    const handle = await adapter.createMultipartUpload({ contentType: "video/mp4", objectKey });
    const signed = await adapter.signPartUpload(handle, 1);
    const etag = await putPart(signed.url, body(1, minimumPartBytes));

    await expect(
      adapter.completeMultipartUpload(handle, [
        { etag, partNumber: 1 },
        { etag: "d41d8cd98f00b204e9800998ecf8427e", partNumber: 2 },
      ]),
    ).rejects.toBeInstanceOf(ObjectStorageError);

    expect(await adapter.headObject(objectKey)).toBeNull();
  });
});

describe("abandoned upload lifecycle", () => {
  it("lists an in-flight upload as abandoned once it predates the cutoff", async () => {
    const objectKey = keyFor();
    const handle = await adapter.createMultipartUpload({ contentType: "video/mp4", objectKey });

    const abandoned = await adapter.listAbandonedUploads({
      // Everything initiated before now, which includes the upload just made.
      initiatedBefore: new Date(Date.now() + 60_000),
      limit: 50,
    });

    expect(abandoned.some((upload) => upload.providerUploadId === handle.providerUploadId)).toBe(
      true,
    );

    await adapter.abortMultipartUpload(handle);
  });

  it("excludes uploads newer than the cutoff", async () => {
    const handle = await adapter.createMultipartUpload({
      contentType: "video/mp4",
      objectKey: keyFor(),
    });

    const abandoned = await adapter.listAbandonedUploads({
      initiatedBefore: new Date(Date.now() - 60_000),
      limit: 50,
    });

    expect(abandoned.some((upload) => upload.providerUploadId === handle.providerUploadId)).toBe(
      false,
    );

    await adapter.abortMultipartUpload(handle);
  });

  it("aborts idempotently so a repeated sweep is safe", async () => {
    const objectKey = keyFor();
    const handle = await adapter.createMultipartUpload({ contentType: "video/mp4", objectKey });
    const signed = await adapter.signPartUpload(handle, 1);
    await putPart(signed.url, body(1, minimumPartBytes));

    await adapter.abortMultipartUpload(handle);
    await expect(adapter.abortMultipartUpload(handle)).resolves.toBeUndefined();

    // The parts are released and no object was ever published.
    expect(await adapter.headObject(objectKey)).toBeNull();
  });

  it("cannot complete an upload that was aborted", async () => {
    const objectKey = keyFor();
    const handle = await adapter.createMultipartUpload({ contentType: "video/mp4", objectKey });
    const signed = await adapter.signPartUpload(handle, 1);
    const etag = await putPart(signed.url, body(1, minimumPartBytes));

    await adapter.abortMultipartUpload(handle);

    await expect(
      adapter.completeMultipartUpload(handle, [{ etag, partNumber: 1 }]),
    ).rejects.toBeInstanceOf(ObjectStorageError);
  });
});

describe("object reads", () => {
  it("returns null for an object that does not exist rather than throwing", async () => {
    await expect(adapter.headObject(keyFor())).resolves.toBeNull();
  });
});
