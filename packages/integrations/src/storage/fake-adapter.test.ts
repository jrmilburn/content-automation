import { describe, expect, it } from "vitest";

import { ObjectStorageError } from "./contract.js";
import { createFakeObjectStorage } from "./fake-adapter.js";

const objectKey = "test/019a0000-0000-7000-8000-000000000001/source-video/".concat("a".repeat(32));

function bytes(value: number, length: number): Uint8Array {
  return new Uint8Array(length).fill(value);
}

async function uploadTwoParts(storage: ReturnType<typeof createFakeObjectStorage>) {
  const handle = await storage.adapter.createMultipartUpload({
    contentType: "video/mp4",
    objectKey,
  });
  const first = storage.putPart(handle.providerUploadId, 1, bytes(1, 8));
  const second = storage.putPart(handle.providerUploadId, 2, bytes(2, 4));

  return { first, handle, second };
}

describe("createFakeObjectStorage", () => {
  it("reports byte counts from stored bytes, not from what a caller claims", async () => {
    const storage = createFakeObjectStorage();
    const { first, handle, second } = await uploadTwoParts(storage);

    const stored = await storage.adapter.completeMultipartUpload(handle, [
      { etag: first, partNumber: 1 },
      { etag: second, partNumber: 2 },
    ]);

    expect(stored.bytes).toBe(12);
    expect(storage.readObject(objectKey)).toEqual(
      new Uint8Array([1, 1, 1, 1, 1, 1, 1, 1, 2, 2, 2, 2]),
    );
  });

  it("assembles parts in part-number order regardless of completion order", async () => {
    const storage = createFakeObjectStorage();
    const { first, handle, second } = await uploadTwoParts(storage);

    await storage.adapter.completeMultipartUpload(handle, [
      { etag: second, partNumber: 2 },
      { etag: first, partNumber: 1 },
    ]);

    expect(storage.readObject(objectKey)?.at(0)).toBe(1);
    expect(storage.readObject(objectKey)?.at(11)).toBe(2);
  });

  it("refuses to complete a part the client never uploaded", async () => {
    const storage = createFakeObjectStorage();
    const { first, handle } = await uploadTwoParts(storage);

    await expect(
      storage.adapter.completeMultipartUpload(handle, [
        { etag: first, partNumber: 1 },
        { etag: "invented-etag", partNumber: 7 },
      ]),
    ).rejects.toBeInstanceOf(ObjectStorageError);
    expect(storage.readObject(objectKey)).toBeNull();
  });

  it("refuses to complete when a claimed etag does not match the stored part", async () => {
    const storage = createFakeObjectStorage();
    const { handle, second } = await uploadTwoParts(storage);

    await expect(
      storage.adapter.completeMultipartUpload(handle, [
        { etag: "tampered", partNumber: 1 },
        { etag: second, partNumber: 2 },
      ]),
    ).rejects.toBeInstanceOf(ObjectStorageError);
  });

  it("returns a composite etag that cannot be mistaken for a whole-object digest", async () => {
    const storage = createFakeObjectStorage();
    const { first, handle, second } = await uploadTwoParts(storage);

    const stored = await storage.adapter.completeMultipartUpload(handle, [
      { etag: first, partNumber: 1 },
      { etag: second, partNumber: 2 },
    ]);

    expect(stored.etag).toMatch(/^[0-9a-f]{32}-2$/u);
  });

  it("signs a part URL scoped to the exact upload and part", async () => {
    const storage = createFakeObjectStorage({ partUploadBaseUrl: "https://parts.invalid/put" });
    const handle = await storage.adapter.createMultipartUpload({
      contentType: "video/mp4",
      objectKey,
    });

    const instruction = await storage.adapter.signPartUpload(handle, 3);
    const url = new URL(instruction.url);

    expect(url.searchParams.get("uploadId")).toBe(handle.providerUploadId);
    expect(url.searchParams.get("partNumber")).toBe("3");
    expect(instruction.partNumber).toBe(3);
  });

  it("refuses to sign a part for an upload that does not exist", async () => {
    const storage = createFakeObjectStorage();

    await expect(
      storage.adapter.signPartUpload({ objectKey, providerUploadId: "not-a-real-upload" }, 1),
    ).rejects.toBeInstanceOf(ObjectStorageError);
  });

  it("expires signed instructions using the configured ttl", async () => {
    const at = new Date("2026-08-01T00:00:00.000Z");
    const storage = createFakeObjectStorage({ now: () => at, signedUrlTtlSeconds: 900 });
    const handle = await storage.adapter.createMultipartUpload({
      contentType: "video/mp4",
      objectKey,
    });

    const instruction = await storage.adapter.signPartUpload(handle, 1);

    expect(instruction.expiresAt.toISOString()).toBe("2026-08-01T00:15:00.000Z");
  });

  it("lists only uploads initiated before the abandonment cutoff", async () => {
    const storage = createFakeObjectStorage();
    const fresh = await storage.adapter.createMultipartUpload({
      contentType: "video/mp4",
      objectKey: `${objectKey}-fresh`,
    });
    const stale = await storage.adapter.createMultipartUpload({
      contentType: "video/mp4",
      objectKey: `${objectKey}-stale`,
    });

    storage.setInitiatedAt(stale.providerUploadId, new Date("2026-07-01T00:00:00.000Z"));

    const abandoned = await storage.adapter.listAbandonedUploads({
      initiatedBefore: new Date("2026-07-02T00:00:00.000Z"),
      limit: 10,
    });

    expect(abandoned.map((upload) => upload.providerUploadId)).toEqual([stale.providerUploadId]);
    expect(abandoned.map((upload) => upload.providerUploadId)).not.toContain(
      fresh.providerUploadId,
    );
  });

  it("aborts idempotently so a repeated sweep is safe", async () => {
    const storage = createFakeObjectStorage();
    const handle = await storage.adapter.createMultipartUpload({
      contentType: "video/mp4",
      objectKey,
    });

    await storage.adapter.abortMultipartUpload(handle);
    await expect(storage.adapter.abortMultipartUpload(handle)).resolves.toBeUndefined();
    expect(storage.uploadCount()).toBe(0);
  });

  it("returns null rather than throwing for an object that was never stored", async () => {
    const storage = createFakeObjectStorage();

    await expect(storage.adapter.headObject(objectKey)).resolves.toBeNull();
  });
});
