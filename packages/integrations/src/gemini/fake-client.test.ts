import { describe, expect, it } from "vitest";

import { GeminiError } from "./contract.js";
import { createFakeGemini } from "./fake-client.js";

/**
 * The fake's obligations.
 *
 * These exist because a permissive fake is worse than no fake: it would let a
 * handler that never polls, or that reuses a released file, pass every test and
 * then fail against a paid provider.
 */

function bytes(): Uint8Array {
  return new Uint8Array([1, 2, 3, 4]);
}

async function uploadOne(fake: ReturnType<typeof createFakeGemini>) {
  return fake.adapter.uploadVideo({ body: bytes(), displayName: "probe", mimeType: "video/mp4" });
}

describe("createFakeGemini", () => {
  it("starts a file processing so a handler that skips the poll fails here, not in staging", async () => {
    const fake = createFakeGemini();
    const file = await uploadOne(fake);

    expect(file.state).toBe("PROCESSING");
    await expect(fake.adapter.waitForActiveFile(file.name)).rejects.toMatchObject({
      responseClass: "timeout",
    });
  });

  it("refuses generation against a file the provider is still processing", async () => {
    const fake = createFakeGemini();
    const file = await uploadOne(fake);

    await expect(
      fake.adapter.generateStructuredText({
        fileUri: file.uri,
        instruction: "x",
        mimeType: "video/mp4",
      }),
    ).rejects.toBeInstanceOf(GeminiError);
  });

  it("generates once the file is active", async () => {
    const fake = createFakeGemini();
    const file = await uploadOne(fake);
    fake.setFileState(file.name, "ACTIVE");
    fake.setResponse({ text: '{"analysed":true}' });

    await expect(fake.adapter.waitForActiveFile(file.name)).resolves.toMatchObject({
      state: "ACTIVE",
    });
    const result = await fake.adapter.generateStructuredText({
      fileUri: file.uri,
      instruction: "describe the shape",
      mimeType: "video/mp4",
    });

    expect(result.text).toBe('{"analysed":true}');
    expect(fake.instructions()).toEqual(["describe the shape"]);
  });

  it("reports a failed file as failed rather than slow", async () => {
    const fake = createFakeGemini();
    const file = await uploadOne(fake);
    fake.setFileState(file.name, "FAILED");

    await expect(fake.adapter.waitForActiveFile(file.name)).rejects.toMatchObject({
      responseClass: "file_failed",
    });
  });

  it("releases a file and refuses to use it again", async () => {
    const fake = createFakeGemini();
    const file = await uploadOne(fake);
    fake.setFileState(file.name, "ACTIVE");

    await fake.adapter.deleteFile(file.name);

    expect(fake.fileCount()).toBe(0);
    expect(fake.deletedFiles()).toEqual([file.name]);
    await expect(fake.adapter.describeFile(file.name)).resolves.toBeNull();
    await expect(
      fake.adapter.generateStructuredText({
        fileUri: file.uri,
        instruction: "x",
        mimeType: "video/mp4",
      }),
    ).rejects.toBeInstanceOf(GeminiError);
  });

  it("treats deleting an absent file as the end state the caller wanted", async () => {
    const fake = createFakeGemini();

    await expect(fake.adapter.deleteFile("files/missing")).resolves.toBeUndefined();
  });

  it("injects one failure so a handler's error path can be exercised", async () => {
    const fake = createFakeGemini();
    fake.failNext({
      error: new GeminiError({ operation: "uploadVideo", responseClass: "rate_limit" }),
      operation: "uploadVideo",
    });

    await expect(uploadOne(fake)).rejects.toMatchObject({ responseClass: "rate_limit" });
    // The next call succeeds: the injection is one-shot, so a retry test can
    // prove recovery rather than only failure.
    await expect(uploadOne(fake)).resolves.toMatchObject({ state: "PROCESSING" });
  });

  it("gives every upload a distinct provider name", async () => {
    const fake = createFakeGemini();
    const first = await uploadOne(fake);
    const second = await uploadOne(fake);

    expect(first.name).not.toBe(second.name);
    expect(fake.fileCount()).toBe(2);
  });
});
