import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname } from "node:path";

import { describe, expect, it } from "vitest";

import {
  detectContainerFamily,
  stageObjectForProbe,
  StagedObjectTooLargeError,
} from "./object-staging.js";

function isoBmffHeader(): Uint8Array {
  // 4-byte box size, then the "ftyp" brand at offset 4.
  return new Uint8Array([0, 0, 0, 0x20, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d]);
}

function matroskaHeader(): Uint8Array {
  return new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x01, 0x02, 0x03, 0x04]);
}

function streamOf(...chunks: readonly Uint8Array[]): ReadableStream<Uint8Array> {
  let index = 0;

  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index >= chunks.length) {
        controller.close();
        return;
      }

      controller.enqueue(chunks[index]!);
      index += 1;
    },
  });
}

async function stagedDirectoryCount(): Promise<number> {
  const entries = await readdir(tmpdir());

  return entries.filter((entry) => entry.startsWith("sp-asset-")).length;
}

describe("detectContainerFamily", () => {
  it("identifies the ISO base media file format by its ftyp brand", () => {
    expect(detectContainerFamily(isoBmffHeader())).toBe("ISO_BMFF");
  });

  it("identifies Matroska and WebM by their EBML magic", () => {
    expect(detectContainerFamily(matroskaHeader())).toBe("MATROSKA");
  });

  it("refuses bytes matching no accepted container", () => {
    // A ZIP header is the shape a polyglot commonly hides behind.
    expect(detectContainerFamily(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]))).toBeNull();
    expect(detectContainerFamily(new Uint8Array([]))).toBeNull();
  });

  it("refuses a header too short to classify rather than reading past it", () => {
    expect(detectContainerFamily(new Uint8Array([0x1a, 0x45]))).toBeNull();
  });
});

describe("stageObjectForProbe", () => {
  it("writes the whole object and reports its byte count and digest", async () => {
    const body = new Uint8Array([...isoBmffHeader(), ...new Uint8Array(2048).fill(7)]);
    const handle = await stageObjectForProbe(streamOf(body), 1_000_000);

    try {
      expect(handle.staged.bytes).toBe(body.byteLength);
      expect(handle.staged.sha256).toBe(createHash("sha256").update(body).digest("hex"));
      expect(new Uint8Array(await readFile(handle.staged.filePath))).toEqual(body);
    } finally {
      await handle.dispose();
    }
  });

  it("classifies the container from bytes split across several reads", async () => {
    // The header can straddle a chunk boundary; a reader that only inspected
    // the first chunk would classify this as unknown.
    const handle = await stageObjectForProbe(
      streamOf(
        new Uint8Array([0, 0]),
        new Uint8Array([0, 0x20, 0x66]),
        new Uint8Array([0x74, 0x79, 0x70, 0x69]),
      ),
      1_000_000,
    );

    try {
      expect(handle.staged.family).toBe("ISO_BMFF");
    } finally {
      await handle.dispose();
    }
  });

  it("stops at the ceiling instead of writing past it", async () => {
    // A provider that returns more bytes than the recorded size claimed must
    // not be able to fill the worker's disk.
    const oversized = streamOf(new Uint8Array(64).fill(1), new Uint8Array(64).fill(2));

    await expect(stageObjectForProbe(oversized, 100)).rejects.toBeInstanceOf(
      StagedObjectTooLargeError,
    );
  });

  it("leaves no staged directory behind when the ceiling is exceeded", async () => {
    // The failure path has no handle to dispose, so the only way to prove it
    // cleaned up is to watch the temporary directory itself. A leak here would
    // accumulate partial source videos on the worker for every rejected upload.
    const before = await stagedDirectoryCount();

    await expect(
      stageObjectForProbe(streamOf(new Uint8Array(64).fill(1), new Uint8Array(64).fill(2)), 100),
    ).rejects.toBeInstanceOf(StagedObjectTooLargeError);

    expect(await stagedDirectoryCount()).toBe(before);
  });

  it("reports a zero-byte object rather than failing to stage it", async () => {
    const handle = await stageObjectForProbe(streamOf(), 1_000);

    try {
      expect(handle.staged.bytes).toBe(0);
      expect(handle.staged.family).toBeNull();
    } finally {
      await handle.dispose();
    }
  });

  it("never names the staged file after anything the caller supplied", async () => {
    const handle = await stageObjectForProbe(streamOf(new Uint8Array(4)), 1_000);

    try {
      expect(handle.staged.filePath.endsWith("/source")).toBe(true);
    } finally {
      await handle.dispose();
    }
  });

  it("leaves nothing on disk after dispose", async () => {
    const handle = await stageObjectForProbe(streamOf(new Uint8Array(16)), 1_000);
    const directory = dirname(handle.staged.filePath);

    await handle.dispose();

    await expect(stat(directory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("is safe to dispose more than once", async () => {
    const handle = await stageObjectForProbe(streamOf(new Uint8Array(16)), 1_000);

    await handle.dispose();

    await expect(handle.dispose()).resolves.toBeUndefined();
  });
});
