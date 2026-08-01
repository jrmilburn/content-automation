import { createHash } from "node:crypto";
import { mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Streams one stored object onto local disk so the media probe can read it.
 *
 * The bytes go to a file rather than to the probe's stdin on purpose: an MP4
 * written by a phone or an editor commonly places its `moov` atom at the end of
 * the file, and a probe reading a non-seekable pipe cannot find it. Piping
 * would reject a large share of legitimate uploads.
 *
 * The staged copy is created inside a private directory the process owns, is
 * never named after anything the user supplied, and is removed by `dispose`
 * whether validation succeeded, rejected or threw.
 */

/** How the first bytes of the object identify its container family. */
export type ContainerFamily = "ISO_BMFF" | "MATROSKA";

export type StagedObject = Readonly<{
  bytes: number;
  /** Null when the header matches no container this product accepts. */
  family: ContainerFamily | null;
  filePath: string;
  sha256: string;
}>;

export type StagedObjectHandle = Readonly<{
  dispose(): Promise<void>;
  staged: StagedObject;
}>;

/** Raised when the object holds more bytes than policy allows. */
export class StagedObjectTooLargeError extends Error {
  constructor() {
    super("Stored object exceeds the configured byte ceiling");
    this.name = "StagedObjectTooLargeError";
  }
}

// Enough to cover the ISO base media file format box header, which puts the
// "ftyp" brand at offset 4.
const headerInspectionBytes = 16;

const matroskaMagic = Object.freeze([0x1a, 0x45, 0xdf, 0xa3]);
const isoBmffBrandOffset = 4;
const isoBmffBrand = "ftyp";

export function detectContainerFamily(header: Uint8Array): ContainerFamily | null {
  if (
    header.length >= matroskaMagic.length &&
    matroskaMagic.every((byte, index) => header[index] === byte)
  ) {
    return "MATROSKA";
  }

  if (header.length >= isoBmffBrandOffset + isoBmffBrand.length) {
    const brand = String.fromCharCode(
      ...header.subarray(isoBmffBrandOffset, isoBmffBrandOffset + isoBmffBrand.length),
    );

    if (brand === isoBmffBrand) {
      return "ISO_BMFF";
    }
  }

  return null;
}

export async function stageObjectForProbe(
  body: ReadableStream<Uint8Array>,
  maxBytes: number,
): Promise<StagedObjectHandle> {
  const directory = await mkdtemp(join(tmpdir(), "sp-asset-"));
  const filePath = join(directory, "source");
  // 0600 so nothing else on the host can read a customer's source video while
  // it is staged.
  const file = await open(filePath, "wx", 0o600);

  const dispose = async (): Promise<void> => {
    await rm(directory, { force: true, recursive: true });
  };

  const hash = createHash("sha256");
  const header = new Uint8Array(headerInspectionBytes);
  let headerFilled = 0;
  let bytes = 0;

  try {
    const reader = body.getReader();

    try {
      for (;;) {
        const { done, value } = await reader.read();

        if (done) {
          break;
        }

        bytes += value.byteLength;

        // Stop at the ceiling instead of after it: a caller must never be able
        // to fill the worker's disk by declaring one size and storing another.
        if (bytes > maxBytes) {
          throw new StagedObjectTooLargeError();
        }

        if (headerFilled < header.length) {
          const take = Math.min(header.length - headerFilled, value.byteLength);

          header.set(value.subarray(0, take), headerFilled);
          headerFilled += take;
        }

        hash.update(value);
        await file.write(value);
      }
    } finally {
      // Release the provider connection before the handle, so an abandoned
      // read does not hold a socket open for the rest of the attempt.
      await reader.cancel().catch(() => undefined);
      await file.close();
    }
  } catch (error) {
    // Only on the failure path: a successful stage hands ownership of the
    // directory to the caller, which disposes of it after probing.
    await dispose();
    throw error;
  }

  return Object.freeze({
    dispose,
    staged: Object.freeze({
      bytes,
      family: detectContainerFamily(header.subarray(0, headerFilled)),
      filePath,
      sha256: hash.digest("hex"),
    }),
  });
}
