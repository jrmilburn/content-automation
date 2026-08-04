import { describe, expect, it } from "vitest";

import { createFakeObjectStorage } from "./fake-adapter.js";

/**
 * The server-side write, exercised against the fake.
 *
 * The fake is held to the same refusals as the real adapter deliberately: a
 * permissive fake here would let both of these defects reach a live provider,
 * and this repository has already been bitten twice by tests that agreed with a
 * bug on a path that had never run for real.
 */

function streamOf(...chunks: readonly Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

function failingStream(before: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(before);
      controller.error(new Error("source failed"));
    },
  });
}

const objectKey = "test/019a0000-0000-7000-8000-0000000000ff/source-video/" + "a".repeat(32);

describe("writing an object from a stream", () => {
  it("stores every byte it read and reports server-observed metadata", async () => {
    const storage = createFakeObjectStorage();

    const stored = await storage.adapter.putObjectStream({
      body: streamOf(new Uint8Array(6), new Uint8Array(4)),
      contentType: "video/mp4",
      objectKey,
    });

    expect(stored.bytes).toBe(10);
    expect(stored.contentType).toBe("video/mp4");
    expect(storage.readObject(objectKey)?.byteLength).toBe(10);

    // A single-part shape, distinguishable from the `-<partCount>` composite a
    // completed multipart upload produces.
    expect(stored.etag).not.toContain("-");
  });

  it("leaves nothing addressable when the source fails part-way", async () => {
    const storage = createFakeObjectStorage();

    await expect(
      storage.adapter.putObjectStream({
        body: failingStream(new Uint8Array(4)),
        contentType: "video/mp4",
        objectKey,
      }),
    ).rejects.toThrow();

    // The caller retries. A half-written object a later read could find would
    // be worse than no object at all.
    expect(storage.readObject(objectKey)).toBeNull();
    await expect(storage.adapter.headObject(objectKey)).resolves.toBeNull();
  });

  it("refuses a body that turned out to be empty", async () => {
    const storage = createFakeObjectStorage();

    await expect(
      storage.adapter.putObjectStream({
        body: streamOf(),
        contentType: "video/mp4",
        objectKey,
      }),
    ).rejects.toThrow();

    expect(storage.readObject(objectKey)).toBeNull();
  });

  it("overwrites its own earlier attempt rather than accumulating objects", async () => {
    const storage = createFakeObjectStorage();

    await storage.adapter.putObjectStream({
      body: streamOf(new Uint8Array(4)),
      contentType: "video/mp4",
      objectKey,
    });
    const second = await storage.adapter.putObjectStream({
      body: streamOf(new Uint8Array(9)),
      contentType: "video/mp4",
      objectKey,
    });

    // A retry writes to the key its job derives, so the bucket does not collect
    // orphans that no row points at and no purge sweep can find.
    expect(second.bytes).toBe(9);
    expect(storage.readObject(objectKey)?.byteLength).toBe(9);
  });
});
