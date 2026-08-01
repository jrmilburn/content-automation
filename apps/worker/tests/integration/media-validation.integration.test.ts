import { readFile } from "node:fs/promises";

import { loadMediaValidationConfig } from "@studio-parallel/config";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createFfprobeMediaProbe } from "../../src/uploads/media-probe.js";
import { stageObjectForProbe } from "../../src/uploads/object-staging.js";
import { evaluateProbedMedia, type RejectionCode } from "../../src/uploads/validation-policy.js";
import { createMediaFixtures, type MediaFixtures } from "./media-fixtures.js";

/**
 * The validation policy against a real ffprobe and real media.
 *
 * Unit tests feed the policy hand-written probe output, which proves the rules
 * but not the reading. This suite is the only place that proves the deployed
 * probe describes real files the way the policy expects — in particular that
 * ffprobe reports a comma-separated demuxer list rather than one container
 * name, which a fixture author would never think to fake.
 */

const config = loadMediaValidationConfig({});
const probe = createFfprobeMediaProbe();
const limits = {
  maxOutputBytes: config.MEDIA_PROBE_MAX_OUTPUT_BYTES,
  timeoutMs: config.MEDIA_PROBE_TIMEOUT_MS,
} as const;

let fixtures: MediaFixtures;

beforeAll(async () => {
  fixtures = await createMediaFixtures();
}, 120_000);

afterAll(async () => {
  await fixtures?.dispose();
});

/** Runs the whole path a validation attempt takes, minus the database. */
async function validate(
  name: string,
  declaredContentType: string,
): Promise<Readonly<{ code?: RejectionCode; accepted: boolean; detail?: string }>> {
  const bytes = await readFile(fixtures.path(name));
  const handle = await stageObjectForProbe(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(bytes));
        controller.close();
      },
    }),
    1_073_741_824,
  );

  try {
    const { staged } = handle;

    if (staged.bytes === 0) {
      return { accepted: false, code: "EMPTY_OBJECT" };
    }

    const probed = await probe.probe(staged.filePath, limits);

    if (!probed.ok) {
      return {
        accepted: false,
        ...(probed.reason === "TIMED_OUT" ? {} : { code: probed.reason }),
        detail: probed.reason,
      };
    }

    const verdict = evaluateProbedMedia(
      {
        declaredContentType,
        headerFamily: staged.family,
        media: probed.media,
      },
      config,
    );

    return verdict.accepted
      ? {
          accepted: true,
          detail: `${verdict.media.videoCodec} ${verdict.media.widthPx}x${verdict.media.heightPx}`,
        }
      : { accepted: false, code: verdict.code };
  } finally {
    await handle.dispose();
  }
}

describe("ffprobe describes real media the way the policy expects", () => {
  it("reports a demuxer list rather than a single container name", async () => {
    const bytes = await readFile(fixtures.path("supported.mp4"));
    const handle = await stageObjectForProbe(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(bytes));
          controller.close();
        },
      }),
      1_073_741_824,
    );

    try {
      const probed = await probe.probe(handle.staged.filePath, limits);

      expect(probed.ok).toBe(true);

      // This is the assumption the whole container check rests on. A policy
      // comparing the raw string to "mp4" would reject every real upload.
      expect(probed.ok && probed.media.containerFormats).toContain("mp4");
      expect(probed.ok && probed.media.containerFormats.length).toBeGreaterThan(1);
    } finally {
      await handle.dispose();
    }
  });
});

describe("supported media", () => {
  it("accepts an H.264 MP4 and reports its detected shape", async () => {
    const result = await validate("supported.mp4", "video/mp4");

    expect(result).toMatchObject({ accepted: true });
    expect(result.detail).toBe("h264 320x568");
  });

  it("accepts a VP9 WebM", async () => {
    await expect(validate("supported.webm", "video/webm")).resolves.toMatchObject({
      accepted: true,
    });
  });
});

describe("refused media", () => {
  it("rejects a zero-byte object", async () => {
    await expect(validate("empty.mp4", "video/mp4")).resolves.toMatchObject({
      accepted: false,
      code: "EMPTY_OBJECT",
    });
  });

  it("rejects a file with no video stream distinctly from one that will not parse", async () => {
    const audioOnly = await validate("audio-only.m4a", "video/mp4");
    const rubbish = await validate("not-media.mp4", "video/mp4");

    expect(audioOnly.code).toBe("NO_VIDEO_STREAM");
    expect(rubbish.code).toBe("UNDECODABLE");
  });

  it("rejects a truncated file", async () => {
    const result = await validate("truncated.mp4", "video/mp4");

    expect(result.accepted).toBe(false);
    // Either the demuxer refuses it outright or it decodes to something the
    // policy will not take; both are correct, and neither may be an accept.
    expect(result.code).toBeDefined();
  });

  it("rejects a polyglot whose header is not an accepted container", async () => {
    await expect(validate("polyglot.mp4", "video/mp4")).resolves.toMatchObject({
      accepted: false,
    });
  });

  it("rejects a video codec outside the configured set", async () => {
    await expect(validate("unsupported-codec.mp4", "video/mp4")).resolves.toMatchObject({
      accepted: false,
      code: "VIDEO_CODEC_UNSUPPORTED",
    });
  });

  it("rejects dimensions below the configured floor", async () => {
    await expect(validate("tiny.mp4", "video/mp4")).resolves.toMatchObject({
      accepted: false,
      code: "DIMENSIONS_OUT_OF_RANGE",
    });
  });

  it("rejects a WebM presented as MP4", async () => {
    // The extension and declared type say one family, the bytes say another.
    await expect(validate("supported.webm", "video/mp4")).resolves.toMatchObject({
      accepted: false,
      code: "CONTAINER_MISMATCH",
    });
  });

  it("rejects an MP4 presented as WebM", async () => {
    await expect(validate("supported.mp4", "video/webm")).resolves.toMatchObject({
      accepted: false,
      code: "CONTAINER_MISMATCH",
    });
  });
});

describe("probe isolation", () => {
  it("does not follow a remote reference embedded in a container", async () => {
    // An ffconcat script naming an HTTP source is the documented way to make a
    // probe fetch a URL. With the protocol whitelist in place it must refuse
    // rather than reach the network, so this asserts the SSRF guard directly.
    const script = Buffer.from(
      "ffconcat version 1.0\nfile http://169.254.169.254/latest/meta-data/\n",
    );
    const handle = await stageObjectForProbe(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(script));
          controller.close();
        },
      }),
      1_073_741_824,
    );

    try {
      const probed = await probe.probe(handle.staged.filePath, limits);

      expect(probed.ok).toBe(false);
    } finally {
      await handle.dispose();
    }
  });

  it("computes the same digest the object had on disk", async () => {
    const bytes = await readFile(fixtures.path("supported.mp4"));
    const { createHash } = await import("node:crypto");
    const expected = createHash("sha256").update(bytes).digest("hex");

    const handle = await stageObjectForProbe(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(bytes));
          controller.close();
        },
      }),
      1_073_741_824,
    );

    try {
      expect(handle.staged.sha256).toBe(expected);
    } finally {
      await handle.dispose();
    }
  });
});
